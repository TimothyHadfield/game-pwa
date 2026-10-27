# game-pwa: home-screen install + offline play, never an old build

Three small files make a board game site installable on the iPhone home screen ("Add to Home Screen")
and playable vs the computer with no connection, **without ever showing an old build while online**.
$0, no build step, no dependencies. Pilots: [Battleship](https://timothyhadfield.github.io/battleship/),
[Checkers](https://timothyhadfield.github.io/checkers/).

| File | Goes to | What it does |
|---|---|---|
| `sw.js` | game root (next to `index.html`), **unchanged** | Network-first service worker. Cache = offline fallback only. |
| `pwa.js` | `js/pwa.js`, **unchanged** | Registers `sw.js`, checks for new deploys, shows "New version — tap to reload". |
| `manifest.webmanifest` | game root, **fill in** name/description | Home-screen name, icons, standalone window. |
| `tools/make-icons.mjs` | `tools/`, **unchanged** | Draws `apple-touch-icon.png` + `icons/*.png` from `icon.svg`. |
| `tools/pwa-check.mjs` | `tools/`, **unchanged** | The test: offline play + new deploys picked up (WebKit, iPhone size). |

## Why it can't serve a stale build

- **Network first, always.** Every request for the game's own files goes to the network, revalidated past the
  browser's HTTP cache (`cache: "no-cache"`; Pages answers a quick 304). The saved copy is used **only when the
  network fails** (airplane mode, no signal, server down). So online you always get exactly what Pages serves,
  and the worker even removes Pages' 10-minute HTTP-cache staleness.
- **Scoped to the game's folder.** Pages serves every game on one origin (`timothyhadfield.github.io/<repo>/`).
  The worker's scope is `/<repo>/`; anything outside it (Firestore, Google sign-in, the Firebase CDN, fonts,
  other games, the Hub) passes straight through and is **never cached**. Non-GET and Range requests pass through.
- **Keyed by build.** `pwa.js` registers `sw.js?v=<build>`; the cache is `pwa:/<repo>/:<build>`. A new build
  installs a new worker that takes over at once and deletes only this folder's older caches.
- **Open pages notice new deploys.** On load, on every return to the page, and when the connection comes back
  (at most once a minute), `pwa.js` sends a no-store `HEAD` for the page and compares `Last-Modified` with the
  page's own (Pages stamps every file with the deploy time; same trick as Estimator Quiz). Newer means a new
  deploy: if the game says it's a safe moment, the page reloads itself once; otherwise a small
  **"New version — tap to reload"** pill appears at the top (× hides it until the next deploy).
- **Escape hatch:** add `?nosw` to any URL to bypass the worker for that request.

## Add it to a game (about 10 minutes)

1. Copy `sw.js` to the game root, `pwa.js` to `js/`, `tools/make-icons.mjs` + `tools/pwa-check.mjs` to `tools/`.
2. Copy `manifest.webmanifest` to the root. Set `name`/`short_name` to the page's existing `<title>` and
   `description` to its meta description (Tim owns names: don't invent new ones). `background_color` /
   `theme_color` = the page's `theme-color`.
3. Icons: `node tools/make-icons.mjs` (keeps an existing `apple-touch-icon.png`; `--force` redraws;
   `--bg "#hex"` sets the solid background). It writes `icons/icon-192.png`, `icons/icon-512.png`,
   `icons/icon-maskable-512.png`. Check `.gitignore` doesn't hide `*.png`.
4. In `index.html` `<head>`, next to the existing `theme-color` / icon tags:
   ```html
   <link rel="manifest" href="manifest.webmanifest">
   <meta name="mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-status-bar-style" content="black">
   <meta name="apple-mobile-web-app-title" content="<same as short_name>">
   ```
   and **before** the game's main script (so `window.PWA` exists when the game starts):
   ```html
   <script src="js/pwa.js?v=N" data-version="N" defer></script>
   ```
   `data-version` = the game's build number. Bump it with every release, like the other `?v=` tags
   (a forgotten bump is harmless: network-first still serves the new files; the bump just renames the cache).
5. Tell the kit when a reload is harmless. In the game's start-up code:
   ```js
   if (window.PWA) PWA.safeToReload = () => !online && !sheetOpen && !inputFocused && (gameOver || onQuietTab);
   ```
   Return `true` only when nothing would be lost: no online room, no open sheet/confirm box, no text field
   focused, no move animating or computer thinking, and either the game is over or the player is on a tab
   with no unsaved state while the game in progress is saved. When in doubt return `false` (the pill shows).
6. Offline play must not need the network: online code loads Firebase with a dynamic `import()` only when the
   player picks Online (the shared `_online` kit already does). The computer opponent's worker scripts are
   found automatically (the worker crawls the page, its scripts, `importScripts` and CSS `url()`s, and also
   saves everything the first visit loaded).
7. Test: add `tests/pwa-check.json` (see the top of `tools/pwa-check.mjs`; Battleship's and Checkers' are
   examples) and run `node tools/pwa-check.mjs`. Watch it fail first on the game without the kit.
8. After the push: open the live page once, then in phone-view check `navigator.serviceWorker.controller`
   and that the page still loads with the connection off.

## API (`window.PWA`)
`PWA.version` (data-version) · `PWA.kit` · `PWA.safeToReload = fn` · `PWA.check()` → Promise&lt;bool&gt; (force a
deploy check now) · `PWA.onUpdate(fn)` (called with `{build, lastModified}` when a deploy is found) ·
`PWA.reload()` · `PWA.status()` → Promise&lt;{kit, build, cache}|null&gt; (from the active worker).

## Tests
`npm test` runs `test/run.mjs`: a tiny fixture game (module imports, a Web Worker with `importScripts`, a CSS
`url()`, a CDN-only online path) served like GitHub Pages (`max-age=600`, `Last-Modified`, ETag/304), checked in
WebKit and Chromium at 393×659, plus `--no-kit` (the same fixture without the kit must fail: 3/16).
Checks: worker controls the page; one cache named for folder + build holding only the game's own files;
offline reload and offline cold open draw the game; a move vs the computer is answered offline; the next open
after a deploy shows the new build in one load; the old cache is deleted; a deploy seen mid-game shows the pill
and does not reload; the pill fits 393 px; tapping it loads the new build; at a safe point the page moves to the
new build by itself; no page errors and no request leaves localhost.
Offline in the test = the server drops every connection (WebKit's `setOffline` also blocks the worker's own
replies, which a real phone doesn't).

## Not verified
- A real iPhone's home-screen app (standalone window, status bar, how long iOS keeps the cache: Safari may
  evict a site's storage after ~7 days without a visit). Checked only in headless WebKit and Chromium.
- In the home-screen app, the "All games" link (`../`) leaves the game's scope, so iOS opens it in a Safari sheet.

## Changelog
- **1.0.0** (2026-10-27): first release. `sw.js` network-first with build-keyed offline cache and crawling
  precache; `pwa.js` register + Last-Modified deploy check + safe auto-reload / "New version" pill;
  manifest template; `make-icons.mjs`; `pwa-check.mjs` + fixture tests. Pilots: Battleship, Checkers.
