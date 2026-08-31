import { beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "../src/db.ts";
import { createStore, toFtsQuery, type Store } from "../src/store.ts";

let store: Store;

beforeEach(() => {
  const { db, sqlite } = createDb(":memory:");
  store = createStore(db, sqlite);
});

describe("save", () => {
  test("returns the existing link rather than inserting a duplicate", () => {
    const first = store.save("https://example.com/post");
    const second = store.save("https://example.com/post/?utm_source=twitter");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.link.id).toBe(first.link.id);
    expect(store.list()).toHaveLength(1);
  });

  test("starts life pending so the caller can return immediately", () => {
    expect(store.save("https://example.com/a").link.status).toBe("pending");
  });
});

describe("search", () => {
  beforeEach(() => {
    const a = store.save("https://example.com/rust").link;
    store.markReady(a.id, {
      title: "Rust ownership explained",
      description: "Walks through borrow checker rules with worked examples.",
      siteName: "Example",
      imageUrl: null,
    });

    const b = store.save("https://other.test/pasta").link;
    store.markReady(b.id, {
      title: "Cacio e pepe",
      description: "A four-ingredient Roman pasta and where it goes wrong.",
      siteName: "Other",
      imageUrl: null,
    });
  });

  test("matches on title, description and prefix", () => {
    expect(store.search("ownership").map((l) => l.title)).toEqual(["Rust ownership explained"]);
    expect(store.search("borrow").map((l) => l.title)).toEqual(["Rust ownership explained"]);
    expect(store.search("past").map((l) => l.title)).toEqual(["Cacio e pepe"]);
  });

  test("reflects edits, because the FTS triggers follow updates", () => {
    const [link] = store.search("ownership");
    store.markReady(link!.id, { title: "Lifetimes", description: null, siteName: null, imageUrl: null });

    expect(store.search("ownership")).toHaveLength(0);
    expect(store.search("lifetimes")).toHaveLength(1);
  });

  test("drops a link out of the index when it is deleted", () => {
    const [link] = store.search("ownership");
    store.remove(link!.id);
    expect(store.search("ownership")).toHaveLength(0);
  });

  test("survives FTS5 syntax typed into the search box", () => {
    // Each of these is a syntax error if passed to MATCH unescaped.
    for (const query of ['"', "AND", "rust OR", "a*(b)", "-x", "^"]) {
      expect(() => store.search(query)).not.toThrow();
    }
  });
});

describe("toFtsQuery", () => {
  test("quotes each term and makes it a prefix match", () => {
    expect(toFtsQuery("rust ownership")).toBe('"rust"* "ownership"*');
  });

  test("returns null when nothing usable is left", () => {
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery('"*^')).toBeNull();
  });
});
