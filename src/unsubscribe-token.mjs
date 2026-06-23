/**
 * Unsubscribe token (issue #18).
 *
 * Pre-fix, /api/unsubscribe removed any subscription whose endpoint
 * matched the request body — no auth, no ownership check. Anyone who
 * learned an endpoint URL (via SSRF, leaked log, browser memory dump,
 * referrer) could silently mute that subscriber.
 *
 * The fix: when a client subscribes, the server returns an opaque token
 * = HMAC-SHA-256(endpoint, server-secret). The client passes it back on
 * unsubscribe. The server recomputes and compares (constant-time). The
 * token is deterministic so the server doesn't need to store per-record
 * state — recomputed on demand from the existing endpoint + the secret.
 *
 * Secret rotation invalidates every existing token at once. That's the
 * intended escape hatch.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function computeUnsubscribeToken(endpoint, secret) {
  return createHmac("sha256", secret)
    .update(endpoint)
    .digest("base64url");
}

export function unsubscribeTokenMatches(endpoint, secret, submittedToken) {
  if (typeof submittedToken !== "string" || submittedToken.length === 0) return false;
  const expected = Buffer.from(computeUnsubscribeToken(endpoint, secret));
  const provided = Buffer.from(submittedToken);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
