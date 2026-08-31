import { html, type Html } from "./html.ts";

export function loginPage({ error, next }: { error?: string; next: string }): Html {
  return html`
    <form class="login" action="/login" method="post">
      <h1>marcador</h1>
      <input type="hidden" name="next" value="${next}" />
      <label for="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autofocus
        autocomplete="current-password"
      />
      ${error ? html`<p class="error" role="alert">${error}</p>` : null}
      <button type="submit">Sign in</button>
    </form>
  `;
}
