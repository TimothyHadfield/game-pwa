import { label } from "./ui.mjs?v=1";
let playing = false;
document.getElementById("move").addEventListener("click", async () => {
  playing = true;
  document.getElementById("reply").textContent = label(await window.Engine.think(1));
});
document.getElementById("move").dataset.ready = "1";
// Online lives behind a dynamic import from a CDN, like the real games: never needed offline.
window.goOnline = () => import("https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js");
if (window.PWA) window.PWA.safeToReload = () => !playing;
else addEventListener("load", () => { window.PWA.safeToReload = () => !playing; });
window.rest = () => { playing = false; };
