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

test("sendPushToAll is a no-op when push is disabled", async () => {
  const r = await push.sendPushToAll({ title: "t", body: "b" });
  assert.deepEqual(r, { sent: 0, pruned: 0 });
});
