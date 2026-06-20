/**
 * Web Push notifications. Lets people opt in from the browser and get a push
 * the moment the threat level rises — no phone number, no account.
 *
 * Entirely optional: with no VAPID keys configured, push is disabled and the
 * subscribe endpoints report so. Subscriptions live on the writable /data
 * volume (the rest of the container filesystem is read-only).
 */
import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:alerts@hurricane-ready.local";

export const pushEnabled = Boolean(PUBLIC && PRIVATE);
if (pushEnabled) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
  } catch (err) {
    console.warn(`Push disabled: bad VAPID config (${err.message})`);
  }
}

const SUBS_FILE = process.env.SUBS_FILE || "/data/subscriptions.json";

function load() {
  try {
    if (existsSync(SUBS_FILE)) {
      const parsed = JSON.parse(readFileSync(SUBS_FILE, "utf-8"));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* corrupt file -> start clean */
  }
  return [];
}

let subs = load();

function save() {
  try {
    mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
    writeFileSync(SUBS_FILE, JSON.stringify(subs));
  } catch (err) {
    console.warn(`Could not persist subscriptions: ${err.message}`);
  }
}

export const vapidPublicKey = () => (pushEnabled ? PUBLIC : null);
export const subscriptionCount = () => subs.length;

const MAX_SUBS = Number(process.env.MAX_SUBSCRIPTIONS || 50000);

export function addSubscription(sub) {
  // Require a well-formed PushSubscription (endpoint + encryption keys).
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys ||
      typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
    return false;
  }
  if (subs.some((s) => s.endpoint === sub.endpoint)) return true;
  if (subs.length >= MAX_SUBS) return false; // bound storage growth
  subs.push(sub);
  save();
  return true;
}

export function removeSubscription(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.endpoint !== endpoint);
  if (subs.length !== before) save();
}

// Fan out one notification to every subscriber. Expired subscriptions
// (410 Gone / 404) are pruned so the list self-heals.
export async function sendPushToAll(payload) {
  if (!pushEnabled || subs.length === 0) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  const dead = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, body, { TTL: 3600, urgency: "high" });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) dead.push(s.endpoint);
        else console.warn(`Push send failed (${err.statusCode || err.message})`);
      }
    })
  );
  if (dead.length) {
    subs = subs.filter((s) => !dead.includes(s.endpoint));
    save();
  }
  return { sent, pruned: dead.length };
}
