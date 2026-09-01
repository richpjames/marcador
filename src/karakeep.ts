/**
 * Reading bookmarks out of Karakeep.
 *
 * Two sources, because there are two ways to get at your own data and it is not
 * obvious in advance which one you can use:
 *
 *   * the REST API, which needs an API key from Settings > API Keys, and
 *   * a JSON export file, which needs no key but does need a trip through the UI.
 *
 * Both arrive at the same `KarakeepBookmark[]`, so the mapping below is shared.
 */

import { hostOf } from "./url.ts";

/** The subset of Karakeep's bookmark schema a link saver actually needs. */
export interface KarakeepBookmark {
  id: string;
  createdAt: string;
  /** User-set title, which overrides the crawled one when present. */
  title?: string | null;
  /** Karakeep's own AI summary, when summarisation was enabled. */
  summary?: string | null;
  note?: string | null;
  archived?: boolean;
  favourited?: boolean;
  tags?: { name: string }[];
  /**
   * Which lists the bookmark sits in. Karakeep allows several; marcador has one
   * list per link, so only the first survives — see `mapBookmark`.
   */
  lists?: { name: string; icon?: string | null }[];
  content:
    | {
        type: "link";
        url: string;
        title?: string | null;
        description?: string | null;
        imageUrl?: string | null;
        publisher?: string | null;
        author?: string | null;
      }
    | {
        type: "asset";
        /** Path within Karakeep's assets directory, from the SQLite exporter. */
        assetPath?: string | null;
        fileName?: string | null;
        contentType?: string | null;
        size?: number | null;
      }
    | { type: "text" | "unknown"; [key: string]: unknown };
}

/** What one Karakeep bookmark becomes in marcador. */
export interface MappedLink {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  createdAt: number;
  /** The list to file this under, by name. Null means unfiled. */
  listName: string | null;
  listIcon: string | null;
}

/**
 * Karakeep keeps far more per bookmark than marcador does — tags, archived
 * state, highlights, full-page archives. This is where that is deliberately
 * dropped rather than half-modelled: marcador has no tags and no archive, so
 * carrying the fields would mean storing data nothing can show.
 *
 * Lists *are* carried, but flattened to one. Karakeep permits a bookmark in
 * several lists and marcador does not, so a bookmark in two would lose the
 * second — worth knowing, even though no bookmark in the migration this was
 * written for was in more than one.
 *
 * Returns null for anything that is not a link (Karakeep also stores plain text
 * notes and uploaded files), so the caller can count what it skipped.
 */
export function mapBookmark(bookmark: KarakeepBookmark): MappedLink | null {
  if (bookmark.content?.type !== "link") return null;

  const content = bookmark.content;
  if (!content.url) return null;

  const createdAt = Date.parse(bookmark.createdAt);

  return {
    url: content.url,
    // A title the user typed beats the one the crawler found.
    title: firstOf(bookmark.title, content.title),
    // Karakeep's AI summary first, then the page's own description. A note is
    // something the user wrote themselves, so it outranks both.
    description: firstOf(bookmark.note, bookmark.summary, content.description),
    imageUrl: firstOf(content.imageUrl),
    siteName: firstOf(content.publisher) ?? hostOf(content.url),
    // A bookmark with an unparseable date still belongs in the list; putting it
    // at "now" is less wrong than dropping it.
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    listName: firstOf(bookmark.lists?.[0]?.name),
    listIcon: firstOf(bookmark.lists?.[0]?.icon),
  };
}

/** An uploaded file that marcador can take: today that means a PDF. */
export interface MappedFile {
  assetPath: string;
  fileName: string;
  title: string | null;
  createdAt: number;
  listName: string | null;
  listIcon: string | null;
}

/**
 * Karakeep's uploaded files. Only PDFs come across — marcador stores those and
 * can describe them, where an arbitrary binary would be a download it knows
 * nothing about. Returns null for anything else, including a link.
 */
export function mapAsset(bookmark: KarakeepBookmark): MappedFile | null {
  if (bookmark.content?.type !== "asset") return null;

  const content = bookmark.content;
  if (!content.assetPath) return null;
  if (content.contentType && !content.contentType.includes("pdf")) return null;

  const fileName = firstOf(content.fileName) ?? "document.pdf";
  const createdAt = Date.parse(bookmark.createdAt);

  return {
    assetPath: content.assetPath,
    fileName,
    // Karakeep titles an upload with the filename unless you rename it, and a
    // renamed one is worth more than the filename on the card.
    title: firstOf(bookmark.title) ?? null,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    listName: firstOf(bookmark.lists?.[0]?.name),
    listIcon: firstOf(bookmark.lists?.[0]?.icon),
  };
}

function firstOf(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source: the REST API
// ---------------------------------------------------------------------------

/**
 * Pages through `GET /api/v1/bookmarks`. Karakeep returns a `nextCursor` until
 * there is nothing left; `pageLimit` is capped by the server anyway, so this
 * asks for a sane batch rather than the maximum.
 */
export async function* fetchFromApi(
  serverUrl: string,
  apiKey: string,
  { pageLimit = 100 }: { pageLimit?: number } = {},
): AsyncGenerator<KarakeepBookmark> {
  const base = serverUrl.replace(/\/+$/, "");
  let cursor: string | null = null;
  // Guards against a server that keeps handing back the same cursor.
  const seenCursors = new Set<string>();

  do {
    const url = new URL(`${base}/api/v1/bookmarks`);
    url.searchParams.set("limit", String(pageLimit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 401) {
      throw new Error("Karakeep rejected the API key (401). Check Settings > API Keys.");
    }
    if (!response.ok) {
      throw new Error(`Karakeep returned HTTP ${response.status} for ${url.pathname}`);
    }

    const page = (await response.json()) as {
      bookmarks?: KarakeepBookmark[];
      nextCursor?: string | null;
    };

    for (const bookmark of page.bookmarks ?? []) yield bookmark;

    cursor = page.nextCursor ?? null;
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
}

// ---------------------------------------------------------------------------
// Source: a JSON export file
// ---------------------------------------------------------------------------

/**
 * Karakeep's export is `{ bookmarks: [...] }`. A bare array is accepted too,
 * since that is what a hand-rolled `jq` extract usually produces.
 */
export function parseExport(json: unknown): KarakeepBookmark[] {
  if (Array.isArray(json)) return json as KarakeepBookmark[];

  const bookmarks = (json as { bookmarks?: unknown })?.bookmarks;
  if (Array.isArray(bookmarks)) return bookmarks as KarakeepBookmark[];

  throw new Error(
    "Unrecognised export file: expected a JSON array, or an object with a `bookmarks` array.",
  );
}
