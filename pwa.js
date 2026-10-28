/* game-pwa pwa.js 1.4.0: registers sw.js and keeps an open page on the newest build.
 * Copy UNCHANGED to the game's js/ folder and load it from index.html:
 *   <script src="js/pwa.js?v=13" data-version="13" defer></script>
 * data-version = the game's build number (bump it with the other ?v= tags). Optional data-sw="sw.js".
 * Optional data-extra="js/solver.wasm data/book.bin": files the game loads later by script (not linked
 * from the page or its scripts); they are saved for offline play too.
 *
 * Fresh build check: on load, on every return to the page and when the connection comes back
 * (at most once a minute), a no-store HEAD of the page compares the server's Last-Modified with
 * this page's own. GitHub Pages stamps every file with the deploy time, so newer = a new deploy.
 * Then: if the game says it's a safe moment (PWA.safeToReload() returns true) the page reloads
 * itself once; otherwise a small "New version — tap to reload" pill appears at the top.
 *
 * API (window.PWA): version, kit, check() -> Promise<boolean>, safeToReload (set to a function),
 * onUpdate(fn), reload(), status() -> Promise<{kit, build, cache}|null>.
 */
(function () {
  "use strict";
  var KIT = "1.4.0";
  var me = document.currentScript;
  var build = (me && me.getAttribute("data-version")) || "0";
  var swPath = (me && me.getAttribute("data-sw")) || "sw.js";
  var extra = ((me && me.getAttribute("data-extra")) || "").split(/[\s,]+/).filter(Boolean);
  var pageUrl = function () { return location.href.split("#")[0]; };
  var base = Date.parse(document.lastModified);
  var lastCheck = 0, shownFor = 0, dismissed = 0, listeners = [], pill = null;
  var http = location.protocol === "https:" || location.protocol === "http:";
  // Leaving the page: the kit's own fetches still in flight are aborted first (WebKit logs a fetch the
  // navigation cuts off as a console error, "... due to access control checks"), and no new check starts.
  var flying = [], leftAt = 0, gone = false;
  function own(opts) {
    if (typeof AbortController !== "function") return { opts: opts, done: function () {} };
    var c = new AbortController();
    opts.signal = c.signal; flying.push(c);
    return { opts: opts, done: function () { var i = flying.indexOf(c); if (i >= 0) flying.splice(i, 1); } };
  }
  function abortAll() { flying.splice(0).forEach(function (c) { try { c.abort(); } catch (e) {} }); }
  function leaving() { return gone || Date.now() - leftAt < 3000; }

  var PWA = window.PWA = {
    kit: KIT, version: build, safeToReload: null,
    onUpdate: function (fn) { listeners.push(fn); },
    check: function () { return check(true); },
    reload: function () { reload(false); },
    status: status
  };

  function status() {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return Promise.resolve(null);
    return new Promise(function (ok) {
      var ch = new MessageChannel();
      var t = setTimeout(function () { ok(null); }, 2000);
      ch.port1.onmessage = function (e) { clearTimeout(t); ok(e.data); };
      navigator.serviceWorker.controller.postMessage({ type: "pwa:version" }, [ch.port2]);
    });
  }

  // auto: a reload the kit started by itself; it re-asks the game right before reloading (a player may
  // have started something in the moment it took) and shows the pill instead if the answer changed.
  function reload(auto) {
    var f = own({ cache: "reload" });
    var once = false;
    var done = function () {
      if (once) return; once = true;
      if (auto === true && !safe()) { showPill(Date.now()); return; }
      abortAll();                                   // a fetch still running after 2.5 s: abort it, don't cut it
      location.reload();
    };
    var t = setTimeout(done, 2500);
    var upd = ("serviceWorker" in navigator) ? navigator.serviceWorker.getRegistration().then(function (r) { return r && r.update(); }) : Promise.resolve();
    var page = fetch(pageUrl(), f.opts).then(f.done, function (e) { f.done(); throw e; });
    Promise.all([upd, page]).catch(function () {}).then(function () { clearTimeout(t); done(); });
  }

  function safe() {
    try { return typeof PWA.safeToReload === "function" && PWA.safeToReload() === true; } catch (e) { return false; }
  }

  function showPill(stamp) {
    if (stamp <= dismissed) return;
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "pwa-pill";
      pill.setAttribute("role", "status");
      pill.style.cssText = "position:fixed;left:50%;top:calc(8px + env(safe-area-inset-top,0px));transform:translateX(-50%);" +
        "z-index:2147483000;display:flex;align-items:center;gap:2px;max-width:calc(100vw - 32px);" +
        "background:#1d2230;color:#e8ecf4;border:1px solid #3a4256;border-radius:999px;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.45);font:600 14px/1.2 system-ui,-apple-system,sans-serif";
      var go = document.createElement("button");
      go.type = "button"; go.className = "pwa-reload";
      go.textContent = "New version — tap to reload";
      go.style.cssText = "all:unset;cursor:pointer;padding:10px 6px 10px 16px;white-space:nowrap";
      go.addEventListener("click", function (e) { e.stopPropagation(); go.textContent = "Reloading…"; reload(false); });
      var x = document.createElement("button");
      x.type = "button"; x.className = "pwa-close"; x.setAttribute("aria-label", "Later");
      x.textContent = "×";
      x.style.cssText = "all:unset;cursor:pointer;padding:8px 14px 8px 8px;font-size:18px;opacity:.7";
      x.addEventListener("click", function (e) { e.stopPropagation(); dismissed = shownFor; pill.remove(); pill = null; });
      pill.appendChild(go); pill.appendChild(x);
    }
    shownFor = stamp;
    if (!pill.isConnected) document.body.appendChild(pill);
  }

  function found(stamp) {
    listeners.forEach(function (fn) { try { fn({ build: build, lastModified: stamp }); } catch (e) {} });
    var key = "pwa-auto:" + location.pathname;
    var tried = 0;
    try { tried = +sessionStorage.getItem(key) || 0; } catch (e) {}
    if (document.visibilityState === "visible" && safe() && tried !== stamp) {
      try { sessionStorage.setItem(key, String(stamp)); } catch (e) {}
      reload(true);
    } else {
      showPill(stamp);
    }
  }

  function check(force) {
    if (!http || isNaN(base) || leaving()) return Promise.resolve(false);
    var now = Date.now();
    if (!force && now - lastCheck < 60000) return Promise.resolve(false);
    lastCheck = now;
    var f = own({ method: "HEAD", cache: "no-store" });
    return fetch(pageUrl(), f.opts).then(function (r) {
      f.done();
      var lm = Date.parse(r.headers.get("Last-Modified") || "");
      if (r.ok && lm > base && !leaving()) { found(lm); return true; }
      return false;
    }).catch(function () { f.done(); return false; });   // offline, or aborted because the page is leaving
  }

  function register() {
    if (!("serviceWorker" in navigator) || !http) return;
    var url = swPath + (swPath.indexOf("?") < 0 ? "?" : "&") + "v=" + encodeURIComponent(build);
    navigator.serviceWorker.register(url, { scope: "./", updateViaCache: "none" }).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      // first visit: the page loaded before the worker existed, so hand it everything already fetched
      var send = function () {
        var urls = [pageUrl()];
        try { performance.getEntriesByType("resource").forEach(function (e) { urls.push(e.name); }); } catch (e) {}
        // the game's later-loaded files (data-extra), in case this build's worker installed before they were listed
        extra.forEach(function (u) { try { urls.push(new URL(u, location.href).href); } catch (e) {} });
        if (reg.active) reg.active.postMessage({ type: "pwa:cache", urls: urls });
      };
      if (document.readyState === "complete") send(); else addEventListener("load", send);
    }).catch(function () {});
  }

  register();
  setTimeout(function () { check(true); }, 1500);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(false); });
  addEventListener("online", function () { check(true); });
  // beforeunload: a navigation is starting (it may still be cancelled, so checks resume after 3 s);
  // pagehide: the page is going away (or into the back/forward cache), pageshow: it's back.
  addEventListener("beforeunload", function () { leftAt = Date.now(); abortAll(); });
  addEventListener("pagehide", function () { gone = true; abortAll(); });
  addEventListener("pageshow", function (e) { gone = false; leftAt = 0; if (e.persisted) check(true); });
})();
