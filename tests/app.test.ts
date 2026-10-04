import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { createStore, type Store } from "../src/store.ts";
import { createEnricher } from "../src/enrich.ts";
import { nullSummariser } from "../src/summarise.ts";
import type { PageMetadata } from "../src/metadata.ts";

const BEARER = { authorization: "Bearer test-token" };
const BROWSER = { accept: "text/html" };

const blankPage: PageMetadata = {
  title: null,
  imageUrl: null,
  siteName: null,
  pageDescription: null,
  excerpt: "",
};

let app: Hono;
let store: Store;

beforeEach(() => {
  const { db, sqlite } = createDb(":memory:");
  store = createStore(db, sqlite);
  const enricher = createEnricher({
    store,
    summariser: nullSummariser,
    fetchPage: async () => blankPage,
  });
  app = createApp({ store, enricher });
});

/** Signs in and returns the session cookie, the way a browser would. */
async function signIn(): Promise<string> {
  const response = await app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "signin" },
    body: new URLSearchParams({ password: "test-password", next: "/" }),
  });

  return response.headers.get("set-cookie")!.split(";")[0]!;
}

describe("auth", () => {
  test("sends a signed-out browser to the login page", async () => {
    const response = await app.request("/", { headers: BROWSER });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2F");
  });

  test("answers a signed-out API client with 401, not a redirect", async () => {
    expect((await app.request("/api/links")).status).toBe(401);
  });

  test("health check stays outside the auth wall for Coolify", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
  });

  test("a bearer token is enough for the Share Extension", async () => {
    expect((await app.request("/api/links", { headers: BEARER })).status).toBe(200);
  });

  test("rejects a wrong bearer token", async () => {
    const response = await app.request("/api/links", { headers: { authorization: "Bearer nope" } });
    expect(response.status).toBe(401);
  });

  test("a session cookie unlocks the list", async () => {
    const cookie = await signIn();
    const response = await app.request("/", { headers: { ...BROWSER, cookie } });
    expect(response.status).toBe(200);
  });

  test("rejects the wrong password", async () => {
    const response = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "wrong" },
      body: new URLSearchParams({ password: "guess", next: "/" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("throttles repeated guesses", async () => {
    const attempt = () =>
      app.request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "bruteforce" },
        body: new URLSearchParams({ password: "guess", next: "/" }),
      });

    for (let i = 0; i < 5; i++) await attempt();
    expect((await attempt()).status).toBe(429);
  });

  test("will not redirect off-site after login", async () => {
    const response = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "openredirect" },
      body: new URLSearchParams({ password: "test-password", next: "https://evil.example" }),
    });
    expect(response.headers.get("location")).toBe("/");
  });
});

describe("POST /api/links", () => {
  test("creates a link and reports it as new", async () => {
    const response = await app.request("/api/links", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/a" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: true, status: "pending" });
  });

  test("reports a re-share as an existing link with 200", async () => {
    const post = () =>
      app.request("/api/links", {
        method: "POST",
        headers: { ...BEARER, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/a" }),
      });

    await post();
    const second = await post();

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: false });
    expect(store.list()).toHaveLength(1);
  });

  test("rejects a non-http URL with a readable message", async () => {
    const response = await app.request("/api/links", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ url: "javascript:alert(1)" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/scheme/);
  });
});

describe("the list page", () => {
  test("escapes a hostile title scraped off the web", async () => {
    const { link } = store.save("https://example.com/xss");
    store.markReady(link.id, {
      title: '<script>alert(1)</script>',
      description: null,
      siteName: null,
      imageUrl: null,
    });

    const cookie = await signIn();
    const body = await (await app.request("/", { headers: { ...BROWSER, cookie } })).text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  test("filters to search hits when given ?q=", async () => {
    const a = store.save("https://example.com/rust").link;
    store.markReady(a.id, { title: "Rust ownership", description: null, siteName: null, imageUrl: null });
    const b = store.save("https://example.com/pasta").link;
    store.markReady(b.id, { title: "Cacio e pepe", description: null, siteName: null, imageUrl: null });

    const cookie = await signIn();
    const body = await (await app.request("/?q=rust", { headers: { ...BROWSER, cookie } })).text();

    expect(body).toContain("Rust ownership");
    expect(body).not.toContain("Cacio e pepe");
  });

  test("deletes through the form post", async () => {
    const { link } = store.save("https://example.com/gone");
    const cookie = await signIn();

    const response = await app.request(`/links/${link.id}/delete`, {
      method: "POST",
      headers: { ...BROWSER, cookie },
    });

    expect(response.status).toBe(302);
    expect(store.list()).toHaveLength(0);
  });
});

describe("lists", () => {
  test("makes a list from the nav form and shows it as a chip", async () => {
    const cookie = await signIn();

    const response = await app.request("/lists", {
      method: "POST",
      headers: { ...BROWSER, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Tech", icon: "📺" }),
    });

    expect(response.status).toBe(302);

    const body = await (await app.request("/", { headers: { ...BROWSER, cookie } })).text();
    expect(body).toContain("Tech");
    expect(body).toContain("📺");
  });

  test("renames a list from the nav form and returns you to it", async () => {
    const cookie = await signIn();
    const list = store.createList("Tech");

    const response = await app.request(`/lists/${list.id}/rename`, {
      method: "POST",
      headers: {
        ...BROWSER,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        referer: `https://marcador.example/?list=${list.id}`,
      },
      body: new URLSearchParams({ name: "Reading" }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/?list=${list.id}`);
    expect(store.allLists().map((list) => list.name)).toEqual(["Reading"]);
  });

  test("a rejected rename bounces back to the list with the error", async () => {
    const cookie = await signIn();
    const tech = store.createList("Tech");
    store.createList("Clothes");

    const response = await app.request(`/lists/${tech.id}/rename`, {
      method: "POST",
      headers: { ...BROWSER, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Clothes" }),
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(location).toBe(
      `/?list=${tech.id}&error=${encodeURIComponent("A list called that already exists.")}`,
    );

    const body = await (await app.request(location, { headers: { ...BROWSER, cookie } })).text();
    expect(body).toContain("A list called that already exists.");
    expect(store.allLists().map((list) => list.name).sort()).toEqual(["Clothes", "Tech"]);
  });

  test("files a link through the card's select", async () => {
    const cookie = await signIn();
    const list = store.createList("Tech");
    const { link } = store.save("https://example.com/rust");

    const response = await app.request(`/links/${link.id}/list`, {
      method: "POST",
      headers: { ...BROWSER, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ list: String(list.id) }),
    });

    expect(response.status).toBe(302);
    expect(store.get(link.id)!.listId).toBe(list.id);
  });

  test("an empty value unfiles the link", async () => {
    const cookie = await signIn();
    const list = store.createList("Tech");
    const { link } = store.save("https://example.com/rust");
    store.assign(link.id, list.id);

    await app.request(`/links/${link.id}/list`, {
      method: "POST",
      headers: { ...BROWSER, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ list: "" }),
    });

    expect(store.get(link.id)!.listId).toBeNull();
  });

  test("returns you to the list you were filtered to, not the top of All", async () => {
    const cookie = await signIn();
    const list = store.createList("Tech");
    const { link } = store.save("https://example.com/rust");

    const response = await app.request(`/links/${link.id}/list`, {
      method: "POST",
      headers: {
        ...BROWSER,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        referer: `https://marcador.example/?list=${list.id}`,
      },
      body: new URLSearchParams({ list: String(list.id) }),
    });

    expect(response.headers.get("location")).toBe(`/?list=${list.id}`);
  });

  test("never redirects off-site, whatever the referer claims", async () => {
    const cookie = await signIn();
    const { link } = store.save("https://example.com/rust");

    const response = await app.request(`/links/${link.id}/list`, {
      method: "POST",
      headers: {
        ...BROWSER,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        referer: "https://evil.example/steal",
      },
      body: new URLSearchParams({ list: "" }),
    });

    // Only the path is reused, so an attacker-controlled host cannot survive.
    expect(response.headers.get("location")).toBe("/steal");
  });

  test("?list= narrows the page to that list", async () => {
    const cookie = await signIn();
    const list = store.createList("Tech");
    const filed = store.save("https://example.com/filed").link;
    store.save("https://example.com/unfiled");
    store.markReady(filed.id, { title: "Filed away" });
    store.assign(filed.id, list.id);

    const body = await (
      await app.request(`/?list=${list.id}`, { headers: { ...BROWSER, cookie } })
    ).text();

    expect(body).toContain("Filed away");
    expect(body).not.toContain("example.com/unfiled");
  });

  test("serves the lists over the API for the share extension", async () => {
    store.createList("Tech", "📺");
    const response = await app.request("/api/lists", { headers: BEARER });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lists: [{ id: expect.any(Number), name: "Tech", icon: "📺", createdAt: expect.any(Number), count: 0 }],
    });
  });

  test("files a shared link under the list the share sheet picked", async () => {
    const list = store.createList("Tech");

    const response = await share("https://example.com/a", list.id);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: true, listId: list.id });
    expect(store.list({ listId: list.id })).toHaveLength(1);
  });

  test("leaves a share with no list picked unfiled", async () => {
    const response = await share("https://example.com/a");

    expect(await response.json()).toMatchObject({ listId: null });
  });

  test("moves an already-saved link when the share picks a different list", async () => {
    const tech = store.createList("Tech");
    const clothes = store.createList("Clothes");

    await share("https://example.com/a", tech.id);
    const second = await share("https://example.com/a", clothes.id);

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: false, listId: clothes.id });
    expect(store.list()).toHaveLength(1);
  });

  test("re-sharing without a list leaves the link where it was filed", async () => {
    const list = store.createList("Tech");

    await share("https://example.com/a", list.id);
    await share("https://example.com/a");

    expect(store.list({ listId: list.id })).toHaveLength(1);
  });

  test("refuses a share naming a list that no longer exists", async () => {
    const list = store.createList("Tech");
    store.removeList(list.id);

    const response = await share("https://example.com/a", list.id);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/No such list/);
    expect(store.list()).toHaveLength(0);
  });

  test("refuses a list id that is not a number", async () => {
    const response = await share("https://example.com/a", "everything" as unknown as number);

    expect(response.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });
});

/** A share-sheet save, with or without a list picked. */
function share(url: string, listId?: number) {
  return app.request("/api/links", {
    method: "POST",
    headers: { ...BEARER, "content-type": "application/json" },
    body: JSON.stringify(listId === undefined ? { url } : { url, listId }),
  });
}
