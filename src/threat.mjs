/**
 * Deterministic threat engine. Pure functions, no I/O, fully unit-tested.
 *
 * Design rule: THIS module decides the threat level. The AI layer only
 * explains the decision; it can never change it.
 */

export const LEVELS = ["ALL_CLEAR", "WATCH", "WARNING", "IMMINENT"];

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Dead-reckon a storm position `hours` ahead along its reported motion.
 * movementDir: degrees (meteorological heading the storm moves toward)
 * movementSpeedKt: knots
 */
export function projectPosition(lat, lon, movementDir, movementSpeedKt, hours) {
  const distanceKm = movementSpeedKt * 1.852 * hours;
  const bearing = toRad(movementDir);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const angular = distanceKm / EARTH_RADIUS_KM;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/**
 * Minimum projected distance from the storm to the island over a horizon,
 * stepping the dead-reckoned track. Returns { km, atHours }.
 */
export function closestApproach(storm, island, horizonHours = 120, stepHours = 3) {
  let best = {
    km: haversineKm(storm.lat, storm.lon, island.lat, island.lon),
    atHours: 0,
    lat: storm.lat,
    lon: storm.lon,
  };
  if (!Number.isFinite(storm.movementDir) || !Number.isFinite(storm.movementSpeedKt)) {
    return best;
  }
  for (let h = stepHours; h <= horizonHours; h += stepHours) {
    const p = projectPosition(
      storm.lat,
      storm.lon,
      storm.movementDir,
      storm.movementSpeedKt,
      h
    );
    const km = haversineKm(p.lat, p.lon, island.lat, island.lon);
    if (km < best.km) best = { km, atHours: h, lat: p.lat, lon: p.lon };
  }
  return best;
}

/**
 * Compass direction FROM the island TO a point — i.e. which side of the
 * island the storm's closest pass sits on (N, NE, E, ...).
 */
export function compassSide(fromLat, fromLon, toLat, toLon) {
  const dLon = toRad(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(toRad(toLat));
  const x =
    Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat)) -
    Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(dLon);
  const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return dirs[Math.round(bearing / 45) % 8];
}

/**
 * Classify how a storm relates to the island once its level is known.
 * Returns a human-facing descriptor: a direct-hit risk, a close pass, a
 * nearby pass, or distant — plus which side it passes and how far.
 */
export function classifyPass(closest, level, island) {
  const km = Math.round(closest.km);
  const side = compassSide(island.lat, island.lon, closest.lat, closest.lon);

  let kind;
  if (level === "IMMINENT" && km <= 75) kind = "direct-hit-risk";
  else if (km <= 150) kind = "close-pass";
  else if (km <= 400) kind = "nearby-pass";
  else kind = "distant";

  return { kind, side, distanceKm: km };
}

/**
 * Closest approach along the OFFICIAL forecast track: linear interpolation
 * between the current position and each forecast point, sampled hourly.
 * Returns { km, atHours } or null when no usable track exists.
 */
export function closestApproachOnTrack(storm, island) {
  const points = storm.forecastPoints ?? [];
  if (points.length === 0) return null;

  const track = [
    { lat: storm.lat, lon: storm.lon, atHours: 0 },
    ...points
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({ lat: p.lat, lon: p.lon, atHours: p.hoursFromIssuance })),
  ].sort((a, b) => a.atHours - b.atHours);

  if (track.length < 2) return null;

  let best = {
    km: haversineKm(track[0].lat, track[0].lon, island.lat, island.lon),
    atHours: 0,
    lat: track[0].lat,
    lon: track[0].lon,
  };

  for (let i = 0; i < track.length - 1; i += 1) {
    const a = track[i];
    const b = track[i + 1];
    const span = b.atHours - a.atHours;
    if (span <= 0) continue;
    for (let h = 1; h <= span; h += 1) {
      const t = h / span;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lon = a.lon + (b.lon - a.lon) * t;
      const km = haversineKm(lat, lon, island.lat, island.lon);
      if (km < best.km) best = { km, atHours: a.atHours + h, lat, lon };
    }
  }
  return best;
}

/**
 * Threat level for one storm relative to the island.
 * Uses the official NHC forecast track when available (falling back to
 * dead reckoning), and accounts for the storm's 34-kt wind field size.
 */
export function assessStorm(storm, island, thresholds) {
  const nowKm = haversineKm(storm.lat, storm.lon, island.lat, island.lon);
  const official = closestApproachOnTrack(storm, island);
  const approach = official ?? closestApproach(storm, island);
  const method = official ? "official-track" : "dead-reckoning";

  // Wind-field awareness: a storm "reaches" the island when its 34-kt wind
  // field does, not when its center does.
  const windFieldKm = Number.isFinite(storm.radii34Km) ? storm.radii34Km : 0;
  const effectiveNowKm = Math.max(0, nowKm - windFieldKm);
  const effectiveApproachKm = Math.max(0, approach.km - windFieldKm);

  let level = "ALL_CLEAR";

  const inBasinBox =
    storm.lat <= thresholds.watchMaxLat &&
    storm.lon >= thresholds.watchMinLon &&
    storm.lon <= thresholds.watchMaxLon;
  if (inBasinBox) level = "WATCH";

  if (
    effectiveApproachKm <= thresholds.warningKm &&
    approach.atHours <= thresholds.warningHours
  ) {
    level = "WARNING";
  }

  if (
    effectiveNowKm <= thresholds.imminentKm ||
    (effectiveApproachKm <= thresholds.imminentKm &&
      approach.atHours <= thresholds.imminentHours)
  ) {
    level = "IMMINENT";
  }

  const pass = classifyPass(approach, level, island);

  // Near-miss floor: a storm forecast to pass within ~400 km should never be
  // silent, even if it's outside the basin awareness box.
  const order = ["ALL_CLEAR", "WATCH", "WARNING", "IMMINENT"];
  if (
    (pass.kind === "close-pass" || pass.kind === "nearby-pass") &&
    approach.atHours <= thresholds.warningHours &&
    order.indexOf(level) < order.indexOf("WATCH")
  ) {
    level = "WATCH";
  }

  return {
    level,
    method,
    distanceNowKm: Math.round(nowKm),
    closestApproachKm: Math.round(approach.km),
    closestApproachInHours: approach.atHours,
    windFieldKm,
    pass,
  };
}

/**
 * Overall assessment across all active storms.
 */
export function assess(storms, island, thresholds) {
  const assessed = storms.map((s) => ({
    ...s,
    assessment: assessStorm(s, island, thresholds),
  }));
  const overall = assessed.reduce(
    (max, s) =>
      LEVELS.indexOf(s.assessment.level) > LEVELS.indexOf(max)
        ? s.assessment.level
        : max,
    "ALL_CLEAR"
  );
  return { overall, storms: assessed };
}
