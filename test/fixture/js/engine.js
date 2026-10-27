// Fixture "computer": answers a move after a short think, in a worker like the real games do.
window.Engine = {
  think: n => new Promise(ok => {
    const w = new Worker("js/worker.js?v=1");
    w.onmessage = e => { ok(e.data); w.terminate(); };
    w.postMessage(n);
  })
};
