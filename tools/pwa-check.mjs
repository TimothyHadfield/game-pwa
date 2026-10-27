// game-pwa pwa-check 1.0.0: proves a game installs its offline copy, plays offline vs the computer,
// and never shows an old build once a new one is deployed. Copy UNCHANGED to the game's tools/ folder.
//
//   node tools/pwa-check.mjs                run every check (WebKit, iPhone 393x659), exit 1 on any failure
//   node tools/pwa-check.mjs --serve        only serve the game like GitHub Pages at http://localhost:<port>/<repo>/
//   options: --dir <game folder> (default: the folder above tools/)   --port <n> (default random high)
//            --engine webkit|chromium (default webkit)   --config <file> (default <dir>/tests/pwa-check.json)
//            --shots <folder> (save screenshots: offline game, the "New version" pill)
//
// Config (tests/pwa-check.json), all JavaScript run in the page. After "play" the game must be mid-game (and
// still mid-game after a reload, so a saved game), where PWA.safeToReload() must return false:
//   { "repo": "battleship",                         // Pages folder name: the game is served at /<repo>/
//     "ready": "document.querySelector('#bigGrid .cell') !== null",   // true once the app has drawn
//     "play": ["...statements that start a game vs the computer and make one move..."],
//     "played": "...true once the computer has answered that move...",
//     "safe": "...optional statements that put the game at a safe resting point...",
//     "debug": "...optional expression printed when the offline move check fails..." }
//
// The server acts like GitHub Pages: Cache-Control max-age=600, Last-Modified = deploy time on every file,
// ETag + 304. A "deploy" changes the deploy time, adds <meta name="pwa-check-build" content="N"> to the page
// and bumps the page's data-version for pwa.js. Any request that leaves localhost fails the run.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = resolve(opt("dir", join(dirname(fileURLToPath(import.meta.url)), "..")));
const CFG_PATH = resolve(opt("config", join(DIR, "tests", "pwa-check.json")));
const CFG = JSON.parse(readFileSync(CFG_PATH, "utf8"));
const REPO = CFG.repo;
const PORT = +opt("port", 20000 + Math.floor(Math.random() * 20000));
const ENGINE = opt("engine", "webkit");
const SERVE_ONLY = argv.includes("--serve");
const SHOTS = opt("shots", "");                       // folder: save a screenshot at each key step

const deploy = { n: 0, time: Math.floor(Date.now() / 1000) * 1000 - 3600e3 };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

function body(file) {
  let buf = readFileSync(file);
  if (file === join(DIR, "index.html") && deploy.n > 0) {
    let html = buf.toString("utf8").replace("<head>", `<head>\n<meta name="pwa-check-build" content="${deploy.n}">`);
    html = html.replace(/(pwa\.js[^>]*data-version=")([^"]*)"/, `$1$2.d${deploy.n}"`);
    buf = Buffer.from(html);
  }
  return buf;
}

const net = { down: false };
const server = http.createServer((req, res) => {
  if (net.down) { req.socket.destroy(); return; }       // "offline": every request fails at the network level
  const url = new URL(req.url, "http://x");
  let path = decodeURIComponent(url.pathname);
  if (path === "/" + REPO) { res.writeHead(301, { Location: "/" + REPO + "/" }); return res.end(); }
  if (!path.startsWith("/" + REPO + "/")) { res.writeHead(404); return res.end("not found"); }
  path = path.slice(REPO.length + 2) || "index.html";
  if (path.endsWith("/")) path += "index.html";
  const file = resolve(DIR, path);
  if (!file.startsWith(DIR + sep) || !existsSync(file) || statSync(file).isDirectory() || /(^|[\\/])\./.test(path)) {
    res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>404</h1>");
  }
  const buf = body(file);
  const etag = '"' + createHash("sha1").update(buf).update(String(deploy.time)).digest("hex").slice(0, 16) + '"';
  const head = { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "max-age=600", "Last-Modified": new Date(deploy.time).toUTCString(), ETag: etag };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, head); return res.end(); }
  res.writeHead(200, { ...head, "Content-Length": buf.length });
  res.end(req.method === "HEAD" ? undefined : buf);
});

const BASE = `http://localhost:${PORT}/${REPO}/`;
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, ENGINE + "-" + name + ".png") }).catch(() => {}) : null;

async function waitFor(page, expr, ms = 8000) {
  try { await page.waitForFunction(expr, null, { timeout: ms, polling: 100 }); return true; } catch (e) { return false; }
}
const build = page => page.evaluate(() => { const m = document.querySelector('meta[name="pwa-check-build"]'); return m ? +m.content : 0; }).catch(() => -1);

async function main() {
  await new Promise(r => server.listen(PORT, r));
  if (SERVE_ONLY) { console.log("serving " + BASE + " (Ctrl+C to stop)"); return; }
  const pw = createRequire(join(homedir(), ".claude", "tools", "package.json"))("playwright");
  const browser = await pw[ENGINE].launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 659 }, isMobile: ENGINE !== "firefox",
      hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "allow",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    const watch = p => {
      p.on("pageerror", e => errors.push(String(e.message || e)));
      p.on("request", r => { if (!r.url().startsWith("http://localhost:" + PORT) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) errors.push("left localhost: " + r.url()); });
    };
    let page = await ctx.newPage(); watch(page);

    // 1. First visit: worker installs and saves the offline copy
    await page.goto(BASE, { waitUntil: "load" });
    check("first visit draws the game", await waitFor(page, CFG.ready));
    const sw = await waitFor(page, "navigator.serviceWorker && navigator.serviceWorker.controller !== null", 10000);
    check("service worker controls the page", sw);
    await waitFor(page, "window.PWA && true", 3000);
    await sleep(2500);                                              // let the precache + first-visit copy finish
    const cache = await page.evaluate(async () => {
      const out = {};
      for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map(r => r.url);
      return out;
    });
    const keys = Object.keys(cache);
    check("one cache, named for this folder + build", keys.length === 1 && keys[0].startsWith("pwa:/" + REPO + "/:"), keys.join(", "));
    const all = keys.flatMap(k => cache[k]);
    check("cache holds only this game's own files", all.length > 3 && all.every(u => u.startsWith(BASE)), all.length + " files");

    // 2. Offline: reload, and a cold open (like tapping the home-screen icon), then play vs computer
    // WebKit's setOffline() also blocks the service worker's own replies, so "offline" = the server
    // drops every connection (the same network error a phone in airplane mode gets).
    net.down = true;
    if (ENGINE === "chromium") await ctx.setOffline(true);
    await page.evaluate(() => { window.__beforeReload = 1; });
    await page.reload({ waitUntil: "load" }).catch(e => errors.push("offline reload: " + e.message));
    check("offline reload draws the game", await waitFor(page, "!window.__beforeReload && (" + CFG.ready + ")"));
    await page.close();
    page = await ctx.newPage(); watch(page);
    await page.goto(BASE, { waitUntil: "load" }).catch(e => errors.push("offline open: " + e.message));
    check("offline cold open draws the game", await waitFor(page, CFG.ready));
    for (const s of CFG.play || []) { await page.evaluate(s).catch(e => errors.push("play step: " + e.message)); await sleep(300); }
    const answered = await waitFor(page, CFG.played, 15000);
    check("offline game vs computer: computer answers a move", answered,
      !answered && CFG.debug ? String(await page.evaluate(CFG.debug).catch(e => e.message)) : "");
    await sleep(800); await shot(page, "offline-game");
    net.down = false;
    if (ENGINE === "chromium") await ctx.setOffline(false);

    // 3. New deploy, page closed: the next open must show it straight away (no hard refresh, no second load)
    deploy.n = 1; deploy.time += 120e3;
    await page.close();
    page = await ctx.newPage(); watch(page);
    let loads = 0; page.on("load", () => loads++);
    await page.goto(BASE, { waitUntil: "load" });
    check("next open after a deploy shows the new build at once", (await build(page)) === 1, "build " + (await build(page)));
    await waitFor(page, CFG.ready);
    await sleep(3000);
    check("...with no extra reload", loads === 1, loads + " loads");
    const keys2 = await page.evaluate(async () => (await caches.keys()));
    check("old build's cache deleted after the new one installs", keys2.length === 1 && /\.d1$/.test(keys2[0]), keys2.join(", "));

    // 4. Deploy while the page is open, mid-game: a polite pill, no reload; tap reloads to the new build
    deploy.n = 2; deploy.time += 120e3;
    const midSafe = await page.evaluate(() => !!window.PWA && typeof window.PWA.safeToReload === "function" && window.PWA.safeToReload());
    check("game says mid-game is not a safe moment to reload", midSafe === false);
    await page.evaluate(() => { window.__stay = 1; if (window.PWA) window.PWA.safeToReload = () => false; });
    await page.evaluate(() => window.PWA && window.PWA.check());
    const pill = await waitFor(page, "document.querySelector('.pwa-pill') !== null", 4000);
    check("open page mid-game: shows 'New version' pill, does not reload", pill && await page.evaluate(() => window.__stay === 1));
    const pillBox = pill ? await page.evaluate(() => { const r = document.querySelector('.pwa-pill').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top }; }) : null;
    await shot(page, "new-version-pill");
    check("pill fits the screen", !!pillBox && pillBox.l >= 0 && pillBox.r <= 393 && pillBox.t >= 0, JSON.stringify(pillBox));
    if (pill) await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.click(".pwa-reload")]);
    await waitFor(page, CFG.ready);
    check("tapping the pill loads the new build", (await build(page)) === 2, "build " + (await build(page)));

    // 5. Deploy while resting at a safe point: reloads itself once, no tap needed
    deploy.n = 3; deploy.time += 120e3;
    if (CFG.safe) await page.evaluate(CFG.safe).catch(e => errors.push("safe step: " + e.message));
    const safeNow = await page.evaluate(() => !!window.PWA && typeof window.PWA.safeToReload === "function" && window.PWA.safeToReload() === true);
    check("game reports a safe resting point", safeNow);
    await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.evaluate(() => window.PWA && window.PWA.check())]);
    await waitFor(page, CFG.ready);
    check("at a safe point the page moves to the new build by itself", (await build(page)) === 3, "build " + (await build(page)));

    const real = errors.filter(e => !/Failed to fetch|Load failed|NetworkError|network connection was lost|internet connection appears to be offline/i.test(e));
    check("no page errors and nothing left localhost", real.length === 0, real.slice(0, 5).join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  const fails = results.filter(x => !x).length;
  console.log(`\n${results.length - fails}/${results.length} passed (${ENGINE}, ${REPO})`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); server.close(); process.exit(1); });
