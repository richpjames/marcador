import type { Link } from "../db.ts";
import { hostOf } from "../url.ts";
import { html, type Html } from "./html.ts";

export function listPage({
  items,
  query,
  error,
}: {
  items: Link[];
  query: string;
  error?: string;
}): Html {
  return html`
    ${error ? html`<p class="banner error" role="alert">${error}</p>` : null}

    <form class="add" action="/links" method="post">
      <input
        type="url"
        name="url"
        placeholder="https://…"
        required
        autocomplete="off"
        aria-label="URL to save"
      />
      <button type="submit">Save</button>
    </form>

    ${query
      ? html`<p class="results-for">
          ${items.length} result${items.length === 1 ? "" : "s"} for
          <strong>${query}</strong> · <a href="/">clear</a>
        </p>`
      : null}

    ${items.length === 0 ? empty(query) : html`<ul class="links">${items.map(card)}</ul>`}
  `;
}

function empty(query: string): Html {
  return query
    ? html`<p class="empty">Nothing matches “${query}”.</p>`
    : html`<p class="empty">No links yet. Paste one above, or share to marcador from Safari.</p>`;
}

function card(link: Link): Html {
  // A pending link is rendered as itself rather than hidden, so a share from
  // the phone shows up in the list straight away and fills in as it enriches.
  const pending = link.status === "pending";

  return html`
    <li class="card ${pending ? "is-pending" : ""}" data-id="${link.id}">
      ${link.imageUrl
        ? html`<a class="thumb" href="${link.url}" target="_blank" rel="noreferrer noopener">
            <img src="${link.imageUrl}" alt="" loading="lazy" />
          </a>`
        : null}

      <div class="card-body">
        <a class="card-title" href="${link.url}" target="_blank" rel="noreferrer noopener">
          ${link.title ?? link.url}
        </a>

        ${link.description ? html`<p class="card-desc">${link.description}</p>` : null}
        ${pending ? html`<p class="card-desc muted">Fetching description…</p>` : null}
        ${link.status === "failed"
          ? html`<p class="card-desc error" title="${link.error ?? ""}">Could not read this page.</p>`
          : null}

        <p class="card-meta">
          <span>${link.siteName ?? hostOf(link.url)}</span>
          <span aria-hidden="true">·</span>
          <time datetime="${new Date(link.createdAt).toISOString()}">
            ${formatDate(link.createdAt)}
          </time>
        </p>
      </div>

      <form class="delete" action="/links/${link.id}/delete" method="post">
        <button type="submit" aria-label="Delete ${link.title ?? link.url}" title="Delete">×</button>
      </form>
    </li>
  `;
}

function formatDate(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;

  return new Date(timestamp).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
