import type { Link } from "./db.ts";
import type { Store } from "./store.ts";
import type { Summariser } from "./summarise.ts";
import { fetchMetadata, type PageMetadata } from "./metadata.ts";
import { pathForStoredFile, storedNameFromUrl } from "./files.ts";
import { readPdf } from "./pdf.ts";
import { hostOf } from "./url.ts";

/**
 * Background enrichment: scrape the page, ask Mistral for a sentence, write both
 * back to the link.
 *
 * This runs *after* the save returns rather than inside it. A share-sheet POST
 * that waited on a page fetch plus an LLM round-trip would hold the sheet open
 * for several seconds and fail outright on a slow site; instead the link is
 * stored as `pending` immediately and fills itself in a moment later.
 *
 * The queue is in-process and serial. That is the right size for a personal
 * bookmark box — the work is IO-bound and low-volume, and a serial queue means
 * no concurrency limit to tune and no third-party job runner in the deployment.
 */

export interface Enricher {
  /** Queue a link for enrichment. Returns immediately. */
  enqueue(id: number): void;
  /** Resolves once the queue is empty. Used by tests and by startup recovery. */
  idle(): Promise<void>;
}

export interface EnricherOptions {
  store: Store;
  summariser: Summariser;
  /** Where uploaded PDFs are stored. Required to enrich them. */
  filesDir?: string;
  /** Injectable so tests do not reach the network. */
  fetchPage?: typeof fetchMetadata;
}

export function createEnricher({
  store,
  summariser,
  filesDir,
  fetchPage = fetchMetadata,
}: EnricherOptions): Enricher {
  const queue: number[] = [];
  let running: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const id = queue.shift()!;
      try {
        await enrichOne(id);
      } catch (error) {
        // enrichOne handles its own failures; this only catches a bug in the
        // handling itself, which must not stall the rest of the queue.
        console.error(`[enrich] link ${id} threw unexpectedly:`, error);
      }
    }
    running = null;
  }

  async function enrichOne(id: number): Promise<void> {
    const link = store.get(id);
    if (!link) return;

    try {
      const page = link.kind === "file" ? await readStoredPdf(link) : await fetchPage(link.url);
      const summary = await summariser.summarise(link.url, page);

      store.markReady(id, {
        title: page.title ?? link.title ?? link.url,
        // The page's own description is the fallback when there is no API key
        // or the model call failed, so a link is rarely left with nothing.
        description: summary ?? truncate(page.pageDescription),
        imageUrl: page.imageUrl,
        siteName: page.siteName ?? hostOf(link.url),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[enrich] ${link.url}: ${message}`);
      store.markFailed(id, message);
    }
  }

  /** Reads an uploaded PDF off the volume and shapes it like a fetched page. */
  async function readStoredPdf(link: Link): Promise<PageMetadata> {
    const name = storedNameFromUrl(link.url);
    const path = filesDir && name ? pathForStoredFile(name, filesDir) : null;
    if (!path) throw new Error("This upload is missing from the file store.");

    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error("This upload is missing from the file store.");

    const { title, excerpt, pageCount } = await readPdf(new Uint8Array(await file.arrayBuffer()));

    return {
      // The PDF's own title wins, then anything an import already knew, and
      // the filename last — it is often just a product code.
      title: title ?? link.title ?? link.fileName,
      imageUrl: null,
      siteName: `PDF · ${pageCount} page${pageCount === 1 ? "" : "s"}`,
      pageDescription: null,
      excerpt,
    };
  }

  return {
    enqueue(id) {
      queue.push(id);
      running ??= drain();
    },
    async idle() {
      while (running) await running;
    },
  };
}

/**
 * Picks up links left `pending` by a container restart. Without this, a link
 * saved the instant before a Coolify redeploy would sit blank forever.
 */
export function resumePending(store: Store, enricher: Enricher): number {
  const pending = store.pending();
  for (const link of pending) enricher.enqueue(link.id);
  return pending.length;
}

function truncate(value: string | null, max = 300): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
