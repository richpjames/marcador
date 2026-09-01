/**
 * Pulling a title and some text out of a PDF.
 *
 * Uses unpdf (a pdf.js build with the browser bits stripped) rather than
 * shelling out to poppler: a system binary would have to be installed in the
 * image *and* on every machine anyone develops on, and its absence would show
 * up as a runtime failure on one of them rather than a failed install.
 */

import { getDocumentProxy } from "unpdf";

export interface PdfContents {
  /** The PDF's own title, when it has one worth using. */
  title: string | null;
  /** Plain text for the summariser, capped like the HTML excerpt is. */
  excerpt: string;
  /** Pages in the document, not pages read — the card shows the real length. */
  pageCount: number;
  /** How many of them were actually read. */
  pagesRead: number;
}

/**
 * Only the front of a PDF is read.
 *
 * What a document is about is on its first few pages; page 90 of a camera
 * manual is a menu reference that would only crowd the useful part out of the
 * excerpt. Stopping at five also means a 500-page scan costs the same to
 * describe as a leaflet, because the pages beyond it are never parsed at all —
 * this is a limit on the work, not a truncation after it.
 */
const MAX_PAGES = 5;

/** Matches the HTML excerpt cap, so a PDF costs the same as a page to describe. */
const MAX_EXCERPT_CHARS = 6_000;

export async function readPdf(bytes: Uint8Array): Promise<PdfContents> {
  const pdf = await getDocumentProxy(bytes);
  const pageCount = pdf.numPages;
  const pagesRead = Math.min(pageCount, MAX_PAGES);

  const pages: string[] = [];
  for (let number = 1; number <= pagesRead; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();

    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
  }

  return {
    title: await titleOf(pdf),
    // PDF text arrives with the layout's line breaks and column gaps baked in;
    // collapsing whitespace turns it back into prose the model can read.
    excerpt: pages.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS),
    pageCount,
    pagesRead,
  };
}

/**
 * Producers fill the title field with all sorts of rubbish — the source
 * filename, "untitled", the name of the program that made it — so anything that
 * looks like a filename is rejected in favour of the real one.
 */
async function titleOf(pdf: Awaited<ReturnType<typeof getDocumentProxy>>): Promise<string | null> {
  try {
    const { info } = (await pdf.getMetadata()) as { info?: { Title?: unknown } };
    const title = typeof info?.Title === "string" ? info.Title.trim() : "";

    if (!title || /\.(pdf|docx?|pages|indd|ai)$/i.test(title)) return null;
    return title;
  } catch {
    // A PDF with no metadata dictionary at all is perfectly legal.
    return null;
  }
}

/** True if these bytes start with the PDF magic number. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}
