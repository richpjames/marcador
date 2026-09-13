# marcador

Save a link, get a one-sentence description of it, find it again later.

A deliberately small alternative to Karakeep: one SQLite file, one container, no
queue, no worker, no browser automation. Share a link from Safari on iOS, iPadOS
or macOS and it appears in the list a second later with a title, an image, and a
sentence written by Mistral.

![The link list](docs/screenshot-list.png)

## What it does

- **Save a link** from the web UI, the share sheet, or `POST /api/links`
- **Describe it** — Mistral reads the page and writes one sentence
- **Show the page's image**, scraped from its OG tags
- **Full-text search** across titles, descriptions and URLs (SQLite FTS5)
- **Single-user auth** — a password for the browser, a bearer token for the share sheet

Not included, on purpose: tags, folders, page archiving, multi-user accounts,
and RSS. Each is a decision to make later rather than a gap.

## How it fits together

```
Safari share sheet ─┐
Web UI ─────────────┼─> POST /api/links ──> SQLite (status: pending)
Shortcut / curl ────┘                            │
                                                 │  returns immediately
                                                 ▼
                                    background queue (in-process, serial)
                                                 │
                                    fetch page ──┴── ask Mistral
                                                 │
                                       SQLite (status: ready)
```

The save path never waits on the network. That is the whole reason the share
sheet dismisses instantly instead of spinning for four seconds on a slow site,
and it is why a failed scrape costs you a description rather than the link.

| File | What lives there |
| --- | --- |
| `src/app.ts` | Every route, HTML and JSON alike |
| `src/store.ts` | Saving, listing, and the FTS5 search query |
| `src/enrich.ts` | The background queue |
| `src/metadata.ts` | OG-tag scraping |
| `src/summarise.ts` | The Mistral call — **and the prompt** |
| `src/auth.ts` | Session cookie and bearer token |
| `native/ShareExtension/` | The Swift share sheet |

## Running it locally

```sh
bun install
cp .env.example .env       # then fill in the two secrets
bun run dev                # http://localhost:3000
```

`MISTRAL_API_KEY` is optional. Without it links still save and still get a
title and image; the description falls back to whatever the page says about
itself.

```sh
bun test          # 38 tests, no network
bun run typecheck
```

## Deploying to Coolify

1. Push this repo somewhere Coolify can reach.
2. New resource → **Docker Compose** → point it at this repo. It picks up
   `docker-compose.yml`.
3. Set the environment variables:

   | Variable | Notes |
   | --- | --- |
   | `MARCADOR_PASSWORD` | Your web login. Required. |
   | `MARCADOR_TOKEN` | For the share sheet. `openssl rand -hex 32`. Required. |
   | `MARCADOR_SECRET` | Optional. Defaults to a value derived from the password, which means changing the password signs you out everywhere. |
   | `MISTRAL_API_KEY` | Optional, but it is the point of the app. |
   | `MISTRAL_MODEL` | Defaults to `mistral-small-latest`. |

4. Set the domain, and let Coolify terminate TLS. The session cookie marks
   itself `Secure` when it sees `X-Forwarded-Proto: https`, so this matters.
5. Health check is `GET /healthz`, already declared in the Dockerfile.

The `marcador-data` volume holds one SQLite file. Backing that file up is the
entire backup story.

## The iOS / iPadOS / macOS app

A thin Capacitor shell whose webview points at your deployment, plus a native
Share Extension. The shell exists so the extension has somewhere to live: iOS
Safari has no Web Share Target API, so a PWA can never appear in the share sheet.

```sh
cp native/ShareExtension/Config.xcconfig.example native/ShareExtension/Config.xcconfig
# edit it: your domain, and the same MARCADOR_TOKEN as the server
bun run ios
```

That regenerates `ios/`, wires the extension target in, and opens Xcode. Then
pick your device and run. Choose **My Mac (Mac Catalyst)** for the Mac app — the
same extension shows up in the macOS share menu.

Sharing a link asks which list it is for, defaulting to the one you picked last
time, since filing it afterwards means finding it again on another device. With
no lists on the server there is nothing to ask, so the share stays what it was:
tap marcador, see "Saved", carry on.

Signing is set for you: the script reads the team from your one installed Apple
Development certificate and applies it to both targets. With several accounts on
the machine that is ambiguous, so name the one you want:

```sh
MARCADOR_DEV_TEAM=ABCDE12345 bun run ios
```

### The Mac share menu shows nothing

Two causes, and the first is silent:

- **A development build never appears.** Xcode signs it "Apple Development"
  with the get-task-allow entitlement, so `spctl -a` rejects it and macOS will
  not offer a share extension from a bundle it refuses to trust. Nothing warns
  you; the entry is simply absent. `./scripts/release-mac.sh` produces the
  notarised build that does work.
- **The extension ships disabled.** Tick it under System Settings > General >
  Login Items & Extensions > Sharing, or `pluginkit -e use -i
  es.ricojam.marcador.ShareExtension`.

Check what macOS actually offers rather than guessing from the browser:

```sh
pluginkit -m -v | grep marcador   # a leading "+" means enabled
```

Firefox caches the services list at launch, so restart it after either fix.

### Firefox says nothing here looks like a link

The extension ran and found no URL it could read. Safari shares a `public.url`
that arrives as an `NSURL`; Firefox on the Mac instead delivers the page URL as
raw UTF-8 `NSData` — and `loadItem` promises no particular class for what it
hands back, so the strict `as? URL` / `as? String` casts were a silent miss.
The extraction now accepts a URL, string or data payload in either the URL slot
or the text slot, which covers Firefox alongside Safari. If another host app
ever reports the same, print what `loadItem` actually returned; its class is the
whole clue.

A build has to carry the fix, so re-run `./scripts/release-mac.sh`, replace the
installed app, and restart Firefox.

Two things that will bite you if you edit the config by hand:

- **The URL needs the `https:/$()/host` escape.** xcconfig treats `//` as a
  comment and will silently truncate a normal URL to `https:`. The app now
  refuses to post rather than failing quietly, but the escape is still required.
- **The token must match the server's `MARCADOR_TOKEN` exactly.** The extension
  authenticates with it and nothing else, so a stale or placeholder value fails
  as a 401 from inside the share sheet, where the error is easy to miss.
- **`ios/` is disposable and gitignored.** Everything that makes it marcador
  lives in `capacitor.config.ts`, `native/`, and `scripts/add-share-extension.rb`.
  Never edit the generated project by hand; the next `bun run ios` deletes it.

### No Xcode?

`POST /api/links` is all the extension does, so an iOS Shortcut works too:

```
Receive URLs from share sheet
  → Get Contents of URL
      https://your-domain/api/links
      Method: POST
      Headers: Authorization = Bearer <MARCADOR_TOKEN>
      Request Body (JSON): url = Shortcut Input
```

Add `listId` to the body — the number from `GET /api/lists` — for a Shortcut that
always files into the same list.

## Migrating from Karakeep

```sh
# See what would happen, without writing anything
bun scripts/import-karakeep.ts --from https://bookmarks.example.com --key ak1_... --dry-run

# Do it
bun scripts/import-karakeep.ts --from https://bookmarks.example.com --key ak1_...
```

Get the key from Karakeep's **Settings → API Keys**. If you would rather not make
one, export from **Settings → Import & Export** and pass the file instead:

```sh
bun scripts/import-karakeep.ts --file karakeep-export.json
```

It never writes to Karakeep, and it is safe to re-run: links deduplicate on their
normalised URL, so a second pass imports only what is new.

| Option | Does |
| --- | --- |
| `--dry-run` | Reports what it would import, writes nothing |
| `--summarise missing` | Default. Keeps Karakeep's descriptions, and writes fresh ones only where there are none |
| `--summarise all` | Re-describes everything with Mistral, so the whole list reads in one voice |
| `--summarise none` | Keeps Karakeep's text as-is; no Mistral calls at all |
| `--skip-archived` | Leaves Karakeep's archived bookmarks behind |

**What comes across:** the URL, title, description, image, source site, and the
original save date — so the list keeps its order rather than all landing today.
For the description it takes your note first, then Karakeep's AI summary, then
the page's own description.

**What does not:** tags, archived state, highlights, and full-page archives.
marcador has nowhere to put them, and storing data nothing can display is worse
than leaving it behind. Karakeep is untouched, so it all stays there.

## API

All routes need either a session cookie or `Authorization: Bearer <MARCADOR_TOKEN>`.

| Route | Does |
| --- | --- |
| `POST /api/links` | `{"url": "...", "listId": 3}`. 201 when new, 200 when already saved. `listId` is optional and files the link as it saves; leave it out to save it unfiled. |
| `GET /api/links` | Everything, or `?q=` to search, or `?list=` for one list. |
| `GET /api/lists` | Every list with its link count. What the share sheet offers. |
| `GET /api/links/:id` | One link. Poll it to watch `status` go `pending` → `ready`. |
| `DELETE /api/links/:id` | Removes it. |
| `GET /healthz` | No auth. For Coolify. |

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — same as On The Beach. Free to read,
run, modify and share for any noncommercial purpose; commercial use needs a
separate arrangement.
