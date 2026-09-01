/**
 * Cache-busting stamps for the static files.
 *
 * The stylesheet and script are served with a one-hour cache, which is right
 * for a file that rarely changes and wrong for the hour after a deploy that
 * changes it: the new markup arrives against the old CSS and the release looks
 * broken, or worse, looks like it did nothing.
 *
 * Stamping the URL with the file's modification time means a changed file is a
 * new URL. Inside the image that time is the build's COPY, so it is stable for
 * every request a given release serves.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

const STATIC_DIR = join(import.meta.dir, "..", "public");

function stamp(name: string): string {
  try {
    return Math.trunc(statSync(join(STATIC_DIR, name)).mtimeMs).toString(36);
  } catch {
    // A missing file is the static handler's problem to report, not this one's.
    return "0";
  }
}

export const styleVersion = stamp("styles.css");
export const scriptVersion = stamp("app.js");
