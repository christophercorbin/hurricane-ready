import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

// Isolate the subscription store to a temp file BEFORE importing the module.
const subsFile = path.join(tmpdir(), `hr-subs-${process.pid}.json`);
process.env.SUBS_FILE = subsFile;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
// Test fixture endpoints use the host "x" — pin the allowlist to match so the
// existing add/remove tests still exercise valid endpoints.
process.env.PUSH_ALLOWED_HOSTS = "x";

const push = await import("../src/push.mjs");

test.after(() => { try { rmSync(subsFile); } catch { /* ignore */ } });

test("push disabled without VAPID keys", () => {
  assert.equal(push.pushEnabled, false);
  assert.equal(push.vapidPublicKey(), null);
});

const sub = (n) => ({ endpoint: `https://x/${n}`, keys: { p256dh: "a", auth: "b" } });

test("add/remove subscriptions, de-duplicated by endpoint", () => {
  assert.equal(push.subscriptionCount(), 0);
  assert.equal(push.addSubscription(sub(1)), true);
  push.addSubscription(sub(1)); // duplicate
  push.addSubscription(sub(2));
  assert.equal(push.subscriptionCount(), 2);
  push.removeSubscription("https://x/1");
  assert.equal(push.subscriptionCount(), 1);
});

test("addSubscription rejects malformed input", () => {
  assert.equal(push.addSubscription(null), false);
  assert.equal(push.addSubscription({}), false);
  assert.equal(push.addSubscription({ endpoint: "https://x/9" }), false); // no keys
});

test("addSubscription rejects endpoints whose host is not in the allowlist (issue #17)", () => {
  // Host not in PUSH_ALLOWED_HOSTS ("x" only) → reject.
  const bad = { endpoint: "https://attacker.example.com/push", keys: { p256dh: "a", auth: "b" } };
  assert.equal(push.addSubscription(bad), false);
});

test("addSubscription rejects raw IP endpoints (defense vs SSRF)", () => {
  const ip = { endpoint: "https://169.254.169.254/iam/", keys: { p256dh: "a", auth: "b" } };
  assert.equal(push.addSubscription(ip), false);
});

test("addSubscription rejects http:// endpoints (https only)", () => {
  const cleartext = { endpoint: "http://x/insecure", keys: { p256dh: "a", auth: "b" } };
  assert.equal(push.addSubscription(cleartext), false);
});

test("removeSubscription returns true when the endpoint was present, false otherwise (issue #17)", () => {
  // From earlier tests, https://x/2 is still subscribed; https://x/1 was removed.
  assert.equal(push.removeSubscription("https://x/2"), true, "removing a real subscription returns true");
  assert.equal(push.removeSubscription("https://x/never-existed"), false, "removing an unknown endpoint returns false");
});

test("sendPushToAll is a no-op when push is disabled", async () => {
  const r = await push.sendPushToAll({ title: "t", body: "b", level: "WATCH" });
  assert.equal(r.sent, 0);
  assert.equal(r.pruned, 0);
});
