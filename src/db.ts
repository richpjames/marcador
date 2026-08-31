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
  enriched_at INTEGER
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
  return sqlite;
}

export function createDb(path?: string) {
  const sqlite = openDatabase(path);
  return { sqlite, db: drizzle(sqlite, { schema: { links } }) };
}

export type Db = ReturnType<typeof createDb>["db"];
