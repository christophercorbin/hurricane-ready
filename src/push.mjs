/**
 * Web Push notifications. Lets people opt in from the browser and get a push
 * the moment the threat level rises — no phone number, no account.
 *
 * Entirely optional: with no VAPID keys configured, push is disabled and the
 * subscribe endpoints report so. Subscriptions live on the writable /data
 * volume (the rest of the container filesystem is read-only).
 */
import webpush from "web-push";
import { writeJsonAtomic, readJsonSafe } from "./storage.mjs";

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

const LEVEL_RANK = { ALL_CLEAR: 0, WATCH: 1, WARNING: 2, IMMINENT: 3 };
const normLevel = (l) => (l in LEVEL_RANK ? l : "WATCH");

// Each stored record: { subscription, minLevel, quiet }.
// Migrates older records that were just a raw PushSubscription.
function load() {
  const parsed = readJsonSafe(SUBS_FILE, null, {
    onError: (err) => console.warn(`subscriptions.json is corrupt, starting clean: ${err.message}`),
  });
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((r) => (r && r.subscription ? r : { subscription: r, minLevel: "WATCH", quiet: false }))
    .filter((r) => r.subscription && typeof r.subscription.endpoint === "string");
}

let subs = load();

function save() {
  try {
    writeJsonAtomic(SUBS_FILE, subs);
  } catch (err) {
    console.warn(`Could not persist subscriptions: ${err.message}`);
  }
}

export const vapidPublicKey = () => (pushEnabled ? PUBLIC : null);
export const subscriptionCount = () => subs.length;

const MAX_SUBS = Number(process.env.MAX_SUBSCRIPTIONS || 50000);

// Barbados is AST (UTC-4, no DST). Overnight quiet window: 22:00–07:00.
function barbadosNight(d = new Date()) {
  const h = (d.getUTCHours() - 4 + 24) % 24;
  return h >= 22 || h < 7;
}

export function addSubscription(sub, prefs = {}) {
  // Require a well-formed PushSubscription (endpoint + encryption keys).
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys ||
      typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
    return false;
  }
  const record = {
    subscription: sub,
    minLevel: normLevel(prefs.minLevel),
    quiet: Boolean(prefs.quiet),
  };
  const existing = subs.find((r) => r.subscription.endpoint === sub.endpoint);
  if (existing) { existing.minLevel = record.minLevel; existing.quiet = record.quiet; save(); return true; }
  if (subs.length >= MAX_SUBS) return false; // bound storage growth
  subs.push(record);
  save();
  return true;
}

export function removeSubscription(endpoint) {
  const before = subs.length;
  subs = subs.filter((r) => r.subscription.endpoint !== endpoint);
  if (subs.length !== before) save();
}

// Should this subscriber get a push for `level`?  Honour their minimum level;
// overnight-quiet suppresses only WATCH (Warning/Imminent always go through);
// the ALL_CLEAR stand-down goes to everyone (but still respects quiet).
function wants(rec, level) {
  if (level === "ALL_CLEAR") return !(rec.quiet && barbadosNight());
  if (LEVEL_RANK[level] < LEVEL_RANK[rec.minLevel]) return false;
  if (rec.quiet && level === "WATCH" && barbadosNight()) return false;
  return true;
}

// Fan out one notification to matching subscribers. Expired subscriptions
// (410 Gone / 404) are pruned so the list self-heals.
export async function sendPushToAll(payload) {
  const level = normLevel(payload && payload.level);
  if (!pushEnabled || subs.length === 0) return { sent: 0, pruned: 0, skipped: 0 };
  const body = JSON.stringify(payload);
  const dead = [];
  let sent = 0, skipped = 0;
  await Promise.all(
    subs.map(async (rec) => {
      if (!wants(rec, level)) { skipped += 1; return; }
      try {
        await webpush.sendNotification(rec.subscription, body, { TTL: 3600, urgency: "high" });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) dead.push(rec.subscription.endpoint);
        else console.warn(`Push send failed (${err.statusCode || err.message})`);
      }
    })
  );
  if (dead.length) {
    subs = subs.filter((r) => !dead.includes(r.subscription.endpoint));
    save();
  }
  return { sent, pruned: dead.length, skipped };
}
