import { html, raw, type Html } from "./html.ts";

export function layout({
  title,
  body,
  bare = false,
}: {
  title: string;
  body: Html;
  /** Login page: no nav, no app script. */
  bare?: boolean;
}): string {
  return `<!doctype html>
${html`<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <title>${title}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <link rel="icon" href="/static/icon.svg" />
  </head>
  <body>
    ${bare ? null : header()}
    <main>${body}</main>
    ${bare ? null : raw('<script src="/static/app.js" defer></script>')}
  </body>
</html>`}`;
}

function header(): Html {
  return html`
    <header class="topbar">
      <a class="brand" href="/">marcador</a>
      <form class="search" action="/" method="get" role="search">
        <input
          type="search"
          name="q"
          id="q"
          placeholder="Search"
          autocomplete="off"
          aria-label="Search saved links"
        />
      </form>
      <form action="/logout" method="post"><button class="link-button">Sign out</button></form>
    </header>
  `;
}
