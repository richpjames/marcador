import { expect, test } from "bun:test";
import { html, raw } from "../src/views/html.ts";

test("escapes interpolated values", () => {
  const title = '<img src=x onerror="alert(1)">';
  expect(html`<p>${title}</p>`.value).toBe(
    "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
  );
});

test("escapes inside attributes, so a scraped URL cannot break out", () => {
  const url = '" onmouseover="steal()';
  expect(html`<a href="${url}">x</a>`.value).toBe(
    '<a href="&quot; onmouseover=&quot;steal()">x</a>',
  );
});

test("nested templates and arrays pass through already-escaped", () => {
  const items = ["a & b", "c"];
  expect(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`.value).toBe(
    "<ul><li>a &amp; b</li><li>c</li></ul>",
  );
});

test("raw() is the only way to inject markup", () => {
  expect(html`${raw("<br>")}`.value).toBe("<br>");
});

test("skips null, undefined and false so conditionals read cleanly", () => {
  expect(html`<p>${null}${undefined}${false}</p>`.value).toBe("<p></p>");
});
