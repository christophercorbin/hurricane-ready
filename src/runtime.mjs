/**
 * Lifecycle helpers for server.mjs.
 *
 * `transitionPersistFirst` records a level transition by persisting the new
 * level BEFORE the caller dispatches the alert (issue #20). If persist throws,
 * the caller catches and suppresses dispatch — the next tick re-attempts the
 * transition, so the alert isn't lost and a crash-between-persist-and-dispatch
 * can't re-fire on next boot.
 *
 * `createTickLoop` returns {start, stop, runOnce, drain} for a self-rescheduling
 * loop with a single-flight guard (issue #19) and graceful stop (issue #46).
 */

export function transitionPersistFirst({ state, newLevel, timestamp, persist }) {
  const history = [
    ...state.history,
    { at: timestamp, from: state.level, to: newLevel },
  ].slice(-50);
  // persist throws on failure → caller catches and skips dispatch
  persist({ level: newLevel, history });
  return { level: newLevel, history };
}

export function createTickLoop({ tick, intervalMs, jitterMs = 0 }) {
  let timer = null;
  let stopped = true;
  let busy = null; // Promise of in-flight tick, or null

  function nextDelay() {
    const j = jitterMs > 0 ? Math.random() * jitterMs : 0;
    return intervalMs + j;
  }

  async function runOnce() {
    if (busy) return busy;
    busy = (async () => {
      try { await tick(); } finally { busy = null; }
    })();
    return busy;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await runOnce();
      schedule();
    }, nextDelay());
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    async drain() {
      if (busy) await busy;
    },
  };
}
