/**
 * Tests for the small lifecycle helpers used by server.mjs:
 *
 * - transitionPersistFirst — persists the new level BEFORE the caller is
 *   allowed to dispatch the alert. (Issue #20: a persistence failure must
 *   suppress dispatch so the next boot doesn't re-fire the same transition.)
 *
 * - createTickLoop — self-rescheduling loop with a single-flight guard
 *   (issue #19: overlapping ticks must not stack), graceful stop()
 *   waiting for any in-flight tick (issue #46), and small jitter to
 *   prevent fleet-wide synchronized polling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionPersistFirst, createTickLoop } from "../src/runtime.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("transitionPersistFirst calls persist with the new level on its way through", () => {
  let captured = null;
  const next = transitionPersistFirst({
    state: { level: "WATCH", history: [] },
    newLevel: "WARNING",
    timestamp: "2026-06-21T12:00:00Z",
    persist: (s) => { captured = s; },
  });
  assert.equal(captured.level, "WARNING", "persist receives the new level");
  assert.equal(captured.history.at(-1).from, "WATCH");
  assert.equal(captured.history.at(-1).to, "WARNING");
  assert.equal(next.level, "WARNING");
});

test("transitionPersistFirst rethrows if persist throws (caller suppresses dispatch)", () => {
  assert.throws(
    () => transitionPersistFirst({
      state: { level: "WATCH", history: [] },
      newLevel: "WARNING",
      timestamp: "2026-06-21T12:00:00Z",
      persist: () => { throw new Error("disk full"); },
    }),
    /disk full/,
  );
});

test("transitionPersistFirst bounds history to the most recent 50 entries", () => {
  const stale = Array.from({ length: 60 }, (_, i) => ({ at: `t${i}`, from: "X", to: "Y" }));
  const next = transitionPersistFirst({
    state: { level: "WATCH", history: stale },
    newLevel: "WARNING",
    timestamp: "2026-06-21T12:00:00Z",
    persist: () => {},
  });
  assert.equal(next.history.length, 50);
  assert.equal(next.history.at(-1).to, "WARNING");
});

test("createTickLoop.start() runs tick once on demand and self-reschedules", async () => {
  let count = 0;
  const loop = createTickLoop({
    tick: async () => { count += 1; },
    intervalMs: 30,
    jitterMs: 0,
  });
  await loop.runOnce();
  assert.equal(count, 1, "runOnce executes the tick");
  loop.start();
  await wait(120);
  loop.stop();
  assert.ok(count >= 3, `expected several scheduled ticks, got ${count}`);
});

test("createTickLoop guards against re-entry when a slow tick exceeds intervalMs (issue #19)", async () => {
  let inFlight = 0;
  let overlap = 0;
  let calls = 0;
  const loop = createTickLoop({
    tick: async () => {
      calls += 1;
      inFlight += 1;
      if (inFlight > 1) overlap += 1;
      await wait(60); // tick is slower than the interval
      inFlight -= 1;
    },
    intervalMs: 20,
    jitterMs: 0,
  });
  loop.start();
  await wait(200);
  loop.stop();
  await loop.drain();
  assert.equal(overlap, 0, "the loop must never run two ticks concurrently");
  assert.ok(calls >= 2, "the loop must continue scheduling after a slow tick");
});

test("createTickLoop.stop() + drain() waits for an in-flight tick to finish (issue #46)", async () => {
  let finished = false;
  const loop = createTickLoop({
    tick: async () => { await wait(40); finished = true; },
    intervalMs: 5,
    jitterMs: 0,
  });
  loop.start();
  await wait(10); // tick has started but not finished
  loop.stop();
  assert.equal(finished, false, "tick hasn't finished yet at stop()");
  await loop.drain();
  assert.equal(finished, true, "drain() resolves only after the in-flight tick completes");
});

test("createTickLoop.stop() prevents any further scheduled ticks", async () => {
  let count = 0;
  const loop = createTickLoop({
    tick: async () => { count += 1; },
    intervalMs: 10,
    jitterMs: 0,
  });
  loop.start();
  await wait(35);
  loop.stop();
  const after = count;
  await wait(60);
  assert.equal(count, after, "no ticks scheduled after stop()");
});
