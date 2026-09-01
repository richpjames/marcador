#!/usr/bin/env bun
/**
 * Imports bookmarks from Karakeep into marcador.
 *
 * Safe to re-run: links are deduplicated on their normalised URL, so a second
 * pass adds only what is new. It never writes to Karakeep.
 *
 *   bun scripts/import-karakeep.ts --from https://bookmarks.example.com --key ak1_...
 *   bun scripts/import-karakeep.ts --file karakeep-export.json
 *   bun scripts/import-karakeep.ts --file export.json --dry-run
 *
 * Options:
 *   --from <url>     Karakeep server to read from (needs --key)
 *   --key <key>      API key: Karakeep > Settings > API Keys
 *   --file <path>    A Karakeep JSON export, instead of --from/--key
 *   --dry-run        Report what would happen, write nothing
 *   --summarise <s>  missing (default) | all | none — see below
 *   --skip-archived  Leave Karakeep's archived bookmarks behind
 */

import { createDb } from "../src/db.ts";
import { createStore } from "../src/store.ts";
import { createSummariser } from "../src/summarise.ts";
import { createEnricher } from "../src/enrich.ts";
import { fetchFromApi, mapBookmark, parseExport, type KarakeepBookmark } from "../src/karakeep.ts";
import { config } from "../src/config.ts";

const args = parseArgs(Bun.argv.slice(2));

if (!args.file && !(args.from && args.key)) {
  console.error(
    "Need either --file <export.json>, or --from <url> together with --key <api-key>.\n" +
      "Get a key from Karakeep > Settings > API Keys.",
  );
  process.exit(1);
}

const summarise = args.summarise ?? "missing";
if (!["missing", "all", "none"].includes(summarise)) {
  console.error(`--summarise must be one of: missing, all, none (got ${summarise})`);
  process.exit(1);
}

// --- Read ---------------------------------------------------------------

const bookmarks: KarakeepBookmark[] = [];

if (args.file) {
  console.log(`Reading ${args.file}`);
  bookmarks.push(...parseExport(await Bun.file(args.file).json()));
} else {
  console.log(`Reading from ${args.from}`);
  for await (const bookmark of fetchFromApi(args.from!, args.key!)) {
    bookmarks.push(bookmark);
    if (bookmarks.length % 100 === 0) console.log(`  …${bookmarks.length}`);
  }
}

console.log(`Found ${bookmarks.length} bookmark(s) in Karakeep.\n`);

// --- Map ----------------------------------------------------------------

const stats = { imported: 0, duplicate: 0, notALink: 0, archived: 0, queued: 0, filed: 0 };
const mapped = [];

for (const bookmark of bookmarks) {
  if (args["skip-archived"] && bookmark.archived) {
    stats.archived += 1;
    continue;
  }

  const link = mapBookmark(bookmark);
  if (!link) {
    // Text notes and uploaded files have no URL to save.
    stats.notALink += 1;
    continue;
  }

  mapped.push(link);
}

if (args["dry-run"]) {
  console.log("Dry run — nothing written.\n");
  for (const link of mapped.slice(0, 10)) {
    console.log(`  ${link.title ?? link.url}`);
    console.log(`    ${link.description ?? "(no description — would be summarised)"}`);
  }
  if (mapped.length > 10) console.log(`  … and ${mapped.length - 10} more`);
  const listNames = new Set(mapped.map((link) => link.listName).filter(Boolean));
  console.log(
    `\nWould import ${mapped.length} link(s) into ${listNames.size} list(s); ` +
      `skipping ${stats.notALink} non-link and ${stats.archived} archived.`,
  );
  process.exit(0);
}

// --- Write --------------------------------------------------------------

const { db, sqlite } = createDb();
const store = createStore(db, sqlite);
const enricher = createEnricher({ store, summariser: createSummariser() });

// Lists are created on first sight and reused after, so the import makes one
// row per name however many bookmarks reference it.
const listIds = new Map<string, number>();

function listIdFor(name: string, icon: string | null): number {
  const existing = listIds.get(name);
  if (existing !== undefined) return existing;

  const { id } = store.createList(name, icon);
  listIds.set(name, id);
  return id;
}

for (const link of mapped) {
  let saved;
  try {
    saved = store.save(link.url, { createdAt: link.createdAt });
  } catch (error) {
    // A URL Karakeep accepted that we reject (a bad scheme, say) must not stop
    // the rest of the import.
    console.warn(`  skipped ${link.url}: ${error instanceof Error ? error.message : error}`);
    stats.notALink += 1;
    continue;
  }

  const listId = link.listName ? listIdFor(link.listName, link.listIcon) : null;

  if (!saved.created) {
    stats.duplicate += 1;

    // A re-run over links that are already here still has work to do: an
    // earlier import may have predated lists entirely. Only ever fills a gap,
    // so a link filed by hand since is never moved back.
    if (listId !== null && saved.link.listId === null) {
      store.assign(saved.link.id, listId);
      stats.filed += 1;
    }
    continue;
  }

  stats.imported += 1;

  if (listId !== null) {
    store.assign(saved.link.id, listId);
    stats.filed += 1;
  }

  // "Needs a description" is the deciding question: anything left pending goes
  // through the normal enrichment queue, which fetches the page and asks
  // Mistral. Anything marked ready keeps exactly what Karakeep had.
  const needsSummary = summarise === "all" || (summarise === "missing" && !link.description);

  if (needsSummary) {
    enricher.enqueue(saved.link.id);
    stats.queued += 1;
  } else {
    store.markReady(saved.link.id, {
      title: link.title,
      description: link.description,
      imageUrl: link.imageUrl,
      siteName: link.siteName,
    });
  }
}

console.log(
  `\nImported ${stats.imported}, skipped ${stats.duplicate} already present, ` +
    `${stats.notALink} not links, ${stats.archived} archived.`,
);
console.log(`Filed ${stats.filed} link(s) across ${listIds.size} list(s).`);

if (stats.queued > 0) {
  const cost = config.mistralApiKey ? "" : " (no MISTRAL_API_KEY set — page descriptions only)";
  console.log(`Enriching ${stats.queued} link(s) in the background${cost}…`);
  await enricher.idle();
  console.log("Done.");
}

sqlite.close();

// ---------------------------------------------------------------------------

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
