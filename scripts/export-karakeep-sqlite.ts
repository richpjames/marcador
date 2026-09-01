#!/usr/bin/env bun
/**
 * Reads a Karakeep SQLite database directly and writes the JSON shape its REST
 * API returns, so `import-karakeep.ts --file` can consume it unchanged.
 *
 * This exists because the API needs a key from a UI you may not be able to
 * reach, while the database is right there in the container's volume:
 *
 *   docker cp <karakeep-web>:/data/db.db ./karakeep.db
 *   bun scripts/export-karakeep-sqlite.ts --db ./karakeep.db --out export.json
 *
 * It opens the database read-only and never writes to Karakeep.
 *
 * Options:
 *   --db <path>    Karakeep's db.db (default: ./karakeep.db)
 *   --out <path>   Where to write the export (default: ./karakeep-export.json)
 */

import { Database } from "bun:sqlite";
import type { KarakeepBookmark } from "../src/karakeep.ts";

const args = parseArgs(Bun.argv.slice(2));
const dbPath = args.db ?? "./karakeep.db";
const outPath = args.out ?? "./karakeep-export.json";

const db = new Database(dbPath, { readonly: true });

interface Row {
  id: string;
  createdAt: number;
  title: string | null;
  summary: string | null;
  note: string | null;
  archived: number;
  favourited: number;
  type: string;
  url: string | null;
  linkTitle: string | null;
  description: string | null;
  imageUrl: string | null;
  publisher: string | null;
  author: string | null;
}

// A left join, not an inner one: Karakeep also stores uploaded files and plain
// text notes, which have no row in bookmarkLinks. They still belong in the
// export so the importer can report what it skipped rather than silently
// disagreeing with Karakeep about how many bookmarks there were.
const rows = db
  .query<Row, []>(
    `select b.id, b.createdAt, b.title, b.summary, b.note, b.archived, b.favourited, b.type,
            l.url, l.title as linkTitle, l.description, l.imageUrl, l.publisher, l.author
       from bookmarks b
       left join bookmarkLinks l on l.id = b.id
      order by b.createdAt asc`,
  )
  .all();

const listRows = db
  .query<{ bookmarkId: string; name: string; icon: string | null }, []>(
    `select b.bookmarkId, l.name, l.icon
       from bookmarksInLists b
       join bookmarkLists l on l.id = b.listId`,
  )
  .all();

const listsByBookmark = new Map<string, { name: string; icon: string | null }[]>();
for (const { bookmarkId, name, icon } of listRows) {
  const entry = listsByBookmark.get(bookmarkId) ?? [];
  entry.push({ name, icon });
  listsByBookmark.set(bookmarkId, entry);
}

const tagRows = db
  .query<{ bookmarkId: string; name: string }, []>(
    `select t.bookmarkId, g.name
       from tagsOnBookmarks t
       join bookmarkTags g on g.id = t.tagId`,
  )
  .all();

const tagsByBookmark = new Map<string, { name: string }[]>();
for (const { bookmarkId, name } of tagRows) {
  const list = tagsByBookmark.get(bookmarkId) ?? [];
  list.push({ name });
  tagsByBookmark.set(bookmarkId, list);
}

const bookmarks: KarakeepBookmark[] = rows.map((row) => ({
  id: row.id,
  // Karakeep stores unix seconds; the API hands out ISO strings, and the
  // importer parses the latter. Getting this wrong silently stamps every
  // imported link with 1970 or with today.
  createdAt: new Date(row.createdAt * 1000).toISOString(),
  title: row.title,
  summary: row.summary,
  note: row.note,
  archived: row.archived === 1,
  favourited: row.favourited === 1,
  tags: tagsByBookmark.get(row.id) ?? [],
  lists: listsByBookmark.get(row.id) ?? [],
  content:
    row.type === "link" && row.url
      ? {
          type: "link",
          url: row.url,
          title: row.linkTitle,
          description: row.description,
          imageUrl: row.imageUrl,
          publisher: row.publisher,
          author: row.author,
        }
      : { type: row.type === "text" ? "text" : row.type === "asset" ? "asset" : "unknown" },
}));

await Bun.write(outPath, `${JSON.stringify({ bookmarks }, null, 2)}\n`);
db.close();

const links = bookmarks.filter((b) => b.content.type === "link").length;
const filed = bookmarks.filter((b) => (b.lists?.length ?? 0) > 0).length;
console.log(
  `Wrote ${bookmarks.length} bookmark(s) to ${outPath} ` +
    `(${links} link(s), ${bookmarks.length - links} other, ${filed} in a list).`,
);

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}
