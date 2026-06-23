/**
 * Tests for mapWithConcurrency (issue #56).
 *
 * sendPushToAll previously fired Promise.all over up to MAX_SUBSCRIPTIONS
 * (50,000) concurrent HTTPS requests at once — exhausting sockets, OOM'ing
 * the SDK, and blocking the single-flight watcher tick. This helper caps
 * the in-flight count so the fan-out is steady-state bounded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../src/concurrency.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("returns results in input order regardless of completion order", async () => {
  const items = [40, 10, 30, 20];
  // Each item sleeps for its value then returns that value × 2.
  const results = await mapWithConcurrency(items, 2, async (n) => {
    await wait(n);
    return n * 2;
  });
  assert.deepEqual(results, [80, 20, 60, 40]);
});

test("never runs more than `limit` items in flight at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await wait(15);
    inFlight -= 1;
  });
  assert.ok(peak <= 4, `peak ${peak} exceeded limit 4`);
  assert.equal(peak, 4, "peak should reach the limit when work is plentiful");
});

test("processes every item exactly once", async () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const seen = new Set();
  await mapWithConcurrency(items, 5, async (n) => {
    if (seen.has(n)) throw new Error(`duplicate ${n}`);
    seen.add(n);
    return n;
  });
  assert.equal(seen.size, 30);
});

test("captures per-item errors as Promise.allSettled-style results without aborting the batch", async () => {
  const items = [1, 2, 3, 4];
  // The helper resolves to { status, value? , reason? } per item so a
  // single 410 from one push doesn't drop the whole fan-out.
  const settled = await mapWithConcurrency(items, 2, async (n) => {
    if (n === 3) throw new Error("simulated 410");
    return n * 10;
  }, { settled: true });
  assert.deepEqual(settled, [
    { status: "fulfilled", value: 10 },
    { status: "fulfilled", value: 20 },
    { status: "rejected", reason: new Error("simulated 410") },
    { status: "fulfilled", value: 40 },
  ]);
});

test("limit greater than items.length is fine (effectively unlimited for that batch)", async () => {
  const r = await mapWithConcurrency([1, 2, 3], 100, async (n) => n + 1);
  assert.deepEqual(r, [2, 3, 4]);
});

test("empty input resolves to an empty array immediately", async () => {
  const r = await mapWithConcurrency([], 5, async (n) => n);
  assert.deepEqual(r, []);
});

test("limit <= 0 is clamped to 1 so the helper never silently no-ops", async () => {
  // Defense-in-depth (#56 follow-up). push.mjs already guards
  // `Math.max(1, …)` on PUSH_CONCURRENCY, but a future caller that passes
  // 0 or a negative limit should not get back an array of `undefined`
  // with zero work done — surface the misuse by still processing the batch.
  for (const limit of [0, -3, -Infinity]) {
    const r = await mapWithConcurrency([1, 2, 3], limit, async (n) => n * 2);
    assert.deepEqual(r, [2, 4, 6], `limit=${limit} should still process every item`);
  }
});
