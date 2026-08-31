/**
 * Tracking parameters that identify the click, not the page. Stripping them
 * before storing means the same article shared from Twitter and from a
 * newsletter collapses into one saved link rather than two.
 */
const TRACKING_PARAMS = [
  /^utm_/,
  /^fbclid$/,
  /^gclid$/,
  /^mc_(cid|eid)$/,
  /^igshid$/,
  /^si$/,
  /^ref_?src$/,
  /^s$/,
];

/**
 * Canonical form used as the dedupe key. Deliberately conservative: it lowercases
 * the host, drops the fragment and tracking params, and trims a bare trailing
 * slash. It does *not* strip `www.` or force https, because for some sites those
 * genuinely are different pages.
 */
export function normaliseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
      url.searchParams.delete(key);
    }
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** Host shown under a link when the page gave us no site name. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
