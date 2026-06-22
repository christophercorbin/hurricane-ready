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
import { transitionPersistFirst, createTickLoop, shouldDispatchOnTransition, pruneCacheToActive, briefingThrottleKey, shouldRegenerateBriefing } from "../src/runtime.mjs";

test("pruneCacheToActive drops entries whose IDs are not in the active set (issue #41)", () => {
  // Without pruning, the advisoryCache grows for the life of the process —
  // every storm the NHC has ever advised stays in memory, and a future
  // storm reusing the same ID (e.g. AL01 next season) sees a stale advNum
  // and skips a refresh that should have happened.
  const cache = new Map([
    ["al012025", { advNum: "3", parsed: {} }],
    ["al022025", { advNum: "1", parsed: {} }],
    ["al012026", { advNum: "5", parsed: {} }],
  ]);
  pruneCacheToActive(cache, ["al012026", "al032026"]);
  assert.deepEqual([...cache.keys()].sort(), ["al012026"]);
});

test("pruneCacheToActive is a no-op when every cached id is still active", () => {
  const cache = new Map([["al012026", { advNum: "5", parsed: {} }]]);
  pruneCacheToActive(cache, ["al012026"]);
  assert.equal(cache.size, 1);
});

test("briefingThrottleKey identifies a storm by id only (issue #42)", () => {
  // Distance moves don't change the key. Storm identity does.
  assert.deepEqual(briefingThrottleKey({ id: "al012026", km: 250 }), { id: "al012026" });
  assert.deepEqual(briefingThrottleKey({ id: null, km: null }), { id: null });
});

test("shouldRegenerateBriefing fires on first run", () => {
  const decide = (input) => shouldRegenerateBriefing(input);
  assert.equal(decide({ levelChanged: false, hasBriefing: false, lastKey: null, currentKey: { id: "al012026" }, distMoved: false }), true);
});

test("shouldRegenerateBriefing fires on level change (regardless of distance)", () => {
  const decide = (input) => shouldRegenerateBriefing(input);
  assert.equal(decide({ levelChanged: true, hasBriefing: true, lastKey: { id: "al012026" }, currentKey: { id: "al012026" }, distMoved: false }), true);
});

test("shouldRegenerateBriefing fires when storm identity changes even without level change (issue #42)", () => {
  // Pre-fix, lastBriefingKm was a bare number — a new storm appearing at a
  // similar km from the previous one would NOT trigger regen, leaving the
  // briefing referring to the wrong storm.
  const decide = (input) => shouldRegenerateBriefing(input);
  assert.equal(decide({
    levelChanged: false, hasBriefing: true,
    lastKey: { id: "al012026" }, currentKey: { id: "al022026" },
    distMoved: false,
  }), true);
});

test("shouldRegenerateBriefing fires on >50 km drift for the same storm", () => {
  const decide = (input) => shouldRegenerateBriefing(input);
  assert.equal(decide({
    levelChanged: false, hasBriefing: true,
    lastKey: { id: "al012026" }, currentKey: { id: "al012026" },
    distMoved: true,
  }), true);
});

test("shouldRegenerateBriefing stays put when nothing material changed", () => {
  const decide = (input) => shouldRegenerateBriefing(input);
  assert.equal(decide({
    levelChanged: false, hasBriefing: true,
    lastKey: { id: "al012026" }, currentKey: { id: "al012026" },
    distMoved: false,
  }), false);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("shouldDispatchOnTransition allows dispatch in live mode (issue #40)", () => {
  assert.equal(shouldDispatchOnTransition({ replay: false, replayDispatch: false }), true);
  assert.equal(shouldDispatchOnTransition({ replay: false, replayDispatch: true }), true);
});

test("shouldDispatchOnTransition suppresses dispatch in replay mode by default", () => {
  // Without this gate, every container restart in REPLAY=1 mode re-fired
  // SES / SNS / webhook / push to operators' real channels as the Beryl
  // ladder climbed past WATCH, WARNING, IMMINENT, and back to ALL_CLEAR.
  assert.equal(shouldDispatchOnTransition({ replay: true, replayDispatch: false }), false);
});

test("shouldDispatchOnTransition allows dispatch in replay mode only when explicitly opted in", () => {
  // REPLAY_DISPATCH=1 is the escape hatch for end-to-end testing the actual
  // channels against a real SES-verified sender.
  assert.equal(shouldDispatchOnTransition({ replay: true, replayDispatch: true }), true);
});

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
