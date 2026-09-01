// Progressive enhancement only. Every action on the page works without this
// file — the search box is a GET form and the buttons are POST forms — so a
// failed script degrades to plain HTML rather than a dead page.

(() => {
  // Lets the stylesheet hide the fallback submit buttons that exist only for
  // the scriptless case. Set first so nothing below can leave it half-applied.
  document.documentElement.classList.add("js");

  // Filing a link is a one-touch action on a phone: pick a list and it saves.
  // The "Move" button beside each select is what runs when this never loads.
  for (const select of document.querySelectorAll("select[data-autosubmit]")) {
    select.addEventListener("change", () => select.form.requestSubmit());
  }

  const search = document.getElementById("q");

  if (search) {
    // Keep the box filled after a search so the query stays visible and editable.
    search.value = new URLSearchParams(location.search).get("q") ?? "";

    // Debounced submit rather than client-side rendering: the server already
    // knows how to draw a card, and duplicating that template in JS is how the
    // two drift apart.
    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => search.form.requestSubmit(), 350);
    });
  }

  // A link shared from the phone lands as "pending" and fills in a second or
  // two later. Poll just those cards, and stop once they are all resolved so an
  // idle tab is not making requests forever.
  const pending = [...document.querySelectorAll(".card.is-pending")].map((el) => el.dataset.id);
  if (pending.length === 0) return;

  let attempts = 0;
  const poll = setInterval(async () => {
    attempts += 1;
    // ~1 minute of polling. Past that the enrichment has failed in a way a
    // reload will not fix.
    if (attempts > 30) return clearInterval(poll);

    const results = await Promise.all(
      pending.map((id) =>
        fetch(`/api/links/${id}`, { headers: { accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ),
    );

    if (results.some((link) => link && link.status !== "pending")) {
      clearInterval(poll);
      location.reload();
    }
  }, 2000);
})();
