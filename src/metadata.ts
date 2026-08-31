/**
 * Fetches a page and pulls out what a bookmark needs: a title, an image, the
 * site's own name, and enough body text for the summariser to work from.
 *
 * Deliberately regex-based rather than a DOM parse. We only ever read a handful
 * of `<meta>` tags and a text excerpt, and real-world bookmark targets include
 * plenty of malformed HTML that a strict parser would reject outright.
 */

export interface PageMetadata {
  title: string | null;
  imageUrl: string | null;
  siteName: string | null;
  /** OG/meta description, if the page supplied one. */
  pageDescription: string | null;
  /** Plain-text excerpt of the body, for the summariser. */
  excerpt: string;
}

/** Pages are fetched with a real-browser UA; plenty of sites 403 anything else. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 marcador/0.1";

const FETCH_TIMEOUT_MS = 12_000;
/** Stop reading after this much HTML; the head and lede are long past by then. */
const MAX_BYTES = 1_500_000;
/** Excerpt cap, chosen to stay comfortably inside a cheap Mistral call. */
const MAX_EXCERPT_CHARS = 6_000;

export async function fetchMetadata(url: string): Promise<PageMetadata> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    // A PDF or an image is still a legitimate bookmark; there is just nothing
    // to scrape, so fall back to the URL itself and let the summariser skip it.
    return { title: null, imageUrl: null, siteName: null, pageDescription: null, excerpt: "" };
  }

  const html = (await response.text()).slice(0, MAX_BYTES);
  // Redirects mean the final URL, not the requested one, is what relative
  // image paths resolve against.
  const baseUrl = response.url || url;

  return {
    title: firstOf(
      meta(html, "og:title"),
      meta(html, "twitter:title"),
      tagText(html, "title"),
    ),
    imageUrl: resolve(
      firstOf(meta(html, "og:image"), meta(html, "og:image:url"), meta(html, "twitter:image")),
      baseUrl,
    ),
    siteName: firstOf(meta(html, "og:site_name"), meta(html, "application-name")),
    pageDescription: firstOf(
      meta(html, "og:description"),
      meta(html, "twitter:description"),
      meta(html, "description"),
    ),
    excerpt: textExcerpt(html),
  };
}

function firstOf(...values: (string | null)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Matches `<meta property="og:title" content="...">` in either attribute order,
 * and accepts `name=` as well as `property=` because usage in the wild is split.
 */
function meta(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*\\scontent\\s*=\\s*["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*\\s(?:property|name)\\s*=\\s*["']${escaped}["']`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return null;
}

function tagText(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html);
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : null;
}

/** OG images are often site-relative; the summary card needs an absolute URL. */
function resolve(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Strips the page down to running text. Script, style, nav and footer content is
 * removed first so the summariser sees the article rather than the cookie banner.
 */
function textExcerpt(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
