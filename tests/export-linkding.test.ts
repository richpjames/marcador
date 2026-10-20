import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";

/**
 * Runs scripts/export-linkding.ts as a subprocess against a fixture marcador
 * database and a mock of linkding's REST API, then checks what arrived. The
 * mock is deliberately picky about the Authorization header — that is the one
 * thing a lenient mock would let drift.
 */

const dbPath = join(import.meta.dir, `marcador-export-test-${process.pid}.db`);

// A flaky URL linkding rejects, and an existing one it reports as updated —
// the script must survive the first and count the second separately.
const FULL = { url: "https://example.com/full", title: "A full link", description: "One sentence." };
const BARE = { url: "https://example.com/bare" };
const EXISTING = { url: "https://example.com/exists" };
const FLAKY = { url: "https://example.com/flaky" };
const PDF = { url: "https://example.com/upload.pdf" };

interface Received {
  authorization: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

const received: Received[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!request.url.endsWith("/api/bookmarks/")) {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    received.push({
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body,
    });
    const status = body.url === FLAKY.url ? 500 : body.url === EXISTING.url ? 200 : 201;
    return Response.json({}, { status });
  },
});

afterAll(() => {
  server.stop(true);
  for (const suffix of ["", "-wal", "-shm"]) {
    Bun.file(dbPath + suffix).unlink?.().catch(() => {});
  }
});

describe("export-linkding", () => {
  test("sends marcador's links to linkding, keeping dates, tags, and nothing else", async () => {
    const db = openDatabase(dbPath);
    db.run(`insert into lists (name, icon, created_at) values ('Reading', null, 1)`);
    db.run(
      `insert into links (url, title, description, status, created_at, list_id, kind)
       values ('${FULL.url}', '${FULL.title}', '${FULL.description}', 'ready', 1700000000000, 1, 'link')`,
    );
    // A link whose enrichment failed: no title or description, no list.
    db.run(
      `insert into links (url, status, created_at, kind)
       values ('${BARE.url}', 'failed', 1700000001000, 'link')`,
    );
    db.run(
      `insert into links (url, status, created_at, kind)
       values ('${EXISTING.url}', 'ready', 1700000002000, 'link')`,
    );
    db.run(
      `insert into links (url, status, created_at, kind)
       values ('${FLAKY.url}', 'ready', 1700000003000, 'link')`,
    );
    db.run(
      `insert into links (url, status, created_at, kind, file_name, file_size)
       values ('${PDF.url}', 'ready', 1700000004000, 'pdf', 'upload.pdf', 10)`,
    );
    db.close();

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "..", "scripts", "export-linkding.ts"),
        "--db",
        dbPath,
        "--to",
        `http://localhost:${server.port}`,
        "--token",
        "test-token-1",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

    expect(exitCode).toBe(1); // the flaky link failed, so the export reports it
    expect(stdout).toContain("(2 created, 1 updated, 1 failed)");
    expect(stdout).toContain("skipped 1 PDF(s)");

    // The PDF never left marcador.
    const urls = received.map((entry) => entry.body.url);
    expect(urls).not.toContain(PDF.url);
    expect(urls).toEqual([FULL.url, BARE.url, EXISTING.url, FLAKY.url]);

    for (const entry of received) {
      expect(entry.authorization).toBe("Token test-token-1");
      expect(entry.contentType).toBe("application/json");
    }

    const full = received[0]!.body;
    expect(full).toEqual({
      url: FULL.url,
      title: FULL.title,
      description: FULL.description,
      date_added: "2023-11-14T22:13:20.000Z",
      tag_names: ["Reading"],
    });

    // Bare links carry only the date; linkding scrapes the rest itself.
    expect(received[1]!.body).toEqual({
      url: BARE.url,
      date_added: "2023-11-14T22:13:21.000Z",
    });
  });
});
