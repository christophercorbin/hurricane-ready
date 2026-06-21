/**
 * Per-key token-bucket rate limiter (issue #17).
 *
 * `take(key)` returns true when the caller is within budget; false when the
 * bucket is exhausted. Buckets refill linearly over `windowMs`. An eviction
 * sweep keeps the map bounded so a flood of unique keys can't grow forever.
 *
 * The clock is injectable so tests can advance time deterministically and
 * production gets a sane default.
 */
export function createRateLimiter({ tokensPerWindow, windowMs, now = Date.now, max = 10_000 }) {
  const buckets = new Map(); // key -> { tokens, lastRefill }

  function refill(b, t) {
    const elapsed = t - b.lastRefill;
    if (elapsed <= 0) return;
    const refilled = (elapsed / windowMs) * tokensPerWindow;
    b.tokens = Math.min(tokensPerWindow, b.tokens + refilled);
    b.lastRefill = t;
  }

  function evictIfFull() {
    if (buckets.size < max) return;
    // Remove the oldest 25% by insertion order (oldest entries are also
    // the most likely to have idled and refilled to cap — cheap to recreate).
    const drop = Math.max(1, Math.floor(max / 4));
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= drop) break;
      buckets.delete(k);
    }
  }

  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        evictIfFull();
        b = { tokens: tokensPerWindow, lastRefill: t };
        buckets.set(key, b);
      } else {
        refill(b, t);
      }
      if (b.tokens >= 1) { b.tokens -= 1; return true; }
      return false;
    },
    size() { return buckets.size; },
  };
}
