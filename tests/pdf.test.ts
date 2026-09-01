import { describe, expect, test } from "bun:test";
import { looksLikePdf, readPdf } from "../src/pdf.ts";
import { storedNameFromUrl, urlForStoredFile, pathForStoredFile } from "../src/files.ts";
import { pdfWithPages, tinyPdf } from "./pdf-fixture.ts";

describe("readPdf", () => {
  test("pulls the text out for the summariser", async () => {
    const { excerpt, pageCount } = await readPdf(tinyPdf());

    expect(excerpt).toBe("Hello from marcador");
    expect(pageCount).toBe(1);
  });

  test("has no title when the PDF carries no metadata", async () => {
    expect((await readPdf(tinyPdf())).title).toBeNull();
  });

  test("reads at most the first five pages", async () => {
    const pages = Array.from({ length: 9 }, (_, i) => `Page number ${i + 1} content`);
    const { pageCount, pagesRead, excerpt } = await readPdf(pdfWithPages(pages));

    // The card still reports the document's real length.
    expect(pageCount).toBe(9);
    expect(pagesRead).toBe(5);

    expect(excerpt).toContain("Page number 1 content");
    expect(excerpt).toContain("Page number 5 content");
    // Anything past the cap is never parsed, so it cannot reach the model.
    expect(excerpt).not.toContain("Page number 6 content");
    expect(excerpt).not.toContain("Page number 9 content");
  });

  test("reads every page of a document shorter than the cap", async () => {
    const { pageCount, pagesRead, excerpt } = await readPdf(
      pdfWithPages(["First page here", "Second page here"]),
    );

    expect(pageCount).toBe(2);
    expect(pagesRead).toBe(2);
    expect(excerpt).toContain("Second page here");
  });

  test("rejects bytes that are not a PDF", async () => {
    expect(readPdf(new TextEncoder().encode("<html>not a pdf</html>"))).rejects.toThrow();
  });
});

describe("looksLikePdf", () => {
  test("accepts a real PDF and refuses anything else", () => {
    expect(looksLikePdf(tinyPdf())).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("%PDF"))).toBe(false);
    expect(looksLikePdf(new TextEncoder().encode("<!doctype html>"))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });
});

describe("stored file paths", () => {
  const hash = "a".repeat(64);

  test("round-trips a stored name through its URL", () => {
    expect(storedNameFromUrl(urlForStoredFile(`${hash}.pdf`))).toBe(`${hash}.pdf`);
  });

  test("treats an ordinary link as not a file", () => {
    expect(storedNameFromUrl("https://example.com/a.pdf")).toBeNull();
  });

  test("refuses any name it did not write, so traversal cannot resolve", () => {
    for (const name of ["../../etc/passwd", "..%2Fsecret.pdf", "index.pdf", `${hash}.exe`, ""]) {
      expect(pathForStoredFile(name, "/data/files")).toBeNull();
      expect(storedNameFromUrl(`/files/${name}`)).toBeNull();
    }
  });

  test("resolves a name it did write", () => {
    expect(pathForStoredFile(`${hash}.pdf`, "/data/files")).toBe(`/data/files/${hash}.pdf`);
  });
});
