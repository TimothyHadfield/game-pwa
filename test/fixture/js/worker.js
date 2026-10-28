importScripts("rules.js?v=1");
// the opening book is fetched only when the computer first thinks, from a path built at run time (like
// Connect Four's solver files): no crawler can find it, so the page lists it in pwa.js's data-extra
const BOOK = ["..", "data", "book"].join("/") + "." + "bin";
self.onmessage = e => fetch(BOOK).then(r => r.ok ? r.text() : "no book").catch(() => "no book")
  .then(book => setTimeout(() => self.postMessage(self.Rules.answer(e.data) + " " + book), 200));
