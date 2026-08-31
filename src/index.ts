import { config } from "./config.ts";
import { createDb } from "./db.ts";
import { createStore } from "./store.ts";
import { createSummariser } from "./summarise.ts";
import { createEnricher, resumePending } from "./enrich.ts";
import { createApp } from "./app.ts";

const { db, sqlite } = createDb();
const store = createStore(db, sqlite);
const summariser = createSummariser();
const enricher = createEnricher({ store, summariser });

const resumed = resumePending(store, enricher);
if (resumed > 0) console.log(`[boot] resuming enrichment for ${resumed} link(s)`);

if (!config.mistralApiKey) {
  console.warn("[boot] MISTRAL_API_KEY is unset — links will fall back to the page's own description");
}

const app = createApp({ store, enricher });

console.log(`[boot] marcador listening on :${config.port} (db: ${config.databasePath})`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Enrichment fetches can outlive the request that queued them.
  idleTimeout: 60,
};
