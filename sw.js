/* game-pwa sw.js 1.0.0: network-first service worker for Tim's board game sites.
 * Copy this file UNCHANGED to the game's root folder (next to index.html). js/pwa.js registers it as
 * "sw.js?v=<build>", so the build number lives in index.html, not here.
 *
 * Rules (why it can never serve an old build while online):
 *  - Every same-folder GET goes to the network first, revalidated past the browser's HTTP cache
 *    (cache: "no-cache"; GitHub Pages answers a quick 304), and the fresh copy is saved.
 *  - The saved copy is used ONLY when the network fails (offline, airplane mode, server down).
 *  - Nothing outside this game's folder is touched: Firebase/Firestore, Google sign-in, CDNs and other
 *    games on the same github.io origin pass straight through and are never cached. Non-GET and Range
 *    requests pass through too.
 *  - One cache per folder + build ("pwa:/battleship/:13"); activating a new build deletes this folder's
 *    older caches and nothing else (all games share the timothyhadfield.github.io origin).
 */
"use strict";
const KIT = "1.0.0";
const BUILD = new URL(self.location.href).searchParams.get("v") || "0";
const SCOPE = self.registration.scope;                       // e.g. https://x.github.io/battleship/
const PREFIX = "pwa:" + new URL(SCOPE).pathname + ":";
const CACHE = PREFIX + BUILD;
const ASSET = /["'`]((?:\.{0,2}\/)?[\w\-.\/]+\.(?:m?js|css|svg|png|jpe?g|webp|gif|json|webmanifest|woff2?|ttf|mp3|ogg|wav)(?:\?[\w=.&%-]*)?)["'`]/g;
const HTML_REF = /\b(?:src|href)\s*=\s*["']([^"'#]+)["']/g;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/g;

const inScope = u => typeof u === "string" && u.startsWith(SCOPE);
const fresh = url => fetch(url, { cache: "no-cache", credentials: "same-origin" });

async function save(cache, url, res) {
  if (res && res.ok && res.type === "basic" && !res.redirected) await cache.put(url, res);
}

// Fetch a list of in-scope URLs and save each one that exists. Missing ones are skipped quietly.
async function addAll(cache, urls) {
  const seen = new Set();
  const out = [];
  await Promise.all([...new Set(urls)].filter(inScope).map(async url => {
    if (seen.has(url)) return; seen.add(url);
    try { const res = await fresh(url); if (res.ok) { out.push([url, res.clone()]); await save(cache, url, res); } } catch (e) {}
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
    const got = await addAll(cache, batch);
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

async function fromCache(req) {
  const cache = await caches.open(CACHE);
  const url = req.url.split("#")[0];
  let hit = await cache.match(url);
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
    try {
      const res = req.mode === "navigate" ? await fresh(url) : await fetch(req, { cache: "no-cache" });
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => save(c, url, copy)).catch(() => {}));
      }
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
