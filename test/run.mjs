// Kit self-test: copies sw.js, pwa.js and the manifest into test/fixture (a tiny game with a worker,
// module imports, a css url() and a CDN-only online path), then runs tools/pwa-check.mjs on it.
//   node test/run.mjs              WebKit (iPhone size)
//   node test/run.mjs --engine chromium
//   node test/run.mjs --no-kit     the same fixture WITHOUT the kit: must FAIL (proves the check isn't vacuous)
import { copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(KIT, "test", "fixture");
const args = process.argv.slice(2);
const noKit = args.includes("--no-kit");
for (const f of ["sw.js", "js/pwa.js", "manifest.webmanifest"]) rmSync(join(FIX, f), { force: true });
if (!noKit) {
  copyFileSync(join(KIT, "sw.js"), join(FIX, "sw.js"));
  copyFileSync(join(KIT, "pwa.js"), join(FIX, "js", "pwa.js"));
  copyFileSync(join(KIT, "manifest.webmanifest"), join(FIX, "manifest.webmanifest"));
}
const r = spawnSync(process.execPath, [join(KIT, "tools", "pwa-check.mjs"), "--dir", FIX, ...args.filter(a => a !== "--no-kit")], { stdio: "inherit" });
for (const f of ["sw.js", "js/pwa.js", "manifest.webmanifest"]) rmSync(join(FIX, f), { force: true });
process.exit(noKit ? (r.status === 0 ? 1 : 0) : r.status);
