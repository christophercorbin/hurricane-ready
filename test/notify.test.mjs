/**
 * Tests for dispatchAlert (issue #26).
 *
 * The product's headline behaviour is "level rises → email/SMS/webhook fires
 * once on transition." Until this file existed there was zero direct coverage
 * of the dispatch path, so a refactor that silently dropped a channel or
 * misformatted the SMS would have shipped without a failing test.
 *
 * Tests pass fake AWS clients + a fake fetch via the `deps` arg so we never
 * need real AWS or network. SDK commands carry their input on `.input` and
 * their type on `.constructor.name`, so assertions don't need an SDK mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchAlert } from "../src/notify.mjs";

const island = { name: "Barbados", lat: 13.19, lon: -59.54 };

function makeFakes() {
  const sesCalls = [];
  const snsCalls = [];
  const fetchCalls = [];
  return {
    sesCalls, snsCalls, fetchCalls,
    deps: {
      sesClient: { send: async (cmd) => { sesCalls.push(cmd); } },
      snsClient: { send: async (cmd) => { snsCalls.push(cmd); } },
      httpFetch: async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; },
    },
  };
}

function alerts(overrides = {}) {
  return {
    emails: [],
    senderEmail: null,
    phones: [],
    webhookUrl: null,
    ...overrides,
  };
}

test("sends email when emails + senderEmail are set, skips otherwise", async () => {
  const { sesCalls, deps } = makeFakes();
  await dispatchAlert({
    level: "WARNING", previousLevel: "WATCH",
    briefing: "Strong winds expected within 72 hours.",
    island, alerts: alerts({ emails: ["ops@example.com", "team@example.com"], senderEmail: "alerts@example.com" }),
    region: "us-east-1",
  }, deps);
  assert.equal(sesCalls.length, 1);
  const input = sesCalls[0].input;
  assert.deepEqual(input.Destination.ToAddresses, ["ops@example.com", "team@example.com"]);
  assert.equal(input.FromEmailAddress, "alerts@example.com");
  assert.match(input.Content.Simple.Subject.Data, /Barbados.*Warning.*was Watch/);
  assert.equal(input.Content.Simple.Body.Text.Data, "Strong winds expected within 72 hours.");
});

test("does not send email when there are no recipients", async () => {
  const { sesCalls, deps } = makeFakes();
  await dispatchAlert({
    level: "WATCH", previousLevel: "ALL_CLEAR",
    briefing: "x", island,
    alerts: alerts({ emails: [], senderEmail: "alerts@example.com" }),
    region: "us-east-1",
  }, deps);
  assert.equal(sesCalls.length, 0);
});

test("does not send email when senderEmail is missing (SES requires a verified sender)", async () => {
  const { sesCalls, deps } = makeFakes();
  await dispatchAlert({
    level: "WATCH", previousLevel: "ALL_CLEAR",
    briefing: "x", island,
    alerts: alerts({ emails: ["ops@example.com"], senderEmail: null }),
    region: "us-east-1",
  }, deps);
  assert.equal(sesCalls.length, 0);
});

test("sends one SMS per phone via SNS", async () => {
  const { snsCalls, deps } = makeFakes();
  await dispatchAlert({
    level: "IMMINENT", previousLevel: "WARNING",
    briefing: "Hurricane within 150 km — shelter now.\nLine 2 should not be in SMS.",
    island, alerts: alerts({ phones: ["+12465551111", "+12465552222"] }),
    region: "us-east-1",
  }, deps);
  assert.equal(snsCalls.length, 2);
  assert.deepEqual(
    snsCalls.map((c) => c.input.PhoneNumber).sort(),
    ["+12465551111", "+12465552222"],
  );
});

test("SMS body is capped at 300 chars and uses only the first line of the briefing", async () => {
  const { snsCalls, deps } = makeFakes();
  const longBriefing =
    "Headline line that should appear in SMS.\n" +
    "A".repeat(1000); // a long second line; must not leak into the SMS
  await dispatchAlert({
    level: "IMMINENT", previousLevel: "WARNING",
    briefing: longBriefing, island,
    alerts: alerts({ phones: ["+12465551111"] }),
    region: "us-east-1",
  }, deps);
  const msg = snsCalls[0].input.Message;
  assert.ok(msg.length <= 300, `SMS must be <= 300 chars, got ${msg.length}`);
  assert.match(msg, /Headline line that should appear in SMS\./);
  assert.equal(msg.includes("A".repeat(50)), false, "no part of the long second line may reach the SMS");
});

test("posts to the webhook with the full briefing + structured level fields", async () => {
  const { fetchCalls, deps } = makeFakes();
  await dispatchAlert({
    level: "WARNING", previousLevel: "WATCH",
    briefing: "First line.\nSecond line of guidance.",
    island, alerts: alerts({ webhookUrl: "https://hooks.example.com/abc" }),
    region: "us-east-1",
  }, deps);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://hooks.example.com/abc");
  assert.equal(fetchCalls[0].opts.method, "POST");
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.level, "WARNING");
  assert.equal(body.previousLevel, "WATCH");
  assert.equal(body.island, "Barbados");
  // Slack-compatible "text" + Discord-compatible "content" both carry the full briefing.
  assert.ok(body.text.includes("First line.\nSecond line of guidance."));
  assert.ok(body.content.includes("First line.\nSecond line of guidance."));
});

test("ALL_CLEAR stand-down still dispatches across every channel", async () => {
  const { sesCalls, snsCalls, fetchCalls, deps } = makeFakes();
  await dispatchAlert({
    level: "ALL_CLEAR", previousLevel: "WATCH",
    briefing: "Conditions have eased — back to all clear.",
    island,
    alerts: alerts({
      emails: ["ops@example.com"], senderEmail: "alerts@example.com",
      phones: ["+12465551111"], webhookUrl: "https://hooks.example.com/x",
    }),
    region: "us-east-1",
  }, deps);
  assert.equal(sesCalls.length, 1, "stand-down email must fire");
  assert.equal(snsCalls.length, 1, "stand-down SMS must fire");
  assert.equal(fetchCalls.length, 1, "stand-down webhook must fire");
});

test("partial failure: a SES failure does not prevent SMS / webhook from firing", async () => {
  const sesCalls = [];
  const snsCalls = [];
  const fetchCalls = [];
  const deps = {
    sesClient: { send: async (cmd) => { sesCalls.push(cmd); throw new Error("SES outage"); } },
    snsClient: { send: async (cmd) => { snsCalls.push(cmd); } },
    httpFetch: async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; },
  };
  const results = await dispatchAlert({
    level: "WARNING", previousLevel: "WATCH",
    briefing: "Strong winds expected.", island,
    alerts: alerts({
      emails: ["ops@example.com"], senderEmail: "alerts@example.com",
      phones: ["+12465551111"], webhookUrl: "https://hooks.example.com/x",
    }),
    region: "us-east-1",
  }, deps);
  assert.equal(sesCalls.length, 1, "email was attempted");
  assert.equal(snsCalls.length, 1, "SMS still sent despite email failure");
  assert.equal(fetchCalls.length, 1, "webhook still posted despite email failure");
  const email = results.find((r) => r.channel === "email");
  assert.equal(email.ok, false, "results record the email failure");
});

test("returns an empty result list when no channels are configured", async () => {
  const { deps } = makeFakes();
  const results = await dispatchAlert({
    level: "WATCH", previousLevel: "ALL_CLEAR",
    briefing: "x", island, alerts: alerts(), region: "us-east-1",
  }, deps);
  assert.deepEqual(results, []);
});
