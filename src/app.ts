import { Hono, type Context } from "hono";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { Enricher } from "./enrich.ts";
import { layout } from "./views/layout.ts";
import { listPage } from "./views/list.ts";
import { loginPage } from "./views/login.ts";
import {
  checkPassword,
  clearAttempts,
  endSession,
  requireAuth,
  startSession,
  tooManyAttempts,
} from "./auth.ts";

export interface AppOptions {
  store: Store;
  enricher: Enricher;
}

const STATIC_DIR = join(import.meta.dir, "public");

export function createApp({ store, enricher }: AppOptions) {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  /** Coolify's container health check. Deliberately outside the auth wall. */
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Served by hand rather than with `serveStatic` so the paths resolve from the
  // module directory, which is stable whatever working directory the container
  // starts in.
  app.get("/static/:file", async (c) => {
    const name = c.req.param("file");
    if (name.includes("/") || name.includes("..")) return c.notFound();

    const file = Bun.file(join(STATIC_DIR, name));
    if (!(await file.exists())) return c.notFound();

    return new Response(file, {
      headers: { "cache-control": "public, max-age=3600" },
    });
  });

  app.get("/login", (c) =>
    c.html(
      layout({
        title: "Sign in · marcador",
        bare: true,
        body: loginPage({ next: c.req.query("next") ?? "/" }),
      }),
    ),
  );

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const password = String(form.password ?? "");
    const next = safeNext(String(form.next ?? "/"));

    // Keyed by forwarded IP where Coolify supplies one, so one noisy client
    // cannot lock the others out.
    const key = c.req.header("x-forwarded-for") ?? "local";

    if (tooManyAttempts(key)) {
      return c.html(
        layout({
          title: "Sign in · marcador",
          bare: true,
          body: loginPage({ next, error: "Too many attempts. Wait a minute." }),
        }),
        429,
      );
    }

    if (!checkPassword(password)) {
      return c.html(
        layout({
          title: "Sign in · marcador",
          bare: true,
          body: loginPage({ next, error: "Wrong password." }),
        }),
        401,
      );
    }

    clearAttempts(key);
    startSession(c);
    return c.redirect(next);
  });

  app.post("/logout", (c) => {
    endSession(c);
    return c.redirect("/login");
  });

  // -------------------------------------------------------------------------
  // Everything below needs a session cookie or a bearer token
  // -------------------------------------------------------------------------

  app.use("*", requireAuth);

  app.get("/", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const lists = store.allLists();
    const activeList = lists.find((list) => list.id === Number(c.req.query("list")));
    const listId = activeList?.id;

    const items = query ? store.search(query, { listId }) : store.list({ listId });

    return c.html(
      layout({
        title: pageTitle(query, activeList?.name),
        body: listPage({
          items,
          lists,
          activeList,
          total: store.count(),
          query,
          error: c.req.query("error"),
        }),
      }),
    );
  });

  app.post("/lists", async (c) => {
    const form = await c.req.parseBody();

    try {
      store.createList(String(form.name ?? ""), String(form.icon ?? "") || null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not make that list.";
      return c.redirect(`/?error=${encodeURIComponent(message)}`);
    }

    return c.redirect(backTo(c));
  });

  app.post("/lists/:id/delete", (c) => {
    // The links stay; `on delete set null` unfiles them.
    store.removeList(Number(c.req.param("id")));
    return c.redirect("/");
  });

  /** Files one link under a list, or unfiles it when the value is empty. */
  app.post("/links/:id/list", async (c) => {
    const form = await c.req.parseBody();
    const raw = String(form.list ?? "");

    store.assign(Number(c.req.param("id")), raw === "" ? null : Number(raw));
    return c.redirect(backTo(c));
  });

  /** Browser form post. Redirects back to the list. */
  app.post("/links", async (c) => {
    const form = await c.req.parseBody();
    const result = saveAndEnqueue(String(form.url ?? ""));

    return c.redirect(result.ok ? "/" : `/?error=${encodeURIComponent(result.error)}`);
  });

  app.post("/links/:id/delete", (c) => {
    store.remove(Number(c.req.param("id")));
    return c.redirect("/");
  });

  // -------------------------------------------------------------------------
  // JSON API — the Share Extension and any Shortcuts talk to this
  // -------------------------------------------------------------------------

  app.post("/api/links", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const result = saveAndEnqueue(String((body as { url?: unknown }).url ?? ""));

    if (!result.ok) return c.json({ error: result.error }, 400);

    // 200 rather than 201 on a duplicate, so the extension can say "already
    // saved" instead of reporting a second save that did not happen.
    return c.json(
      { id: result.link.id, url: result.link.url, status: result.link.status, created: result.created },
      result.created ? 201 : 200,
    );
  });

  app.get("/api/links", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const listId = c.req.query("list") ? Number(c.req.query("list")) : undefined;

    return c.json({ links: query ? store.search(query, { listId }) : store.list({ listId }) });
  });

  app.get("/api/lists", (c) => c.json({ lists: store.allLists() }));

  /** Lets the list poll a pending card until its description lands. */
  app.get("/api/links/:id", (c) => {
    const link = store.get(Number(c.req.param("id")));
    return link ? c.json(link) : c.json({ error: "Not found" }, 404);
  });

  app.delete("/api/links/:id", (c) => {
    const removed = store.remove(Number(c.req.param("id")));
    return removed ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  function saveAndEnqueue(url: string) {
    if (!url.trim()) return { ok: false as const, error: "No URL given." };

    try {
      const { link, created } = store.save(url);
      // Only enqueue new links: re-sharing something already saved should not
      // spend another Mistral call re-describing it.
      if (created) enricher.enqueue(link.id);

      return { ok: true as const, link, created };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Could not save that URL.",
      };
    }
  }

  return app;
}

/** Only ever redirect within this app — never to an attacker-supplied host. */
function safeNext(next: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function pageTitle(query: string, listName?: string): string {
  if (query) return `${query} · marcador`;
  return listName ? `${listName} · marcador` : "marcador";
}

/**
 * Sends a form post back to the view it came from, so filing a link while
 * filtered to "Tech" does not bounce you back to the top of "All". Only the
 * path and query are reused, never the host, so this cannot leave the app.
 */
function backTo(c: Context): string {
  const referer = c.req.header("referer");
  if (!referer) return "/";

  try {
    const { pathname, search } = new URL(referer);
    return safeNext(`${pathname}${search}`);
  } catch {
    return "/";
  }
}
