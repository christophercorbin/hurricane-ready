/**
 * Tests for validateOutboundUrl (issue #53).
 *
 * The server makes outbound HTTPS to NHC, CAPEWS, Open-Meteo, AWS APIs,
 * and an operator-configured WEBHOOK_URL. Without scheme/host validation
 * at boot, a misconfigured env var (typo, leaked CI variable, env
 * injection) could redirect those calls to internal AWS endpoints
 * (169.254.169.254 metadata, internal ALB, RDS) or to attacker-
 * controlled hosts. The validator fails-fast at config load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOutboundUrl } from "../src/url-safety.mjs";

test("accepts a normal https URL with no allowlist", () => {
  const u = validateOutboundUrl("WEBHOOK_URL", "https://hooks.example.com/x");
  assert.equal(u.hostname, "hooks.example.com");
});

test("rejects http (cleartext) URLs", () => {
  assert.throws(
    () => validateOutboundUrl("WEBHOOK_URL", "http://hooks.example.com/x"),
    /must use https/,
  );
});

test("rejects non-URL strings", () => {
  assert.throws(() => validateOutboundUrl("X", "not-a-url"), /not a valid URL/);
  assert.throws(() => validateOutboundUrl("X", ""), /is required/);
});

test("rejects the AWS instance-metadata IP (169.254.169.254) — SSRF defense", () => {
  assert.throws(
    () => validateOutboundUrl("WEBHOOK_URL", "https://169.254.169.254/iam/"),
    /private\/loopback\/metadata/i,
  );
});

test("rejects loopback IPv4 (127.x)", () => {
  assert.throws(() => validateOutboundUrl("X", "https://127.0.0.1/"), /private\/loopback/i);
  assert.throws(() => validateOutboundUrl("X", "https://127.1.2.3:9000/"), /private\/loopback/i);
});

test("rejects RFC1918 private IPs", () => {
  assert.throws(() => validateOutboundUrl("X", "https://10.0.0.5/"), /private\/loopback/i);
  assert.throws(() => validateOutboundUrl("X", "https://192.168.1.1/"), /private\/loopback/i);
  assert.throws(() => validateOutboundUrl("X", "https://172.16.0.1/"), /private\/loopback/i);
  assert.throws(() => validateOutboundUrl("X", "https://172.31.255.255/"), /private\/loopback/i);
});

test("rejects loopback IPv6 (::1) — including bracketed form in URL", () => {
  assert.throws(() => validateOutboundUrl("X", "https://[::1]/"), /private\/loopback/i);
});

test("rejects IPv4-mapped IPv6 forms — closes the ::ffff:<v4> SSRF bypass", () => {
  // URL normalization turns these into ::ffff:a9fe:a9fe / ::ffff:7f00:1 / ::ffff:a00:5,
  // which pre-fix passed validation because the regex only matched ::ffff:127.
  // After fix, ANY ::ffff: prefix is refused — no legitimate config points at
  // a v4 address through its v6-mapped form.
  assert.throws(() => validateOutboundUrl("X", "https://[::ffff:169.254.169.254]/iam/"), /private\/loopback/i);
  assert.throws(() => validateOutboundUrl("X", "https://[::ffff:127.0.0.1]/"), /private\/loopback/i);
  assert.throws(() => validateOutboundUrl("X", "https://[::ffff:10.0.0.5]/"), /private\/loopback/i);
});

test("rejects GCP metadata hostname", () => {
  assert.throws(
    () => validateOutboundUrl("X", "https://metadata.google.internal/"),
    /metadata/i,
  );
});

test("accepts public IPs that aren't private (e.g. 8.8.8.8)", () => {
  // Not great practice to point at IPs but not strictly unsafe without an
  // allowlist; the user's WEBHOOK_URL might legitimately be an IP for now.
  const u = validateOutboundUrl("WEBHOOK_URL", "https://8.8.8.8/");
  assert.equal(u.hostname, "8.8.8.8");
});

test("allowlist: accepts an exact host match", () => {
  const u = validateOutboundUrl("NHC_URL", "https://www.nhc.noaa.gov/CurrentStorms.json", {
    allowedHosts: ["www.nhc.noaa.gov", "nhc.noaa.gov"],
  });
  assert.equal(u.hostname, "www.nhc.noaa.gov");
});

test("allowlist: rejects a host not on the list", () => {
  assert.throws(
    () => validateOutboundUrl("NHC_URL", "https://attacker.example.com/x", {
      allowedHosts: ["www.nhc.noaa.gov"],
    }),
    /not in the allowlist/,
  );
});

test("allowlist: leading-dot entry matches subdomains (and only subdomains)", () => {
  // ".capews.com" matches "brb-secondary.capews.com" but NOT "capews.com" itself.
  const allow = [".capews.com"];
  assert.ok(validateOutboundUrl("X", "https://brb-secondary.capews.com/x", { allowedHosts: allow }));
  assert.throws(
    () => validateOutboundUrl("X", "https://capews.com/", { allowedHosts: allow }),
    /not in the allowlist/,
  );
  // A typosquat host that ends in ".capews.com" via .X.capews.com works as a
  // strict subdomain — that's the *intended* semantics; widening is the
  // operator's choice.
});

test("private-IP check happens before allowlist match — an allowlisted IP that happens to be private is still rejected", () => {
  // An operator widening the allowlist with "127.0.0.1" should not be able
  // to open loopback as an unintended consequence.
  assert.throws(
    () => validateOutboundUrl("X", "https://127.0.0.1/", { allowedHosts: ["127.0.0.1"] }),
    /private\/loopback/i,
  );
});
