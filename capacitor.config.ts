import type { CapacitorConfig } from "@capacitor/cli";

// The native shell exists for one reason: iOS Safari does not implement the Web
// Share Target API, so a PWA can never appear in the share sheet. A thin
// Capacitor app can, because it is allowed to host a native Share Extension
// (see `native/ShareExtension/`).
//
// `server.url` points the WKWebView at the running deployment rather than a
// bundled copy of the front end, so the app is always whatever the server is
// serving and there is no second build to keep in step.
const config: CapacitorConfig = {
  appId: "es.ricojam.marcador",
  appName: "marcador",
  // Unused while `server.url` is set, but Capacitor insists the directory exist.
  webDir: "www",
  server: {
    url: process.env.MARCADOR_APP_URL ?? "https://bookmarks.ricojam.es",
    cleartext: false,
  },
};

export default config;
