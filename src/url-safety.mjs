/**
 * Outbound-URL validation (issue #53).
 *
 * Every URL the server fetches comes from env (NHC, CAPEWS, Open-Meteo,
 * WEBHOOK_URL) or is a request body (web-push endpoint — handled in
 * endpoint.mjs). Without scheme/host validation at boot, a misconfigured
 * env (typo, leaked CI variable, env injection) could redirect those
 * polls / dispatches to internal AWS endpoints (169.254.169.254 metadata,
 * internal ALB / RDS) or to attacker-controlled hosts.
 *
 * This validator runs at config load — `throw` here means the container
 * refuses to boot, which is exactly what you want when an outbound URL
 * is misconfigured.
 */
import { isIP } from "node:net";

// Private / loopback / link-local / metadata IPv4 + IPv6 ranges.
const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.)/;
const PRIVATE_IPV6 = /^(::1|::ffff:127\.|fc|fd|fe[89ab])/i;

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
]);

function isPrivateIp(host) {
  // URL.hostname includes brackets for IPv6 ("[::1]"). isIP wants them
  // stripped — match both forms.
  const bare = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (!isIP(bare)) return false;
  if (PRIVATE_IPV4.test(bare)) return true;
  if (PRIVATE_IPV6.test(bare)) return true;
  return false;
}

function hostMatchesAllowlist(host, hosts) {
  return hosts.some((h) =>
    h.startsWith(".")
      ? host.endsWith(h) && host.length > h.length
      : host === h
  );
}

export function validateOutboundUrl(name, value, opts = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https (got ${url.protocol}//): ${value}`);
  }

  const host = url.hostname;
  if (isPrivateIp(host)) {
    throw new Error(`${name} must not point at a private/loopback/metadata IP: ${host}`);
  }
  if (METADATA_HOSTS.has(host.toLowerCase())) {
    throw new Error(`${name} must not target a metadata service: ${host}`);
  }

  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    if (!hostMatchesAllowlist(host, opts.allowedHosts)) {
      throw new Error(`${name} host '${host}' is not in the allowlist`);
    }
  }

  return url;
}
