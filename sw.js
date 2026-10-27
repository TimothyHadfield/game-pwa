/* game-pwa sw.js 1.1.0: network-first service worker for Tim's board game sites.
 * Copy this file UNCHANGED to the game's root folder (next to index.html). js/pwa.js registers it as
 * "sw.js?v=<build>", so the build number lives in index.html, not here.
 *
 * Rules (why it can never serve an old build while online):
 *  - Every same-folder GET goes to the network first, revalidated past the browser's HTTP cache
 *    (cache: "no-cache"; GitHub Pages answers a quick 304), and the fresh copy is saved.
 *  - The saved copy is used ONLY when the network fails (offline, airplane mode, server down), or when a
 *    request takes over 5 s on a weak signal (then only an exact saved copy is used, and pwa.js's deploy
 *    check still catches any newer build once the network answers).
 *  - An install that can't reach every file keeps the old worker and its complete offline copy.
 *  - Nothing outside this game's folder is touched: Firebase/Firestore, Google sign-in, CDNs and other
 *    games on the same github.io origin pass straight through and are never cached. Non-GET and Range
 *    requests pass through too.
 *  - One cache per folder + build ("pwa:/battleship/:13"); activating a new build deletes this folder's
 *    older caches and nothing else (all games share the timothyhadfield.github.io origin).
 *  - Games only: never use it on the Hub at "/" (its scope would cover every game).
 */
"use strict";
const KIT = "1.1.0";
const BUILD = new URL(self.location.href).searchParams.get("v") || "0";
const SCOPE = self.registration.scope;                       // e.g. https://x.github.io/battleship/
const PREFIX = "pwa:" + new URL(SCOPE).pathname + ":";
const CACHE = PREFIX + BUILD;
const ASSET = /["'`]((?:\.{0,2}\/)?[\w\-.\/]+\.(?:m?js|css|svg|png|jpe?g|webp|gif|json|webmanifest|woff2?|ttf|mp3|ogg|wav)(?:\?[\w=.&%-]*)?)["'`]/g;
const HTML_REF = /\b(?:src|href)\s*=\s*["']([^"'#]+)["']/g;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/g;

const inScope = u => typeof u === "string" && u.startsWith(SCOPE);
const fresh = url => fetch(url, { cache: "no-cache", credentials: "same-origin" });
const SLOW = 5000;                                           // weak signal: offline copy after this long
let slowUntil = 0;                                           // after one slow answer, wait only briefly for 30 s
const retired = () => !!(self.serviceWorker && self.serviceWorker.state === "redundant");

async function save(cache, url, res) {
  if (retired()) return;                                     // a newer build has taken over: don't revive old caches
  if (res && res.ok && res.type === "basic" && !res.redirected) await cache.put(url, res);
}

// Fetch a list of in-scope URLs and save each one that exists. Missing ones (404) are skipped quietly;
// with strict (install), a network failure throws so the install fails and the old copy stays.
async function addAll(cache, urls, strict) {
  const seen = new Set();
  const out = [];
  await Promise.all([...new Set(urls)].filter(inScope).map(async url => {
    if (seen.has(url)) return; seen.add(url);
    let res;
    try { res = await fresh(url); } catch (e) { if (strict) throw e; return; }
    if (res.ok) { out.push([url, res.clone()]); await save(cache, url, res); }
  }));
  return out;
}

// Install: save the page and everything it references (scripts, styles, icons, module imports,
// workers, importScripts, css url()), crawling two levels deep. A false match just 404s and is skipped.
async function precache() {
  const cache = await caches.open(CACHE);
  const page = await fresh(SCOPE);
  if (!page.ok) throw new Error("page " + page.status);       // offline install: keep the old build
  const html = await page.clone().text();
  await save(cache, SCOPE, page);
  const refs = u => { try { return new URL(u, SCOPE).href.split("#")[0]; } catch (e) { return null; } };
  let todo = [];
  for (const m of html.matchAll(HTML_REF)) todo.push(refs(m[1]));
  for (const m of html.matchAll(ASSET)) todo.push(refs(m[1]));
  const done = new Set([SCOPE]);
  for (let depth = 0; depth < 3 && todo.length; depth++) {
    const batch = todo.filter(u => u && inScope(u) && !done.has(u));
    batch.forEach(u => done.add(u));
    const got = await addAll(cache, batch, true);
    todo = [];
    for (const [url, res] of got) {
      const path = new URL(url).pathname;
      if (!/\.(m?js|css)$/.test(path)) continue;
      const text = await res.text();
      const pats = /\.css$/.test(path) ? [CSS_URL] : [ASSET];
      for (const re of pats) for (const m of text.matchAll(re)) {
        // relative to the file (imports, importScripts) AND to the page (new Worker("js/w.js"))
        try { todo.push(new URL(m[1], url).href.split("#")[0]); } catch (e) {}
        if (re === ASSET) todo.push(refs(m[1]));
      }
    }
  }
}

self.addEventListener("install", e => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "pwa:cache" && Array.isArray(d.urls)) {
    e.waitUntil(caches.open(CACHE).then(c => addAll(c, d.urls.map(u => String(u).split("#")[0]))));
  } else if (d.type === "pwa:version" && e.ports[0]) {
    e.ports[0].postMessage({ kit: KIT, build: BUILD, cache: CACHE });
  }
});

// exact: only this very URL (used on a slow network, so a page and its files never mix builds)
async function fromCache(req, exact) {
  const cache = await caches.open(CACHE);
  const url = req.url.split("#")[0];
  let hit = await cache.match(url);
  if (exact) return hit || (req.mode === "navigate" ? cache.match(SCOPE) : undefined);
  if (!hit) hit = await cache.match(url, { ignoreSearch: true });
  if (!hit && req.mode === "navigate") hit = await cache.match(SCOPE) || await cache.match(SCOPE + "index.html");
  if (!hit) {                                                  // an older build's cache, as a last resort
    for (const k of await caches.keys()) if (k.startsWith(PREFIX)) {
      hit = await (await caches.open(k)).match(url, { ignoreSearch: true });
      if (hit) break;
    }
  }
  return hit;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = req.url.split("#")[0];
  if (!inScope(url) || /[?&]nosw(=|&|$)/.test(url)) return;  // Firestore, CDNs, other games: untouched
  e.respondWith((async () => {
    const nav = req.mode === "navigate";
    const t0 = Date.now();
    const net = (nav ? fresh(url) : fetch(req, { cache: "no-cache" })).then(res => {
      if (Date.now() - t0 < 1000) slowUntil = 0;                // the signal is back
      if (res.ok && res.type === "basic" && !res.redirected) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => save(c, url, copy)).catch(() => {}));
      }
      return res;
    });
    try {
      // wait up to SLOW for the network, then use the exact saved copy if there is one (the network
      // answer is still saved when it arrives)
      let timer;
      const wait = Date.now() < slowUntil ? 400 : SLOW;
      const slow = new Promise(ok => { timer = setTimeout(() => fromCache(req, true).then(hit => { if (hit) { slowUntil = Date.now() + 30000; ok(hit); } }), wait); });
      e.waitUntil(net.catch(() => {}));
      const res = await Promise.race([net, slow]);
      clearTimeout(timer);
      if (nav && res.redirected) return Response.redirect(res.url, 302); // e.g. /battleship -> /battleship/
      return res;
    } catch (err) {                                            // network failed: offline copy
      const hit = await fromCache(req);
      if (hit) return hit;
      if (req.mode === "navigate") {
        return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<body style="background:#0f1117;color:#e8ecf4;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
          '<p>Offline. Open this game once with a connection to play it offline.</p>',
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return Response.error();
    }
  })());
});
