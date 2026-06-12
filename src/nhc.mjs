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

export async function fetchLiveStorms(nhcUrl) {
  const res = await fetch(nhcUrl, {
    headers: { "User-Agent": "hurricane-ready (github.com/christophercorbin/hurricane-ready)" },
  });
  if (!res.ok) throw new Error(`NHC feed returned ${res.status}`);
  const data = await res.json();

  return (data.activeStorms ?? [])
    .filter((s) => s.binNumber?.startsWith("AT") || s.id?.startsWith("al"))
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
