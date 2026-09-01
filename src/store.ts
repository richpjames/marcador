import type { Database } from "bun:sqlite";
import { desc, eq, sql } from "drizzle-orm";
import type { Db, Link, List } from "./db.ts";
import { links, lists } from "./db.ts";
import { normaliseUrl } from "./url.ts";
import { urlForStoredFile } from "./files.ts";

export interface SaveOptions {
  /**
   * Overrides the save time. Only used by the importer, which has to preserve
   * when a link was originally saved elsewhere — otherwise a migration stamps
   * every link with the migration date and destroys the ordering.
   */
  createdAt?: number;
}

/** A list plus how many links are filed under it, for the nav counts. */
export interface ListWithCount extends List {
  count: number;
}

/** An uploaded PDF that has already been written to disk. */
export interface FileToSave {
  /** The stored `<sha256>.pdf` name, from `storePdf`. */
  storedName: string;
  fileName: string;
  size: number;
  createdAt?: number;
  /** Overrides the filename as the display title. Used by the importer. */
  title?: string | null;
}

export interface Store {
  save(url: string, options?: SaveOptions): { link: Link; created: boolean };
  /** Same contract as `save`: re-uploading identical bytes returns the original. */
  saveFile(file: FileToSave): { link: Link; created: boolean };
  list(options?: { limit?: number; offset?: number; listId?: number }): Link[];
  search(query: string, options?: { limit?: number; listId?: number }): Link[];
  get(id: number): Link | undefined;
  byUrl(url: string): Link | undefined;
  remove(id: number): boolean;
  markReady(id: number, fields: Partial<Pick<Link, "title" | "description" | "imageUrl" | "siteName">>): void;
  markFailed(id: number, message: string): void;
  pending(): Link[];

  /** How many links are saved in total, for the "All" chip. */
  count(): number;
  /** Every list, with its link count, most-used first. */
  allLists(): ListWithCount[];
  /** Idempotent: an existing list of the same name is returned, not duplicated. */
  createList(name: string, icon?: string | null): List;
  removeList(id: number): boolean;
  /** Files a link under a list, or unfiles it with null. */
  assign(linkId: number, listId: number | null): boolean;
}

/**
 * FTS5 treats bare input as query syntax, so a stray `"` or `AND` from the
 * search box would raise a SQL error rather than return no results. Each word is
 * reduced to safe characters, quoted, and given a `*` so typing "beach" matches
 * "beaches" — prefix matching is what a search-as-you-type box implies.
 */
export function toFtsQuery(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((term) => term.replace(/["*(){}:^-]/g, "").trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"*`);

  return terms.length > 0 ? terms.join(" ") : null;
}

export function createStore(db: Db, sqlite: Database): Store {
  return {
    save(rawUrl, options = {}) {
      const url = normaliseUrl(rawUrl);

      const existing = db.select().from(links).where(eq(links.url, url)).get();
      if (existing) return { link: existing, created: false };

      const link = db
        .insert(links)
        .values({ url, status: "pending", createdAt: options.createdAt ?? Date.now() })
        .returning()
        .get();

      return { link, created: true };
    },

    saveFile({ storedName, fileName, size, createdAt, title }) {
      const url = urlForStoredFile(storedName);

      // The name is the hash of the contents, so an identical PDF uploaded a
      // second time collides here and keeps the original — and its list.
      const existing = db.select().from(links).where(eq(links.url, url)).get();
      if (existing) return { link: existing, created: false };

      const link = db
        .insert(links)
        .values({
          url,
          kind: "file",
          fileName,
          fileSize: size,
          // The filename is the only thing known before the PDF is read, and a
          // card with no title at all looks broken while enrichment runs.
          title: title?.trim() || fileName,
          // Set now rather than at enrichment: a file's card has no host to
          // fall back on, so a pending or failed upload would otherwise show
          // "/files/3f2a…pdf" where the site name goes.
          siteName: "PDF",
          status: "pending",
          createdAt: createdAt ?? Date.now(),
        })
        .returning()
        .get();

      return { link, created: true };
    },

    list({ limit = 100, offset = 0, listId } = {}) {
      const query = db.select().from(links).$dynamic();

      return (listId === undefined ? query : query.where(eq(links.listId, listId)))
        .orderBy(desc(links.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    },

    search(query, { limit = 100, listId } = {}) {
      const match = toFtsQuery(query);
      if (!match) return [];

      // Raw SQL: drizzle has no FTS5 MATCH builder, and `bm25` ranking is the
      // whole point of using FTS rather than a LIKE scan.
      const filter = listId === undefined ? "" : "AND l.list_id = ?";
      const rows = sqlite
        .query<Record<string, unknown>, (string | number)[]>(
          `SELECT l.* FROM links_fts f
             JOIN links l ON l.id = f.rowid
            WHERE links_fts MATCH ? ${filter}
            ORDER BY bm25(links_fts, 2.0, 3.0, 1.0, 0.5), l.created_at DESC
            LIMIT ?`,
        )
        .all(...(listId === undefined ? [match, limit] : [match, listId, limit]));

      return rows.map(rowToLink);
    },

    get(id) {
      return db.select().from(links).where(eq(links.id, id)).get();
    },

    byUrl(url) {
      return db.select().from(links).where(eq(links.url, url)).get();
    },

    remove(id) {
      return db.delete(links).where(eq(links.id, id)).returning().all().length > 0;
    },

    markReady(id, fields) {
      db.update(links)
        .set({ ...fields, status: "ready", error: null, enrichedAt: Date.now() })
        .where(eq(links.id, id))
        .run();
    },

    markFailed(id, message) {
      db.update(links)
        .set({ status: "failed", error: message.slice(0, 500), enrichedAt: Date.now() })
        .where(eq(links.id, id))
        .run();
    },

    pending() {
      return db.select().from(links).where(eq(links.status, "pending")).all();
    },

    count() {
      return db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(links).get()?.n ?? 0;
    },

    allLists() {
      // A left join so a list you just made, or emptied, still shows with 0.
      return db
        .select({
          id: lists.id,
          name: lists.name,
          icon: lists.icon,
          createdAt: lists.createdAt,
          count: sql<number>`count(${links.id})`.mapWith(Number),
        })
        .from(lists)
        .leftJoin(links, eq(links.listId, lists.id))
        .groupBy(lists.id)
        .orderBy(desc(sql`count(${links.id})`), lists.name)
        .all();
    },

    createList(name, icon = null) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("A list needs a name.");

      const existing = db.select().from(lists).where(eq(lists.name, trimmed)).get();
      if (existing) return existing;

      return db
        .insert(lists)
        .values({ name: trimmed, icon: icon?.trim() || null, createdAt: Date.now() })
        .returning()
        .get();
    },

    removeList(id) {
      // The links survive; `on delete set null` just unfiles them.
      return db.delete(lists).where(eq(lists.id, id)).returning().all().length > 0;
    },

    assign(linkId, listId) {
      return db.update(links).set({ listId }).where(eq(links.id, linkId)).returning().all().length > 0;
    },
  };
}

/** snake_case row from raw SQL back into the camelCase shape drizzle returns. */
function rowToLink(row: Record<string, unknown>): Link {
  return {
    id: row.id as number,
    url: row.url as string,
    title: (row.title ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    imageUrl: (row.image_url ?? null) as string | null,
    siteName: (row.site_name ?? null) as string | null,
    status: row.status as Link["status"],
    error: (row.error ?? null) as string | null,
    createdAt: row.created_at as number,
    enrichedAt: (row.enriched_at ?? null) as number | null,
    listId: (row.list_id ?? null) as number | null,
    kind: row.kind as Link["kind"],
    fileName: (row.file_name ?? null) as string | null,
    fileSize: (row.file_size ?? null) as number | null,
  };
}
