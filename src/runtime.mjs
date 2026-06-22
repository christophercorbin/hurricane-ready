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

/**
 * Decide whether a level-change transition should fan out to SES / SNS /
 * webhook / push (issue #40). Live mode always dispatches. Replay mode
 * suppresses by default — without this gate, every container restart in
 * REPLAY=1 demo mode resent real alerts to operators' phones and inboxes
 * as the Beryl ladder climbed past WATCH, WARNING, IMMINENT, ALL_CLEAR.
 * `REPLAY_DISPATCH=1` is the explicit opt-in for end-to-end channel testing.
 */
export function shouldDispatchOnTransition({ replay, replayDispatch }) {
  return !replay || Boolean(replayDispatch);
}

/**
 * Drop cache entries whose IDs are no longer in the active set (issue #41).
 * Without this, advisoryCache grows unbounded for the life of the process —
 * every storm the NHC has ever advised stays in memory, and a reused storm
 * ID (e.g. AL01 next season) compares against the prior season's advNum and
 * skips a refresh that should have happened.
 */
export function pruneCacheToActive(cache, activeIds) {
  const keep = new Set(activeIds);
  for (const id of cache.keys()) {
    if (!keep.has(id)) cache.delete(id);
  }
}

/**
 * Briefing throttle key (issue #42). Pre-fix, the throttle compared the
 * primary storm's closest-approach km to a bare number — so a new storm
 * appearing at a similar km from the previous (now-departed) storm would
 * not regenerate the briefing, leaving the text referring to the wrong
 * system. Keying on storm id makes identity changes the trigger.
 */
export function briefingThrottleKey({ id }) {
  return { id: id ?? null };
}

/**
 * Decide whether to regenerate the calm briefing for this tick (issue #42).
 * Returns true on first run, on a level change, when the storm's identity
 * changed since the last briefing, or when the primary storm's closest
 * approach has drifted > 50 km (signaled by `distMoved`).
 */
export function shouldRegenerateBriefing({ levelChanged, hasBriefing, lastKey, currentKey, distMoved }) {
  if (!hasBriefing) return true;
  if (levelChanged) return true;
  if (!lastKey || lastKey.id !== currentKey.id) return true;
  return Boolean(distMoved);
}

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
