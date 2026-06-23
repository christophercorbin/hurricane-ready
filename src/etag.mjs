/**
 * Weak ETag for /api/status (issue #55).
 *
 * /api/status was being JSON.stringify'd on every request, even though the
 * status object only changes once per tick. With a stable per-tick weak
 * etag, polling browsers get 304 Not Modified on most requests — the
 * origin writes a tiny response header instead of serializing + shipping
 * a multi-KB JSON body.
 *
 * The "weak" form (W/"…") is correct: two responses with the same etag
 * are semantically equivalent but may be byte-different (e.g., key order
 * changes). For our case they ARE byte-identical because we cache the
 * serialized body, but the weak form is the right semantic anyway.
 */
import { createHash } from "node:crypto";

export function weakEtag(serialized) {
  const hash = createHash("sha256").update(String(serialized)).digest("base64url");
  return `W/"${hash.slice(0, 16)}"`;
}
