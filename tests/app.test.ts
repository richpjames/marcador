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
