/**
 * Bounded-parallelism map (issue #56).
 *
 * `sendPushToAll` previously used `Promise.all(subs.map(...))`, fanning
 * out up to MAX_SUBSCRIPTIONS (50,000) HTTPS requests concurrently —
 * which exhausts sockets, OOMs the SDK, and blocks the single-flight
 * watcher tick until the slowest one resolves. This helper caps the
 * in-flight count so the fan-out is steady-state bounded.
 *
 * Returns results in input order regardless of completion order. With
 * `{ settled: true }` it captures per-item rejections as
 * { status: "rejected", reason } so a single 410 from one push doesn't
 * drop the whole batch.
 */
export async function mapWithConcurrency(items, limit, fn, { settled = false } = {}) {
  const out = new Array(items.length);
  let next = 0;
  // Clamp `limit` to at least 1. push.mjs already guards via `Math.max(1, …)`,
  // but a future caller passing 0 / negative would otherwise silently get back
  // an array of `undefined` with no work performed. Clamping at the utility
  // surfaces the misuse instead of failing silently.
  const workerCount = Math.min(Math.max(1, limit), items.length);
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        out[i] = settled ? { status: "fulfilled", value } : value;
      } catch (reason) {
        if (!settled) throw reason;
        out[i] = { status: "rejected", reason };
      }
    }
  }
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return out;
}
