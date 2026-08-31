import { describe, expect, test } from "bun:test";
import { hostOf, normaliseUrl } from "../src/url.ts";

describe("normaliseUrl", () => {
  test("strips tracking parameters but keeps meaningful ones", () => {
    expect(normaliseUrl("https://example.com/post?utm_source=x&id=7&fbclid=abc")).toBe(
      "https://example.com/post?id=7",
    );
  });

  test("collapses the variants that would otherwise duplicate a link", () => {
    const canonical = "https://example.com/post";
    expect(normaliseUrl("https://EXAMPLE.com/post/")).toBe(canonical);
    expect(normaliseUrl("https://example.com/post#section")).toBe(canonical);
    expect(normaliseUrl("  https://example.com/post  ")).toBe(canonical);
  });

  test("keeps a bare root slash, which is a real path", () => {
    expect(normaliseUrl("https://example.com/")).toBe("https://example.com/");
  });

  test("rejects anything that is not http(s)", () => {
    expect(() => normaliseUrl("javascript:alert(1)")).toThrow(/scheme/);
    expect(() => normaliseUrl("not a url")).toThrow();
  });
});

test("hostOf drops the www prefix for display", () => {
  expect(hostOf("https://www.example.com/a/b")).toBe("example.com");
  expect(hostOf("garbage")).toBe("garbage");
});
