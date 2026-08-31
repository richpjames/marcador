import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import type { Db, Link } from "./db.ts";
import { links } from "./db.ts";
import { normaliseUrl } from "./url.ts";

export interface SaveOptions {
  /**
   * Overrides the save time. Only used by the importer, which has to preserve
   * when a link was originally saved elsewhere — otherwise a migration stamps
   * every link with the migration date and destroys the ordering.
   */
  createdAt?: number;
}

export interface Store {
  save(url: string, options?: SaveOptions): { link: Link; created: boolean };
  list(options?: { limit?: number; offset?: number }): Link[];
  search(query: string, options?: { limit?: number }): Link[];
  get(id: number): Link | undefined;
  remove(id: number): boolean;
  markReady(id: number, fields: Partial<Pick<Link, "title" | "description" | "imageUrl" | "siteName">>): void;
  markFailed(id: number, message: string): void;
  pending(): Link[];
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

    list({ limit = 100, offset = 0 } = {}) {
      return db
        .select()
        .from(links)
        .orderBy(desc(links.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    },

    search(query, { limit = 100 } = {}) {
      const match = toFtsQuery(query);
      if (!match) return [];

      // Raw SQL: drizzle has no FTS5 MATCH builder, and `bm25` ranking is the
      // whole point of using FTS rather than a LIKE scan.
      const rows = sqlite
        .query<Record<string, unknown>, [string, number]>(
          `SELECT l.* FROM links_fts f
             JOIN links l ON l.id = f.rowid
            WHERE links_fts MATCH ?
            ORDER BY bm25(links_fts, 2.0, 3.0, 1.0, 0.5), l.created_at DESC
            LIMIT ?`,
        )
        .all(match, limit);

      return rows.map(rowToLink);
    },

    get(id) {
      return db.select().from(links).where(eq(links.id, id)).get();
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
  };
}
