/**
 * Tests for the token-bucket per-key rate limiter (issue #17).
 *
 * /api/subscribe has no rate limit today — a single client can fill the
 * MAX_SUBSCRIPTIONS cap and starve the event loop with full-file JSON
 * writes. The limiter exposes a single `take(key)` boolean and uses an
 * injectable clock so tests don't sleep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/ratelimit.mjs";

test("take() returns true while the bucket has tokens, false after exhaustion", () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ tokensPerWindow: 3, windowMs: 60_000, now: () => now });
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), false, "fourth take in the window must be denied");
});

test("the bucket refills proportionally over time", () => {
  let now = 0;
  const rl = createRateLimiter({ tokensPerWindow: 4, windowMs: 60_000, now: () => now });
  // Spend all tokens.
  rl.take("ip"); rl.take("ip"); rl.take("ip"); rl.take("ip");
  assert.equal(rl.take("ip"), false);
  // Advance one full window — bucket refills.
  now += 60_000;
  assert.equal(rl.take("ip"), true);
});

test("the bucket caps at tokensPerWindow (no infinite refill)", () => {
  let now = 0;
  const rl = createRateLimiter({ tokensPerWindow: 2, windowMs: 1_000, now: () => now });
  // Sit idle for a year — bucket must still cap at 2.
  now += 365 * 24 * 3_600_000;
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), false);
});

test("buckets are per-key — one IP's exhaustion does not affect another", () => {
  let now = 0;
  const rl = createRateLimiter({ tokensPerWindow: 1, windowMs: 60_000, now: () => now });
  assert.equal(rl.take("alice"), true);
  assert.equal(rl.take("alice"), false);
  assert.equal(rl.take("bob"), true, "bob is on a fresh bucket");
});

test("buckets evict idle entries when the map exceeds max", () => {
  let now = 0;
  const rl = createRateLimiter({ tokensPerWindow: 1, windowMs: 1_000, now: () => now, max: 3 });
  rl.take("a"); now += 1; rl.take("b"); now += 1; rl.take("c");
  assert.ok(rl.size() <= 3);
  rl.take("d"); // exceeds — eviction kicks in
  assert.ok(rl.size() <= 3, "size must stay bounded after eviction");
});

test("partial refill: half a window restores half the tokens", () => {
  let now = 0;
  const rl = createRateLimiter({ tokensPerWindow: 4, windowMs: 60_000, now: () => now });
  rl.take("ip"); rl.take("ip"); rl.take("ip"); rl.take("ip");
  assert.equal(rl.take("ip"), false);
  // Half a window — should refill ~2 tokens (4 * 30s / 60s).
  now += 30_000;
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), true);
  assert.equal(rl.take("ip"), false, "third take in half-window must still be denied");
});
