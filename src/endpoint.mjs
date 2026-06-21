/**
 * Push-endpoint allowlist (issue #17).
 *
 * /api/subscribe accepts arbitrary URLs by default — and the next level change
 * makes `web-push.sendNotification` send a real HTTPS request to whatever the
 * caller submitted. Without an allowlist that's a generic SSRF / outbound-HTTP
 * gadget. This helper restricts subscriptions to known push services and
 * additionally refuses raw IP addresses so an operator who accidentally
 * widens the host list can't open up loopback / metadata access.
 */
import { isIP } from "node:net";

export function isAllowedPushEndpoint(endpoint, hosts) {
  if (typeof endpoint !== "string" || endpoint.length === 0) return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:") return false;
  // url.hostname strips brackets from IPv6 ("[::1]" → "::1"), which is the
  // form `isIP` expects, so raw v4 + v6 addresses are both refused.
  if (isIP(url.hostname)) return false;
  // Allowlist semantics:
  //   "example.com"   → exact host match
  //   ".example.com"  → any strict subdomain (e.g. "wns2-am3p.notify.windows.com")
  return hosts.some((h) =>
    h.startsWith(".")
      ? url.hostname.endsWith(h) && url.hostname.length > h.length
      : url.hostname === h
  );
}
