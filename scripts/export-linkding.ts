#!/usr/bin/env bun
/**
 * Exports marcador's links into a linkding instance through its REST API.
 *
 * Lists become tags — linkding has no lists — and uploaded PDFs are left
 * behind on purpose, since linkding has nowhere to put a file. Links whose
 * enrichment failed (no title) are sent bare so linkding scrapes them itself.
 *
 * Safe to re-run: linkding updates the existing bookmark when the URL is
 * already saved, so a second pass overwrites rather than duplicates. The
 * database is opened read-only; marcador itself is never written to.
 *
 *   docker cp <marcador-container>:/data/marcador.db ./marcador.db
 *   bun scripts/export-linkding.ts --db ./marcador.db \
 *       --to https://links.example.com --token <api-token>
 *
 * Get the token from linkding > Settings > API.
 *
 * Options:
 *   --db <path>    marcador's SQLite file (default: ./marcador.db)
 *   --to <url>     linkding base URL
 *   --token <t>    linkding API token
 *   --dry-run      Report what would be sent, POST nothing
 */

import { Database } from "bun:sqlite";

const args = parseArgs(Bun.argv.slice(2));
const dbPath = args.db ?? "./marcador.db";

if (!args["dry-run"] && !(args.to && args.token)) {
  console.error("Need --to <url> and --token <api-token> (or --dry-run).");
  process.exit(1);
}

// --- Read ---------------------------------------------------------------

const db = new Database(dbPath, { readonly: true });

interface Row {
  url: string;
  title: string | null;
  description: string | null;
  kind: string;
  created_at: number;
  listName: string | null;
}

// Anything that is not a PDF is a link; `kind` postdates the first deployed
// schema, so old rows may carry NULL rather than 'link'.
const rows = db
  .query<Row, []>(
    `select l.url, l.title, l.description, l.kind, l.created_at, k.name as listName
       from links l
       left join lists k on k.id = l.list_id
      order by l.created_at asc`,
  )
  .all();

db.close();

const skipped = rows.filter((row) => row.kind === "pdf");
const links = rows.filter((row) => row.kind !== "pdf");

// --- Map ----------------------------------------------------------------

// The date is the one field a re-scrape cannot recover, so it always travels
// with the link. Title and description are sent only when marcador has one:
// linkding scrapes the page itself to fill in whatever arrives empty.
function payload(row: Row): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url: row.url,
    date_added: new Date(row.created_at).toISOString(),
  };
  if (row.title) body.title = row.title;
  if (row.description) body.description = row.description;
  if (row.listName) body.tag_names = [row.listName];
  return body;
}

if (args["dry-run"]) {
  console.log("Dry run — nothing sent.\n");
  for (const row of links.slice(0, 10)) {
    console.log(`  ${row.title ?? row.url}`);
    console.log(`    ${row.url} → tags: [${row.listName ?? ""}]`);
  }
  if (links.length > 10) console.log(`  … and ${links.length - 10} more`);

  const unfiled = links.filter((row) => !row.listName).length;
  console.log(
    `\nWould send ${links.length} link(s) (${unfiled} unfiled), ` +
      `skipping ${skipped.length} PDF(s).`,
  );
  process.exit(0);
}

// --- Send ----------------------------------------------------------------

const base = String(args.to).replace(/\/+$/, "");
const stats = { created: 0, updated: 0, failed: 0 };

for (const row of links) {
  const body = JSON.stringify(payload(row));
  let response: Response;
  try {
    response = await fetch(`${base}/api/bookmarks/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${args.token}`,
      },
      body,
    });
  } catch (error) {
    // A link that cannot be sent must not stop the rest of the export —
    // the run is resumable by re-running, thanks to the upsert above.
    console.warn(`  failed ${row.url}: ${error instanceof Error ? error.message : error}`);
    stats.failed += 1;
    continue;
  }

  if (response.status === 201) stats.created += 1;
  else if (response.ok) stats.updated += 1;
  else {
    console.warn(`  failed ${row.url}: linkding answered ${response.status}`);
    stats.failed += 1;
  }

  if ((stats.created + stats.updated + stats.failed) % 100 === 0) {
    console.log(`  …${stats.created + stats.updated + stats.failed}`);
  }
}

console.log(
  `\nSent ${stats.created + stats.updated} link(s) to ${base} ` +
    `(${stats.created} created, ${stats.updated} updated, ${stats.failed} failed); ` +
    `skipped ${skipped.length} PDF(s).`,
);
if (stats.failed > 0) process.exit(1);

function parseArgs(argv: string[]): Record<string, string | undefined> & { [k: string]: any } {
  const out: Record<string, any> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    // A flag followed by another flag (or nothing) is a boolean.
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
