import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "./config.ts";

/**
 * A saved link. `status` tracks the enrichment pipeline rather than anything
 * the reader cares about: a link is inserted immediately on save (so the share
 * sheet can dismiss at once) and the title/description/image land later.
 */
/**
 * A named group of links — "Clothes", "Tech". One list per link rather than a
 * join table: that is what the data coming out of Karakeep actually looked like
 * (not one bookmark of 118 sat in two lists), and it is what the single-select
 * on each card can express. A many-to-many table backing a one-of-many UI would
 * be storing a relationship nothing can enter or show.
 */
export const lists = sqliteTable("lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  /** A single emoji, shown before the name. Karakeep had one on every list. */
  icon: text("icon"),
  createdAt: integer("created_at").notNull(),
});

export type List = typeof lists.$inferSelect;

export const links = sqliteTable("links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  title: text("title"),
  /** One sentence, written by Mistral. */
  description: text("description"),
  imageUrl: text("image_url"),
  siteName: text("site_name"),
  status: text("status", { enum: ["pending", "ready", "failed"] })
    .notNull()
    .default("pending"),
  /** Why enrichment failed, kept so a bad link is debuggable from the UI. */
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  enrichedAt: integer("enriched_at"),
  /** Null means unfiled, which is the resting state for most links. */
  listId: integer("list_id").references(() => lists.id, { onDelete: "set null" }),
  /**
   * "link" for a URL someone saved, "file" for a PDF uploaded here. A file's
   * `url` is its own `/files/<sha256>.pdf` path, which keeps the dedupe and the
   * href working the same way for both.
   */
  kind: text("kind", { enum: ["link", "file"] })
    .notNull()
    .default("link"),
  /** The name the file was uploaded under, kept for display and download. */
  fileName: text("file_name"),
  fileSize: integer("file_size"),
});

export type Link = typeof links.$inferSelect;

/**
 * Schema is applied on startup rather than through drizzle-kit: one table and
 * an FTS index do not need a migration toolchain, and `IF NOT EXISTS` makes the
 * whole thing idempotent across container restarts.
 *
 * The FTS5 table is external-content (`content='links'`), so the text is stored
 * once and the triggers below keep the index in step with writes.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  image_url TEXT,
  site_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL,
  enriched_at INTEGER,
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'link',
  file_name TEXT,
  file_size INTEGER
);

CREATE INDEX IF NOT EXISTS links_created_at_idx ON links (created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
  title, description, site_name, url,
  content='links',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS links_fts_insert AFTER INSERT ON links BEGIN
  INSERT INTO links_fts (rowid, title, description, site_name, url)
  VALUES (new.id, new.title, new.description, new.site_name, new.url);
END;

CREATE TRIGGER IF NOT EXISTS links_fts_delete AFTER DELETE ON links BEGIN
  INSERT INTO links_fts (links_fts, rowid, title, description, site_name, url)
  VALUES ('delete', old.id, old.title, old.description, old.site_name, old.url);
END;

CREATE TRIGGER IF NOT EXISTS links_fts_update AFTER UPDATE ON links BEGIN
  INSERT INTO links_fts (links_fts, rowid, title, description, site_name, url)
  VALUES ('delete', old.id, old.title, old.description, old.site_name, old.url);
  INSERT INTO links_fts (rowid, title, description, site_name, url)
  VALUES (new.id, new.title, new.description, new.site_name, new.url);
END;
`;

export function openDatabase(path: string = config.databasePath): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  // WAL keeps the enrichment writes from blocking page reads.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(SCHEMA);
  addMissingColumns(sqlite);
  return sqlite;
}

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * database written before lists were added never gets the new column from
 * SCHEMA above. SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the lookup.
 *
 * The index on that column lives here rather than in SCHEMA for the same
 * reason: run against an existing database, SCHEMA would be indexing a column
 * that does not exist yet and the process would die on boot.
 */
function addMissingColumns(sqlite: Database): void {
  const columns = new Set(
    sqlite.query<{ name: string }, []>("PRAGMA table_info(links)").all().map((c) => c.name),
  );

  if (!columns.has("list_id")) {
    sqlite.exec("ALTER TABLE links ADD COLUMN list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL;");
  }
  if (!columns.has("kind")) {
    sqlite.exec("ALTER TABLE links ADD COLUMN kind TEXT NOT NULL DEFAULT 'link';");
  }
  if (!columns.has("file_name")) {
    sqlite.exec("ALTER TABLE links ADD COLUMN file_name TEXT;");
  }
  if (!columns.has("file_size")) {
    sqlite.exec("ALTER TABLE links ADD COLUMN file_size INTEGER;");
  }

  sqlite.exec("CREATE INDEX IF NOT EXISTS links_list_id_idx ON links (list_id);");
}

export function createDb(path?: string) {
  const sqlite = openDatabase(path);
  return { sqlite, db: drizzle(sqlite, { schema: { links, lists } }) };
}

export type Db = ReturnType<typeof createDb>["db"];
