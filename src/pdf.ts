/**
 * Pulling a title and some text out of a PDF.
 *
 * Uses unpdf (a pdf.js build with the browser bits stripped) rather than
 * shelling out to poppler: a system binary would have to be installed in the
 * image *and* on every machine anyone develops on, and its absence would show
 * up as a runtime failure on one of them rather than a failed install.
 */

import { extractText, getDocumentProxy } from "unpdf";

export interface PdfContents {
  /** The PDF's own title, when it has one worth using. */
  title: string | null;
  /** Plain text for the summariser, capped like the HTML excerpt is. */
  excerpt: string;
  pageCount: number;
}

/** Matches the HTML excerpt cap, so a PDF costs the same as a page to describe. */
const MAX_EXCERPT_CHARS = 6_000;

export async function readPdf(bytes: Uint8Array): Promise<PdfContents> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });

  return {
    title: await titleOf(pdf),
    // PDF text arrives with the layout's line breaks and column gaps baked in;
    // collapsing whitespace turns it back into prose the model can read.
    excerpt: String(text).replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS),
    pageCount: totalPages,
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
