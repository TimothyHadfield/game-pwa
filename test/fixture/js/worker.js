importScripts("rules.js?v=1");
self.onmessage = e => setTimeout(() => self.postMessage(self.Rules.answer(e.data)), 200);
