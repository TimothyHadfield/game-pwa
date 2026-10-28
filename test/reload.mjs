// Kit self-test: leaving the page while pwa.js's deploy check (a HEAD of the page) is in flight.
// WebKit logs a fetch that a navigation cuts off as a console error ("Fetch API cannot load ... due to
// access control checks"), which made every game's "no console errors" UI test flaky. pwa.js 1.4.0
// aborts its own fetches when the page starts to leave and starts no new check while it is leaving.
//   node test/reload.mjs                 WebKit (iPhone size)
//   node test/reload.mjs --engine chromium
// The server holds every HEAD for 3 s (so the check is surely in flight) and, when asked, holds the next
// page load for 1.5 s (so "leaving" lasts long enough to see whether the check is aborted or cut later).
import http from "node:http";
import { copyFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(KIT, "test", "fixture");
const argv = process.argv.slice(2);
const ENGINE = argv.includes("--engine") ? argv[argv.indexOf("--engine") + 1] : "webkit";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://localhost:${PORT}/fixture/`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const DEPLOY = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600e3).toUTCString();
const HOLD_HEAD = 3000, HOLD_PAGE = 1500;

const KIT_FILES = [["sw.js", "sw.js"], ["pwa.js", "js/pwa.js"], ["manifest.webmanifest", "manifest.webmanifest"]];
const clean = () => { for (const [, to] of KIT_FILES) rmSync(join(FIX, to), { force: true }); };
clean();
for (const [from, to] of KIT_FILES) copyFileSync(join(KIT, from), join(FIX, to));

const heads = [];                 // { at, cutAt } per deploy check the server saw
const navs = [];                  // arrival time of each page load
let holdNext = false, headWaiter = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/fixture/")) { res.writeHead(404); return res.end(); }
  path = path.slice("/fixture/".length) || "index.html";
  const file = resolve(FIX, path);
  if (!file.startsWith(FIX + sep) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  const head = { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "max-age=600", "Last-Modified": DEPLOY };
  const send = () => { if (res.destroyed) return; if (req.method === "HEAD") { res.writeHead(200, head); return res.end(); }
    const buf = readFileSync(file); res.writeHead(200, { ...head, "Content-Length": buf.length }); res.end(buf); };
  if (req.method === "HEAD") {                       // the deploy check: answer late, so it is in flight
    const h = { at: Date.now(), cutAt: 0, answered: false };
    heads.push(h);
    res.on("close", () => { if (!h.answered) h.cutAt = Date.now(); });
    setTimeout(() => { h.answered = !res.destroyed; send(); }, HOLD_HEAD);
    if (headWaiter) { const f = headWaiter; headWaiter = null; f(); }
    return;
  }
  if (path === "index.html") {
    navs.push(Date.now());
    if (holdNext) { holdNext = false; return setTimeout(send, HOLD_PAGE); }
  }
  send();
});
const nextHead = ms => new Promise(ok => { const t = setTimeout(() => { headWaiter = null; ok(false); }, ms); headWaiter = () => { clearTimeout(t); ok(true); }; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function main() {
  await new Promise(r => server.listen(PORT, r));
  const pw = createRequire(join(homedir(), ".claude", "tools", "package.json"))("playwright");
  const browser = await pw[ENGINE].launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 659 }, isMobile: ENGINE !== "firefox", hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push("pageerror: " + (e.message || e)));
    const ready = () => page.waitForFunction("document.querySelector('#move[data-ready]') !== null", null, { timeout: 8000 }).then(() => true, () => false);

    await page.goto(BASE, { waitUntil: "load" });
    check("page draws", await ready());
    await sleep(2000);                                     // the worker installs; the first check is in flight
    await page.reload({ waitUntil: "load" }); await ready();

    // Leave the page in three ways while a check is in flight; the next page load is held 1.5 s, so a
    // check the page did not abort stays open until the new page arrives.
    const ways = [
      ["reload (browser)", () => page.reload({ waitUntil: "load" })],
      ["go to another page", () => page.goto(BASE + "?other=1", { waitUntil: "load" })],
      ["location.reload() by the game", () => Promise.all([page.waitForEvent("load"), page.evaluate(() => { location.reload(); })])],
    ];
    for (const [name, go] of ways) {
      const h = nextHead(4000);
      await page.evaluate(() => { window.PWA.check(); });
      const inFlight = await h;
      await sleep(100);
      const rec = heads[heads.length - 1];
      holdNext = true;
      const t0 = Date.now();
      await go(); await ready();
      const cut = rec && rec.cutAt ? rec.cutAt - t0 : -1;
      check(`${name}: the in-flight check is aborted as the page starts to leave`, inFlight && cut >= 0 && cut < 700,
        inFlight ? (cut < 0 ? "never cut" : `cut ${cut} ms after leaving began; new page arrived after ${HOLD_PAGE} ms`) : "no check in flight");
      await sleep(300);
    }

    // A check asked for while a navigation is already under way must not start
    holdNext = true;
    const before = heads.length;
    await Promise.all([page.waitForEvent("load"), page.evaluate(() => { location.reload(); setTimeout(() => window.PWA.check(), 100); })]);
    await ready();
    const started = heads.slice(before).filter(h => h.at < navs[navs.length - 1] + HOLD_PAGE - 100).length;
    check("no check starts while the page is leaving", started === 0, started + " started");

    // the check still works when nobody leaves: answers false (no newer deploy)
    await sleep(3500);                                     // let this page's own first check finish
    const r = await page.evaluate(() => window.PWA.check());
    check("check still answers when the page stays", r === false, String(r));
    await sleep(300);
    check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    clean();
  }
  const fails = results.filter(x => !x).length;
  console.log(`\n${results.length - fails}/${results.length} passed (${ENGINE}, leaving during the deploy check)`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); server.close(); clean(); process.exit(1); });
