import { beforeEach, expect, test } from "bun:test";
import { createDb } from "../src/db.ts";
import { createStore, type Store } from "../src/store.ts";
import { createEnricher, resumePending } from "../src/enrich.ts";
import type { PageMetadata } from "../src/metadata.ts";
import type { Summariser } from "../src/summarise.ts";
import { nullSummariser } from "../src/summarise.ts";

const page: PageMetadata = {
  title: "Cacio e pepe",
  imageUrl: "https://example.com/pasta.jpg",
  siteName: "Example Kitchen",
  pageDescription: "The classic Roman pasta.",
  excerpt: "Cheese, pepper, pasta water.",
};

const stubSummariser: Summariser = { async summarise() { return "Explains why the sauce splits."; } };

let store: Store;

beforeEach(() => {
  const { db, sqlite } = createDb(":memory:");
  store = createStore(db, sqlite);
});

test("fills in the scraped fields and the model's sentence", async () => {
  const enricher = createEnricher({
    store,
    summariser: stubSummariser,
    fetchPage: async () => page,
  });

  const { link } = store.save("https://example.com/pasta");
  enricher.enqueue(link.id);
  await enricher.idle();

  const enriched = store.get(link.id)!;
  expect(enriched.status).toBe("ready");
  expect(enriched.title).toBe("Cacio e pepe");
  expect(enriched.description).toBe("Explains why the sauce splits.");
  expect(enriched.imageUrl).toBe("https://example.com/pasta.jpg");
  expect(enriched.siteName).toBe("Example Kitchen");
});

test("falls back to the page's own description when there is no model", async () => {
  const enricher = createEnricher({
    store,
    summariser: nullSummariser,
    fetchPage: async () => page,
  });

  const { link } = store.save("https://example.com/pasta");
  enricher.enqueue(link.id);
  await enricher.idle();

  const enriched = store.get(link.id)!;
  expect(enriched.status).toBe("ready");
  expect(enriched.description).toBe("The classic Roman pasta.");
});

test("records a fetch failure instead of losing the link", async () => {
  const enricher = createEnricher({
    store,
    summariser: stubSummariser,
    fetchPage: async () => {
      throw new Error("HTTP 403");
    },
  });

  const { link } = store.save("https://example.com/blocked");
  enricher.enqueue(link.id);
  await enricher.idle();

  const failed = store.get(link.id)!;
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe("HTTP 403");
  expect(store.list()).toHaveLength(1);
});

test("one bad link does not stall the rest of the queue", async () => {
  const enricher = createEnricher({
    store,
    summariser: stubSummariser,
    fetchPage: async (url) => {
      if (url.includes("bad")) throw new Error("boom");
      return page;
    },
  });

  const bad = store.save("https://example.com/bad").link;
  const good = store.save("https://example.com/good").link;
  enricher.enqueue(bad.id);
  enricher.enqueue(good.id);
  await enricher.idle();

  expect(store.get(bad.id)!.status).toBe("failed");
  expect(store.get(good.id)!.status).toBe("ready");
});

test("resumePending picks up links stranded by a restart", async () => {
  store.save("https://example.com/one");
  store.save("https://example.com/two");

  const enricher = createEnricher({
    store,
    summariser: nullSummariser,
    fetchPage: async () => page,
  });

  expect(resumePending(store, enricher)).toBe(2);
  await enricher.idle();
  expect(store.pending()).toHaveLength(0);
});
