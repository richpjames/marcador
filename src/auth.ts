import { createHmac, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "./config.ts";

/**
 * Single-user auth, in two flavours:
 *
 *   * a signed session cookie for the browser and the Capacitor webview, and
 *   * a static `Authorization: Bearer` token for the Share Extension, which has
 *     no cookie jar of its own and must work while the app is not running.
 *
 * There is no user table because there is exactly one user. The password lives
 * in the environment, so rotating it is a Coolify redeploy rather than a
 * migration.
 */

const COOKIE_NAME = "marcador_session";

/** Compares without leaking length or position through timing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so hash first to fix the width.
  return timingSafeEqual(sha(left), sha(right));
}

function sha(value: Buffer): Buffer {
  return createHmac("sha256", config.secret).update(value).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", config.secret).update(payload).digest("hex");
}

/** Cookie value is `<expiry-ms>.<hmac>` — stateless, so restarts keep you logged in. */
function issue(): string {
  const expiresAt = Date.now() + config.sessionMaxAgeSeconds * 1000;
  return `${expiresAt}.${sign(String(expiresAt))}`;
}

function verify(cookie: string | undefined): boolean {
  if (!cookie) return false;

  const [expiry, signature] = cookie.split(".");
  if (!expiry || !signature) return false;
  if (!safeEqual(signature, sign(expiry))) return false;

  return Number(expiry) > Date.now();
}

export function startSession(c: Context): void {
  setCookie(c, COOKIE_NAME, issue(), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: config.sessionMaxAgeSeconds,
    // Coolify terminates TLS in front of the container, so trust its header
    // rather than hard-coding `secure` and locking out plain-HTTP local dev.
    secure: c.req.header("x-forwarded-proto") === "https",
  });
}

export function endSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export function isAuthenticated(c: Context): boolean {
  if (verify(getCookie(c, COOKIE_NAME))) return true;

  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 && safeEqual(token, config.token);
}

export function checkPassword(candidate: string): boolean {
  return candidate.length > 0 && safeEqual(candidate, config.password);
}

/** Redirects browsers to the login page; answers API clients with 401 JSON. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (isAuthenticated(c)) return next();

  const wantsHtml = (c.req.header("accept") ?? "").includes("text/html");
  if (wantsHtml) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);

  return c.json({ error: "Unauthorized" }, 401);
};

/**
 * Crude per-process throttle on the login form. A public Coolify domain will
 * get drive-by password guessing, and 5 attempts a minute makes an online
 * brute force pointless without adding a dependency or any shared state.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
