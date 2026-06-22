/**
 * Storm data sources: live NHC feed, or fixture replay for demos.
 * Normalized storm shape:
 *   { id, name, classification, lat, lon, movementDir, movementSpeedKt,
 *     intensityKt, pressureMb, advisoryNum }
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Case-insensitive Atlantic-basin filter (issue #39). NHC has historically
// used both `AL`/`al` for storm IDs and `AT`/`at` for bin numbers; the prior
// case-sensitive check dropped every storm silently when either field
// switched casing, throwing the watcher into a false ALL_CLEAR with no
// alarm.
export function isAtlanticStorm(s) {
  if (!s) return false;
  const bin = typeof s.binNumber === "string" ? s.binNumber.toLowerCase() : "";
  const id  = typeof s.id        === "string" ? s.id.toLowerCase()        : "";
  return bin.startsWith("at") || id.startsWith("al");
}

export async function fetchLiveStorms(nhcUrl) {
  const res = await fetch(nhcUrl, {
    headers: { "User-Agent": "hurricane-ready (github.com/christophercorbin/hurricane-ready)" },
    // 8s timeout (#38): without this a slow NHC TCP / DNS / proxy stall could
    // hang the watcher's tick indefinitely (the single-flight loop blocks all
    // dispatch until the in-flight tick completes).
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`NHC feed returned ${res.status}`);
  const data = await res.json();

  const incoming = data.activeStorms ?? [];
  const atlantic = incoming.filter(isAtlanticStorm);
  if (incoming.length > 0 && atlantic.length === 0) {
    // Watchdog: the upstream returned storms but none matched the basin
    // filter. Most likely a feed-format change. Log loudly so we notice
    // before the dashboard sits on a false ALL_CLEAR.
    console.warn(`NHC feed returned ${incoming.length} storms but none matched Atlantic basin filter`);
  }
  return atlantic
    .map((s) => ({
      id: s.id,
      name: s.name,
      classification: s.classification,
      lat: Number(s.latitudeNumeric),
      lon: Number(s.longitudeNumeric),
      movementDir: Number(s.movementDir),
      movementSpeedKt: Number(s.movementSpeed),
      intensityKt: Number(s.intensity),
      pressureMb: Number(s.pressure),
      advisoryNum: s.publicAdvisory?.advNum ?? null,
      forecastAdvisoryUrl: s.forecastAdvisory?.url ?? null,
      forecastAdvisoryNum: s.forecastAdvisory?.advNum ?? null,
    }));
}

export function loadReplayFrames() {
  const file = path.join(here, "../fixtures/beryl-2024.json");
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function createReplaySource() {
  const frames = loadReplayFrames();
  let i = 0;
  return {
    frameCount: frames.length,
    next() {
      const frame = frames[Math.min(i, frames.length - 1)];
      const done = i >= frames.length - 1;
      i += 1;
      return { ...frame, done, frameIndex: Math.min(i, frames.length) };
    },
  };
}
