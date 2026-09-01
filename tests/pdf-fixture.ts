/**
 * Minimal but genuinely valid PDFs, built here rather than committed as
 * binaries: a fixture you can read is a fixture you can trust, and it keeps the
 * repository free of opaque blobs.
 *
 * `pageTexts` becomes one page each, so a test can check which pages were read
 * by looking for text that only appears on a given one.
 */
export function pdfWithPages(pageTexts: string[]): Uint8Array {
  const CATALOG = 1;
  const PAGES = 2;
  const FONT = 3;
  /** Each page takes two objects: the page itself and its content stream. */
  const firstPage = 4;

  const pageIds = pageTexts.map((_, i) => firstPage + i * 2);
  const bodies = new Map<number, string>();

  bodies.set(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  bodies.set(
    PAGES,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
      `/Count ${pageTexts.length} >>`,
  );
  bodies.set(FONT, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i]!;
    const contentId = pageId + 1;
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;

    bodies.set(
      pageId,
      `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    bodies.set(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  const count = bodies.size;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (let id = 1; id <= count; id += 1) {
    offsets.push(pdf.length);
    pdf += `${id} 0 obj\n${bodies.get(id)}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count + 1} /Root ${CATALOG} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

/** A one-page PDF, which is all most tests need. */
export function tinyPdf(text = "Hello from marcador"): Uint8Array {
  return pdfWithPages([text]);
}
