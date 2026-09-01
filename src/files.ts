/**
 * Where uploaded PDFs live.
 *
 * Beside the database on the same persistent volume, so one Coolify volume
 * still holds everything and a backup of that directory is a backup of the
 * whole app. Files are named by the SHA-256 of their contents, which makes
 * uploading the same PDF twice a no-op rather than a second copy.
 *
 * The directory is passed in rather than read from config here, so tests can
 * point at a temporary one instead of writing into the repository.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only the hashed names this module writes; never a path from a request. */
const STORED_NAME = /^[0-9a-f]{64}\.pdf$/;

/** The uploads directory that goes with a database path. */
export function filesDirFor(databasePath: string): string {
  return join(dirname(databasePath), "files");
}

export async function storePdf(bytes: Uint8Array, dir: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const name = `${hasher.digest("hex")}.pdf`;

  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, name), bytes);

  return name;
}

/**
 * Resolves a stored name to a path. Returns null for anything that is not one
 * of our own hashed names, so a crafted `../../etc/passwd` never reaches the
 * filesystem — a whitelist rather than an attempt to sanitise the input.
 */
export function pathForStoredFile(name: string, dir: string): string | null {
  if (!STORED_NAME.test(name)) return null;
  return join(dir, name);
}

/** The public URL of a stored file, which is also its dedupe key in `links`. */
export function urlForStoredFile(name: string): string {
  return `/files/${name}`;
}

/** The stored name back out of that URL, or null if it is an ordinary link. */
export function storedNameFromUrl(url: string): string | null {
  const name = url.startsWith("/files/") ? url.slice("/files/".length) : null;
  return name && STORED_NAME.test(name) ? name : null;
}
