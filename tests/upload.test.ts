import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { createStore, type Store } from "../src/store.ts";
import { createEnricher, type Enricher } from "../src/enrich.ts";
import { nullSummariser } from "../src/summarise.ts";
import { tinyPdf } from "./pdf-fixture.ts";

const BEARER = { authorization: "Bearer test-token" };

let app: Hono;
let store: Store;
let enricher: Enricher;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcador-uploads-"));
  const { db, sqlite } = createDb(":memory:");
  store = createStore(db, sqlite);
  enricher = createEnricher({ store, summariser: nullSummariser, filesDir: dir });
  app = createApp({ store, enricher, filesDir: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function upload(bytes: Uint8Array, name = "programme.pdf", type = "application/pdf") {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type }), name);

  return app.request("/api/files", { method: "POST", headers: BEARER, body: form });
}

describe("uploading a PDF", () => {
  test("saves it and reports it as created", async () => {
    const response = await upload(tinyPdf());

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.fileName).toBe("programme.pdf");
    expect(body.created).toBe(true);
    expect(String(body.url)).toMatch(/^\/files\/[0-9a-f]{64}\.pdf$/);
  });

  test("the same file twice is one link, not two", async () => {
    const first = await upload(tinyPdf());
    const second = await upload(tinyPdf(), "renamed.pdf");

    expect(first.status).toBe(201);
    // Named by the hash of the contents, so a rename is still the same file.
    expect(second.status).toBe(200);
    expect(store.list()).toHaveLength(1);
  });

  test("refuses anything that is not really a PDF, whatever it claims", async () => {
    const html = new TextEncoder().encode("<!doctype html><p>gotcha");
    const response = await upload(html, "totally.pdf", "application/pdf");

    expect(response.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  test("refuses an empty upload", async () => {
    const response = await upload(new Uint8Array(0), "empty.pdf");

    expect(response.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });
});

describe("serving an uploaded PDF", () => {
  test("hands it back with the original filename", async () => {
    const { url } = (await (await upload(tinyPdf())).json()) as { url: string };
    const response = await app.request(url, { headers: BEARER });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("programme.pdf");
  });

  test("needs authentication like everything else", async () => {
    const { url } = (await (await upload(tinyPdf())).json()) as { url: string };

    expect((await app.request(url)).status).toBe(401);
  });

  test("404s for a file that was never stored", async () => {
    const response = await app.request(`/files/${"b".repeat(64)}.pdf`, { headers: BEARER });

    expect(response.status).toBe(404);
  });
});

describe("enriching an uploaded PDF", () => {
  test("reads the file off disk and describes it from its text", async () => {
    const { id } = (await (await upload(tinyPdf())).json()) as { id: number };
    await enricher.idle();

    const link = store.get(id)!;
    expect(link.status).toBe("ready");
    // No AI key in the suite, so the title and page count are what land.
    expect(link.title).toBe("programme.pdf");
    expect(link.siteName).toBe("PDF · 1 page");
  });

  test("fails loudly when the file has gone missing from the volume", async () => {
    const { id } = (await (await upload(tinyPdf())).json()) as { id: number };
    rmSync(dir, { recursive: true, force: true });

    enricher.enqueue(id);
    await enricher.idle();

    expect(store.get(id)!.status).toBe("failed");
    expect(store.get(id)!.error).toContain("missing");
  });
});

describe("deleting an uploaded PDF", () => {
  test("takes the file off the volume too", async () => {
    const { id, url } = (await (await upload(tinyPdf())).json()) as { id: number; url: string };
    const stored = join(dir, url.slice("/files/".length));

    expect(await Bun.file(stored).exists()).toBe(true);

    const response = await app.request(`/api/links/${id}`, { method: "DELETE", headers: BEARER });

    expect(response.status).toBe(200);
    expect(store.get(id)).toBeUndefined();
    // Otherwise the bytes outlive the row and the volume fills with PDFs
    // nothing references.
    expect(await Bun.file(stored).exists()).toBe(false);
  });

  test("still deletes the link when the file has already gone", async () => {
    const { id } = (await (await upload(tinyPdf())).json()) as { id: number };
    rmSync(dir, { recursive: true, force: true });

    const response = await app.request(`/api/links/${id}`, { method: "DELETE", headers: BEARER });

    expect(response.status).toBe(200);
    expect(store.get(id)).toBeUndefined();
  });

  test("deleting an ordinary link touches no files", async () => {
    const { id, url } = (await (await upload(tinyPdf())).json()) as { id: number; url: string };
    const stored = join(dir, url.slice("/files/".length));
    const link = store.save("https://example.com/ordinary").link;

    await app.request(`/api/links/${link.id}`, { method: "DELETE", headers: BEARER });

    expect(store.get(id)).toBeDefined();
    expect(await Bun.file(stored).exists()).toBe(true);
  });
});
