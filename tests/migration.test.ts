import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, openDatabase } from "../src/db.ts";
import { createStore } from "../src/store.ts";

/**
 * The schema before lists existed. Kept verbatim rather than generated, because
 * the whole point is to open a file that a *previous release* wrote — an
 * in-memory database built from the current schema proves nothing about the
 * upgrade path, which is how a boot-time migration failure reached production.
 */
const SCHEMA_BEFORE_LISTS = `
CREATE TABLE links (
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
CREATE INDEX links_created_at_idx ON links (created_at DESC);
CREATE VIRTUAL TABLE links_fts USING fts5(
  title, description, site_name, url, content='links', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER links_fts_insert AFTER INSERT ON links BEGIN
  INSERT INTO links_fts (rowid, title, description, site_name, url)
  VALUES (new.id, new.title, new.description, new.site_name, new.url);
END;
CREATE TRIGGER links_fts_delete AFTER DELETE ON links BEGIN
  INSERT INTO links_fts (links_fts, rowid, title, description, site_name, url)
  VALUES ('delete', old.id, old.title, old.description, old.site_name, old.url);
END;
CREATE TRIGGER links_fts_update AFTER UPDATE ON links BEGIN
  INSERT INTO links_fts (links_fts, rowid, title, description, site_name, url)
  VALUES ('delete', old.id, old.title, old.description, old.site_name, old.url);
  INSERT INTO links_fts (rowid, title, description, site_name, url)
  VALUES (new.id, new.title, new.description, new.site_name, new.url);
END;
`;

let dir: string | null = null;

function oldDatabasePath(): string {
  dir = mkdtempSync(join(tmpdir(), "marcador-migration-"));
  const path = join(dir, "marcador.db");

  const sqlite = new Database(path, { create: true });
  sqlite.exec(SCHEMA_BEFORE_LISTS);
  sqlite
    .query("INSERT INTO links (url, title, status, created_at) VALUES (?, ?, 'ready', ?)")
    .run("https://example.com/old", "Saved before lists", 1_700_000_000_000);
  sqlite.close();

  return path;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("opening a database written before lists existed", () => {
  test("adds the column instead of dying on boot", () => {
    const path = oldDatabasePath();

    const sqlite = openDatabase(path);
    const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info(links)").all();

    expect(columns.map((column) => column.name)).toContain("list_id");
    sqlite.close();
  });

  test("keeps the links that were already saved", () => {
    const path = oldDatabasePath();
    const { db, sqlite } = createDb(path);
    const store = createStore(db, sqlite);

    const [link] = store.list();
    expect(link!.title).toBe("Saved before lists");
    expect(link!.listId).toBeNull();
    sqlite.close();
  });

  test("can file an upgraded link straight away", () => {
    // Exercises the FTS triggers too: filing is an UPDATE on links, which
    // rewrites the row's search-index entry.
    const path = oldDatabasePath();
    const { db, sqlite } = createDb(path);
    const store = createStore(db, sqlite);

    const list = store.createList("Tech");
    const [link] = store.list();
    store.assign(link!.id, list.id);

    expect(store.list({ listId: list.id })).toHaveLength(1);
    sqlite.close();
  });

  test("is safe to run twice, as every container restart does", () => {
    const path = oldDatabasePath();
    openDatabase(path).close();
    expect(() => openDatabase(path).close()).not.toThrow();
  });
});
