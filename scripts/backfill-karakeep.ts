#!/usr/bin/env bun
/**
 * Repairs links that failed enrichment during a Karakeep import.
 *
 * Some sites answer a crawler with 403 or 404 forever — property portals and
 * Reddit are the usual offenders — so those links land as `failed` with nothing
 * on them but a URL. Karakeep had already crawled many of them successfully
 * months ago, and that title is still sitting in the export file.
 *
 * This copies it across. A link Karakeep also knew nothing about is left
 * `failed`, because "we could not fetch this" is true and worth showing.
 *
 *   bun scripts/backfill-karakeep.ts --file karakeep-export.json
 *   bun scripts/backfill-karakeep.ts --file export.json --dry-run
 */

import { eq } from "drizzle-orm";
import { createDb, links } from "../src/db.ts";
import { createStore } from "../src/store.ts";
import { mapBookmark, parseExport } from "../src/karakeep.ts";

const args = parseArgs(Bun.argv.slice(2));
if (!args.file) {
  console.error("Need --file <karakeep-export.json>.");
  process.exit(1);
}

const byUrl = new Map<string, ReturnType<typeof mapBookmark>>();
for (const bookmark of parseExport(await Bun.file(args.file).json())) {
  const link = mapBookmark(bookmark);
  if (link) byUrl.set(link.url, link);
}

const { db, sqlite } = createDb();
const store = createStore(db, sqlite);

// Queried here rather than through the Store: "every failed link" is a repair
// concern, not something the app itself ever needs.
const failed = db.select().from(links).where(eq(links.status, "failed")).all();
let repaired = 0;

for (const link of failed) {
  const source = byUrl.get(link.url);
  // Only a title makes the link readable in a list; an entry with nothing but a
  // URL is no better repaired than left alone.
  if (!source?.title) continue;

  console.log(`  ${source.title}`);
  if (!args["dry-run"]) {
    store.markReady(link.id, {
      title: source.title,
      description: source.description,
      imageUrl: source.imageUrl,
      siteName: source.siteName,
    });
  }
  repaired += 1;
}

console.log(
  `\n${args["dry-run"] ? "Would repair" : "Repaired"} ${repaired} of ${failed.length} failed link(s); ` +
    `${failed.length - repaired} had nothing in Karakeep either.`,
);

sqlite.close();

function parseArgs(argv: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[arg.slice(2)] = true;
    else {
      out[arg.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}
