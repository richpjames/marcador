import type { Link } from "../db.ts";
import type { ListWithCount } from "../store.ts";
import { hostOf } from "../url.ts";
import { html, type Html } from "./html.ts";

export function listPage({
  items,
  lists,
  activeList,
  total,
  query,
  error,
}: {
  items: Link[];
  lists: ListWithCount[];
  /** Which list is being filtered to, if any. */
  activeList?: ListWithCount;
  /** Count across every list, for the "All" chip. */
  total: number;
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

    <form class="upload" action="/files" method="post" enctype="multipart/form-data">
      <label>
        <input type="file" name="file" accept="application/pdf,.pdf" data-autosubmit />
        <span>or upload a PDF</span>
      </label>
      <button type="submit" class="no-js">Upload</button>
    </form>

    ${nav({ lists, activeList, total, query })}

    ${query
      ? html`<p class="results-for">
          ${items.length} result${items.length === 1 ? "" : "s"} for
          <strong>${query}</strong>${activeList ? html` in ${activeList.name}` : null} ·
          <a href="${activeList ? `/?list=${activeList.id}` : "/"}">clear</a>
        </p>`
      : null}

    ${items.length === 0
      ? empty(query, activeList)
      : html`<ul class="links">${items.map((item) => card(item, lists))}</ul>`}
  `;
}

/**
 * The list chips, plus the form for making a new one. Every chip is a plain
 * link with a `list` query parameter, so filtering works with no JavaScript and
 * each filtered view is its own bookmarkable URL.
 */
function nav({
  lists,
  activeList,
  total,
  query,
}: {
  lists: ListWithCount[];
  activeList?: ListWithCount;
  total: number;
  query: string;
}): Html {
  // Carried through so switching lists does not silently drop the search.
  const q = query ? `&q=${encodeURIComponent(query)}` : "";

  return html`
    <nav class="lists" aria-label="Lists">
      <a class="chip ${activeList ? "" : "is-active"}" href="/${query ? `?q=${encodeURIComponent(query)}` : ""}">
        All <span class="count">${total}</span>
      </a>

      ${lists.map(
        (list) => html`
          <a
            class="chip ${activeList?.id === list.id ? "is-active" : ""}"
            href="/?list=${list.id}${q}"
          >
            ${list.icon ? html`<span aria-hidden="true">${list.icon}</span>` : null} ${list.name}
            <span class="count">${list.count}</span>
          </a>
        `,
      )}

      ${activeList
        ? html`
            <form class="delete-list" action="/lists/${activeList.id}/delete" method="post">
              <button
                type="submit"
                title="Delete the ${activeList.name} list"
                aria-label="Delete the ${activeList.name} list. Its links are kept."
              >
                Delete list
              </button>
            </form>
          `
        : null}

      <form class="chip new-list" action="/lists" method="post">
        <input
          type="text"
          name="name"
          placeholder="+ New list"
          required
          maxlength="40"
          autocomplete="off"
          aria-label="Name for a new list"
        />
      </form>
    </nav>
  `;
}

function empty(query: string, activeList?: ListWithCount): Html {
  if (query) return html`<p class="empty">Nothing matches “${query}”.</p>`;
  if (activeList) return html`<p class="empty">Nothing in ${activeList.name} yet.</p>`;

  return html`<p class="empty">No links yet. Paste one above, or share to marcador from Safari.</p>`;
}

function card(link: Link, lists: ListWithCount[]): Html {
  // A pending link is rendered as itself rather than hidden, so a share from
  // the phone shows up in the list straight away and fills in as it enriches.
  const pending = link.status === "pending";

  const isFile = link.kind === "file";

  return html`
    <li class="card ${pending ? "is-pending" : ""}" data-id="${link.id}">
      ${link.imageUrl
        ? html`<a class="thumb" href="${link.url}" target="_blank" rel="noreferrer noopener">
            <img src="${link.imageUrl}" alt="" loading="lazy" />
          </a>`
        : null}
      ${isFile && !link.imageUrl
        ? html`<a class="thumb thumb-pdf" href="${link.url}" target="_blank" rel="noreferrer noopener">
            <span aria-hidden="true">PDF</span>
          </a>`
        : null}

      <div class="card-body">
        <a class="card-title" href="${link.url}" target="_blank" rel="noreferrer noopener">
          ${link.title ?? link.url}
        </a>

        ${link.description ? html`<p class="card-desc">${link.description}</p>` : null}
        ${pending ? html`<p class="card-desc muted">Fetching description…</p>` : null}
        ${link.status === "failed"
          ? html`<p class="card-desc error" title="${link.error ?? ""}">
              Could not read this ${isFile ? "PDF" : "page"}.
            </p>`
          : null}

        <p class="card-meta">
          <span>${link.siteName ?? (isFile ? "PDF" : hostOf(link.url))}</span>
          ${isFile && link.fileSize
            ? html`<span aria-hidden="true">·</span>
                <span>${formatSize(link.fileSize)}</span>`
            : null}
          <span aria-hidden="true">·</span>
          <time datetime="${new Date(link.createdAt).toISOString()}">
            ${formatDate(link.createdAt)}
          </time>
        </p>

        ${picker(link, lists)}
      </div>

      <form class="delete" action="/links/${link.id}/delete" method="post">
        <button type="submit" aria-label="Delete ${link.title ?? link.url}" title="Delete">×</button>
      </form>
    </li>
  `;
}

/**
 * Filing control on each card. A `<select>` inside its own form, with a submit
 * button that only appears when scripting is off — app.js submits on change,
 * but the button is the fallback that keeps this working without it.
 */
function picker(link: Link, lists: ListWithCount[]): Html {
  if (lists.length === 0) return html``;

  return html`
    <form class="card-list" action="/links/${link.id}/list" method="post">
      <select name="list" aria-label="List for ${link.title ?? link.url}" data-autosubmit>
        <option value="" ${link.listId === null ? "selected" : ""}>Unfiled</option>
        ${lists.map(
          (list) => html`
            <option value="${list.id}" ${link.listId === list.id ? "selected" : ""}>
              ${list.icon ? `${list.icon} ` : ""}${list.name}
            </option>
          `,
        )}
      </select>
      <button type="submit" class="no-js">Move</button>
    </form>
  `;
}

function formatSize(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb < 1 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${mb.toFixed(1)} MB`;
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
