/**
 * Tests for the push-endpoint allowlist (issue #17).
 *
 * Without an allowlist, /api/subscribe is a generic outbound-HTTP gadget —
 * an attacker can register arbitrary endpoints and the next level change
 * makes the server fan out to them. Validation must reject:
 *   - non-https schemes (no http://, file://, gopher://)
 *   - raw IP addresses (defends against operator misconfig of the allowlist)
 *   - hosts not on the configured push-service allowlist
 *
 * The helper takes its hosts list as an argument so tests don't depend on
 * env or import order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedPushEndpoint } from "../src/endpoint.mjs";

// Allowlist semantics: a plain entry is an EXACT host match; an entry that
// starts with "." matches any strict subdomain. WNS uses a regional fleet of
// hostnames under .notify.windows.com, so we list both forms.
const ALLOW = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "notify.windows.com",
  ".notify.windows.com",
];

test("accepts the canonical FCM endpoint", () => {
  assert.equal(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/AAAAA", ALLOW), true);
});

test("accepts Mozilla autopush endpoints", () => {
  assert.equal(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc", ALLOW), true);
});

test("accepts Apple Web Push endpoints", () => {
  assert.equal(isAllowedPushEndpoint("https://web.push.apple.com/QFygi…", ALLOW), true);
});

test("accepts WNS subdomain hosts", () => {
  assert.equal(isAllowedPushEndpoint("https://wns2-am3p.notify.windows.com/?token=abc", ALLOW), true);
});

test("rejects hosts NOT on the allowlist", () => {
  assert.equal(isAllowedPushEndpoint("https://evil.example.com/push", ALLOW), false);
});

test("rejects non-https schemes", () => {
  assert.equal(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/x", ALLOW), false);
  assert.equal(isAllowedPushEndpoint("file:///etc/passwd", ALLOW), false);
});

test("rejects raw IP addresses even when the allowlist appears to match", () => {
  // Defends against operator misconfiguration: someone adding "169.254.169.254"
  // or "127.0.0.1" to the allowlist would otherwise open SSRF to metadata /
  // loopback services. The IP check refuses regardless of allowlist match.
  assert.equal(isAllowedPushEndpoint("https://169.254.169.254/iam/", ["169.254.169.254"]), false);
  assert.equal(isAllowedPushEndpoint("https://127.0.0.1:9000/", ["127.0.0.1"]), false);
  assert.equal(isAllowedPushEndpoint("https://[::1]/", ["::1"]), false);
});

test("rejects malformed URLs", () => {
  assert.equal(isAllowedPushEndpoint("not-a-url", ALLOW), false);
  assert.equal(isAllowedPushEndpoint("", ALLOW), false);
  assert.equal(isAllowedPushEndpoint(null, ALLOW), false);
});

test("treats subdomains as separate hosts unless the allowlist entry covers them", () => {
  // "fcm.googleapis.com" allows exact match; a subdomain like
  // "evil.fcm.googleapis.com" is NOT allowed.
  assert.equal(isAllowedPushEndpoint("https://evil.fcm.googleapis.com/x", ALLOW), false);
  // But "notify.windows.com" allowlist entry covers "wns2-am3p.notify.windows.com"
  // (already tested above) via the dot-suffix rule.
});
