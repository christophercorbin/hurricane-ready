/**
 * Tests for unsubscribe-token (issue #18).
 *
 * Pre-fix, anyone who learned a push endpoint URL could silently
 * unsubscribe that browser. Now /api/subscribe returns an opaque
 * HMAC(endpoint, secret) and /api/unsubscribe requires it back.
 *
 * The token is deterministic from (endpoint, secret) so the server
 * doesn't need to remember it per subscription — recomputed on each
 * unsubscribe call. That keeps the on-disk subs.json shape unchanged
 * and lets pre-existing subscriptions be unsubscribed by any client
 * that knows both the endpoint AND the secret (which is server-side).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUnsubscribeToken } from "../src/unsubscribe-token.mjs";

test("token is deterministic given the same endpoint + secret", () => {
  const a = computeUnsubscribeToken("https://fcm.googleapis.com/fcm/send/abc", "secret-A");
  const b = computeUnsubscribeToken("https://fcm.googleapis.com/fcm/send/abc", "secret-A");
  assert.equal(a, b);
});

test("token changes when the endpoint changes (different subscription → different token)", () => {
  const a = computeUnsubscribeToken("https://fcm.googleapis.com/fcm/send/abc", "secret-A");
  const b = computeUnsubscribeToken("https://fcm.googleapis.com/fcm/send/xyz", "secret-A");
  assert.notEqual(a, b);
});

test("token changes when the secret rotates (invalidates every existing token)", () => {
  const a = computeUnsubscribeToken("https://fcm.googleapis.com/fcm/send/abc", "secret-A");
  const b = computeUnsubscribeToken("https://fcm.googleapis.com/fcm/send/abc", "secret-B");
  assert.notEqual(a, b);
});

test("token is URL-safe base64 (no +, /, = that would break in query strings or JSON)", () => {
  const t = computeUnsubscribeToken("https://x/y", "s");
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test("token is long enough to resist brute force (>= 32 characters)", () => {
  // base64url of 32 bytes is ~43 chars; we want at least ~32 chars for ~192 bits of entropy.
  const t = computeUnsubscribeToken("https://x/y", "s");
  assert.ok(t.length >= 32, `expected >= 32 chars, got ${t.length}`);
});

test("token is constant-time-safe to compare (returns the same string class for the same input)", () => {
  // Not a real constant-time test — just verifies the helper returns a
  // plain string that callers can compare via timingSafeEqual.
  const t = computeUnsubscribeToken("https://x/y", "s");
  assert.equal(typeof t, "string");
});
