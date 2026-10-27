// game-pwa make-icons 1.0.0: draws the home-screen icons from the game's icon.svg (headless Chromium, $0).
//   node tools/make-icons.mjs [--dir <game folder>] [--bg "#0f1117"] [--force]
// Writes (skips a file that already exists unless --force):
//   apple-touch-icon.png        180x180, solid background (iPhone home screen; iOS shows transparency as black)
//   icons/icon-192.png          192x192, transparent, for the manifest
//   icons/icon-512.png          512x512, transparent, for the manifest
//   icons/icon-maskable-512.png 512x512, icon at 80% on the solid background (Android's round/squircle crop)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = resolve(opt("dir", join(dirname(fileURLToPath(import.meta.url)), "..")));
const BG = opt("bg", "#0f1117");
const FORCE = argv.includes("--force");
const svg = readFileSync(join(DIR, "icon.svg"), "utf8");
const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

const jobs = [
  { file: "apple-touch-icon.png", size: 180, scale: 1, bg: BG },
  { file: "icons/icon-192.png", size: 192, scale: 1, bg: null },
  { file: "icons/icon-512.png", size: 512, scale: 1, bg: null },
  { file: "icons/icon-maskable-512.png", size: 512, scale: 0.8, bg: BG }
];

const pw = createRequire(join(homedir(), ".claude", "tools", "package.json"))("playwright");
const browser = await pw.chromium.launch();
try {
  const page = await browser.newPage();
  for (const j of jobs) {
    const out = join(DIR, j.file);
    if (existsSync(out) && !FORCE) { console.log("kept   " + j.file + " (exists; --force to redraw)"); continue; }
    mkdirSync(dirname(out), { recursive: true });
    await page.setViewportSize({ width: j.size, height: j.size });
    const inner = Math.round(j.size * j.scale);
    await page.setContent(`<html><body style="margin:0;width:${j.size}px;height:${j.size}px;display:grid;place-items:center;background:${j.bg || "transparent"}">` +
      `<img src="${src}" style="width:${inner}px;height:${inner}px;display:block"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
    writeFileSync(out, await page.screenshot({ omitBackground: !j.bg, clip: { x: 0, y: 0, width: j.size, height: j.size } }));
    console.log("wrote  " + j.file + " " + j.size + "px");
  }
} finally { await browser.close(); }
