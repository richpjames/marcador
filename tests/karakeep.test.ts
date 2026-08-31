import { afterAll, describe, expect, test } from "bun:test";
import { fetchFromApi, mapBookmark, parseExport, type KarakeepBookmark } from "../src/karakeep.ts";
import { createDb } from "../src/db.ts";
import { createStore } from "../src/store.ts";

/** A realistic link bookmark, shaped like Karakeep's actual API response. */
function linkBookmark(overrides: Partial<KarakeepBookmark> = {}): KarakeepBookmark {
  return {
    id: "abc123",
    createdAt: "2025-03-14T09:26:53.000Z",
    title: null,
    summary: null,
    note: null,
    archived: false,
    favourited: false,
    tags: [{ name: "cooking" }],
    content: {
      type: "link",
      url: "https://example.com/pasta",
      title: "Cacio e pepe",
      description: "The classic Roman pasta.",
      imageUrl: "https://example.com/pasta.jpg",
      publisher: "Example Kitchen",
    },
    ...overrides,
  };
}

describe("mapBookmark", () => {
  test("carries across the fields marcador has a home for", () => {
    expect(mapBookmark(linkBookmark())).toEqual({
      url: "https://example.com/pasta",
      title: "Cacio e pepe",
      description: "The classic Roman pasta.",
      imageUrl: "https://example.com/pasta.jpg",
      siteName: "Example Kitchen",
      createdAt: Date.parse("2025-03-14T09:26:53.000Z"),
    });
  });

  test("prefers what the user wrote over what the crawler found", () => {
    const mapped = mapBookmark(
      linkBookmark({ title: "My own title", note: "Why I saved this", summary: "An AI summary" }),
    );

    expect(mapped!.title).toBe("My own title");
    // A hand-written note outranks a generated summary, which outranks the page.
    expect(mapped!.description).toBe("Why I saved this");
  });

  test("falls back through summary to the page's description", () => {
    expect(mapBookmark(linkBookmark({ summary: "An AI summary" }))!.description).toBe(
      "An AI summary",
    );
    expect(mapBookmark(linkBookmark())!.description).toBe("The classic Roman pasta.");
  });

  test("falls back to the host when Karakeep has no publisher", () => {
    const bookmark = linkBookmark();
    (bookmark.content as Record<string, unknown>).publisher = null;
    expect(mapBookmark(bookmark)!.siteName).toBe("example.com");
  });

  test("ignores blank strings rather than storing them", () => {
    const mapped = mapBookmark(linkBookmark({ title: "   ", summary: "" }));
    expect(mapped!.title).toBe("Cacio e pepe");
    expect(mapped!.description).toBe("The classic Roman pasta.");
  });

  test("returns null for the bookmark types marcador cannot hold", () => {
    expect(mapBookmark(linkBookmark({ content: { type: "text", text: "a note" } }))).toBeNull();
    expect(mapBookmark(linkBookmark({ content: { type: "asset", assetId: "x" } }))).toBeNull();
    expect(mapBookmark(linkBookmark({ content: { type: "unknown" } }))).toBeNull();
  });

  test("survives an unparseable date instead of dropping the link", () => {
    const mapped = mapBookmark(linkBookmark({ createdAt: "not a date" }));
    expect(mapped).not.toBeNull();
    expect(Number.isFinite(mapped!.createdAt)).toBe(true);
  });
});

describe("parseExport", () => {
  test("accepts the export file's { bookmarks: [...] } shape", () => {
    expect(parseExport({ bookmarks: [linkBookmark()] })).toHaveLength(1);
  });

  test("accepts a bare array, which is what a jq extract gives you", () => {
    expect(parseExport([linkBookmark()])).toHaveLength(1);
  });

  test("says so plainly when handed something else", () => {
    expect(() => parseExport({ nope: true })).toThrow(/Unrecognised export/);
    expect(() => parseExport("hello")).toThrow(/Unrecognised export/);
  });
});

// --- The API reader, against a stand-in Karakeep --------------------------

const pages: Record<string, unknown> = {
  "": { bookmarks: [linkBookmark({ id: "one" })], nextCursor: "cur2" },
  cur2: { bookmarks: [linkBookmark({ id: "two" })], nextCursor: null },
};

let receivedAuth = "";

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    receivedAuth = request.headers.get("authorization") ?? "";

    if (receivedAuth !== "Bearer test-key") {
      return new Response("Unauthorized", { status: 401 });
    }

    return Response.json(pages[url.searchParams.get("cursor") ?? ""]);
  },
});

afterAll(() => server.stop(true));

describe("fetchFromApi", () => {
  test("follows nextCursor until the pages run out", async () => {
    const collected = [];
    for await (const bookmark of fetchFromApi(server.url.origin, "test-key")) {
      collected.push(bookmark.id);
    }

    expect(collected).toEqual(["one", "two"]);
    expect(receivedAuth).toBe("Bearer test-key");
  });

  test("tolerates a trailing slash on the server URL", async () => {
    const collected = [];
    for await (const b of fetchFromApi(`${server.url.origin}/`, "test-key")) collected.push(b.id);
    expect(collected).toHaveLength(2);
  });

  test("names the actual problem when the key is wrong", async () => {
    const run = async () => {
      for await (const _ of fetchFromApi(server.url.origin, "wrong-key")) {
        /* drain */
      }
    };
    expect(run()).rejects.toThrow(/rejected the API key/);
  });
});

// --- Importing into the store --------------------------------------------

describe("importing into marcador", () => {
  test("keeps the original save date, so the list order survives the move", () => {
    const { db, sqlite } = createDb(":memory:");
    const store = createStore(db, sqlite);

    const older = mapBookmark(linkBookmark({ createdAt: "2024-01-01T00:00:00.000Z" }))!;
    const newer = mapBookmark(
      linkBookmark({ createdAt: "2025-06-01T00:00:00.000Z", content: { type: "link", url: "https://example.com/b" } }),
    )!;

    store.save(older.url, { createdAt: older.createdAt });
    store.save(newer.url, { createdAt: newer.createdAt });

    const listed = store.list();
    expect(listed[0]!.url).toBe("https://example.com/b");
    expect(listed[0]!.createdAt).toBe(Date.parse("2025-06-01T00:00:00.000Z"));
    expect(listed[1]!.createdAt).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  });

  test("re-running the import adds nothing the second time", () => {
    const { db, sqlite } = createDb(":memory:");
    const store = createStore(db, sqlite);
    const link = mapBookmark(linkBookmark())!;

    expect(store.save(link.url, { createdAt: link.createdAt }).created).toBe(true);
    expect(store.save(link.url, { createdAt: link.createdAt }).created).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  test("imported links are searchable straight away", () => {
    const { db, sqlite } = createDb(":memory:");
    const store = createStore(db, sqlite);
    const link = mapBookmark(linkBookmark())!;

    const { link: saved } = store.save(link.url, { createdAt: link.createdAt });
    store.markReady(saved.id, {
      title: link.title,
      description: link.description,
      imageUrl: link.imageUrl,
      siteName: link.siteName,
    });

    expect(store.search("cacio").map((l) => l.title)).toEqual(["Cacio e pepe"]);
    expect(store.search("roman")).toHaveLength(1);
  });
});
