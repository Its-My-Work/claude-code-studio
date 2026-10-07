'use strict';
// Per-provider in-flight cap. A multi-agent wave can start a dozen CLI subprocesses on one
// provider at once; most providers answer the burst with 429s the CLI then retries with its own
// backoff — slower than simply queueing here. FIFO, and a queued request whose client went away
// leaves the queue instead of occupying a slot later.

function createLimiter(max = 6) {
  let limit = Math.max(1, max | 0);
  let active = 0;
  const queue = [];

  function grant() {
    while (active < limit && queue.length) {
      const w = queue.shift();
      if (w.cancelled) continue;
      active++;
      w.resolve(makeRelease());
    }
  }

  function makeRelease() {
    let done = false;
    return () => { if (done) return; done = true; active--; grant(); };
  }

  return {
    /** -> Promise<release()>. Rejects with code 'ABORTED' if `signal` fires while queued. */
    acquire(signal) {
      if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('client disconnected'), { code: 'ABORTED' }));
      if (active < limit && !queue.length) { active++; return Promise.resolve(makeRelease()); }
      return new Promise((resolve, reject) => {
        const w = { resolve, cancelled: false };
        queue.push(w);
        if (signal) {
          signal.addEventListener('abort', () => {
            if (w.cancelled) return;
            const i = queue.indexOf(w);
            if (i >= 0) { queue.splice(i, 1); w.cancelled = true; reject(Object.assign(new Error('client disconnected'), { code: 'ABORTED' })); }
          }, { once: true });
        }
      });
    },
    setMax(n) { const v = Math.max(1, n | 0); if (v !== limit) { limit = v; grant(); } },
    stats: () => ({ active, queued: queue.length, limit }),
  };
}

module.exports = { createLimiter };
