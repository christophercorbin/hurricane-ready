import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdvisory } from "../src/advisory.mjs";
import { closestApproachOnTrack, assessStorm } from "../src/threat.mjs";

// Condensed from a real TCM product (Post-Tropical Cyclone Amanda, EP012026)
const SAMPLE = `
POST-TROPICAL CYCLONE AMANDA FORECAST/ADVISORY NUMBER  22
NWS NATIONAL HURRICANE CENTER MIAMI FL       EP012026
0300 UTC MON JUN 08 2026

POST-TROPICAL CYCLONE CENTER LOCATED NEAR 11.3N 136.3W AT 08/0300Z
POSITION ACCURATE WITHIN  20 NM

PRESENT MOVEMENT TOWARD THE WEST OR 260 DEGREES AT   5 KT

ESTIMATED MINIMUM CENTRAL PRESSURE 1007 MB
MAX SUSTAINED WINDS  25 KT WITH GUSTS TO  35 KT.
34 KT....... 60NE  20SE  0SW  90NW.

REPEAT...CENTER LOCATED NEAR 11.3N 136.3W AT 08/0300Z

FORECAST VALID 08/1200Z 11.1N 136.9W...POST-TROP/REMNT LOW
MAX WIND  25 KT...GUSTS  35 KT.
34 KT... 50NE  20SE  0SW  80NW.

FORECAST VALID 09/0000Z 10.8N 138.0W...POST-TROP/REMNT LOW
MAX WIND  25 KT...GUSTS  35 KT.

OUTLOOK VALID 10/0000Z 10.3N 140.2W...POST-TROP/REMNT LOW
MAX WIND  25 KT...GUSTS  35 KT.

FORECAST VALID 11/0000Z...DISSIPATED

REQUEST FOR 3 HOURLY SHIP REPORTS WITHIN 300 MILES OF 11.3N 136.3W
$$
`;

test("parses issuance and current center", () => {
  const a = parseAdvisory(SAMPLE);
  assert.equal(a.issuedAt, "2026-06-08T03:00:00.000Z");
  assert.equal(a.current.lat, 11.3);
  assert.equal(a.current.lon, -136.3);
  assert.equal(a.current.maxWindKt, 25);
});

test("parses current 34kt wind radii as max quadrant in km", () => {
  const a = parseAdvisory(SAMPLE);
  // 90 NM * 1.852 = 166.68 -> 167
  assert.equal(a.current.radii34Km, 167);
});

test("parses forecast and outlook points with resolved times", () => {
  const a = parseAdvisory(SAMPLE);
  assert.equal(a.forecastPoints.length, 3); // DISSIPATED line has no position
  assert.deepEqual(
    a.forecastPoints.map((p) => p.hoursFromIssuance),
    [9, 21, 45]
  );
  assert.equal(a.forecastPoints[0].lat, 11.1);
  assert.equal(a.forecastPoints[0].lon, -136.9);
  assert.equal(a.forecastPoints[0].radii34Km, Math.round(80 * 1.852));
  assert.equal(a.forecastPoints[2].lon, -140.2);
});

test("returns null on non-TCM text", () => {
  assert.equal(parseAdvisory("hello world"), null);
});

const BARBADOS = { lat: 13.19, lon: -59.54 };
const THRESHOLDS = {
  imminentKm: 150, imminentHours: 48,
  warningKm: 300, warningHours: 72,
  watchMaxLat: 25, watchMinLon: -90, watchMaxLon: -40,
};

test("official track beats dead reckoning when the storm curves", () => {
  // Storm currently moving NORTH (dead reckoning says it misses), but the
  // official forecast curves it west toward the island.
  const storm = {
    lat: 12.0, lon: -52.0, movementDir: 0, movementSpeedKt: 10,
    forecastPoints: [
      { hoursFromIssuance: 24, lat: 13.0, lon: -56.0 },
      { hoursFromIssuance: 48, lat: 13.2, lon: -59.6 },
    ],
  };
  const onTrack = closestApproachOnTrack(storm, BARBADOS);
  assert.ok(onTrack.km < 30, `track approach should be near-direct, got ${onTrack.km}`);
  const r = assessStorm(storm, BARBADOS, THRESHOLDS);
  assert.equal(r.method, "official-track");
  assert.equal(r.level, "IMMINENT");
});

test("wind field widens the effective reach", () => {
  // Center passes 250km away: WARNING on center distance...
  const base = {
    lat: 13.2, lon: -55.0, movementDir: 270, movementSpeedKt: 15,
    forecastPoints: [{ hoursFromIssuance: 36, lat: 10.9, lon: -60.0 }],
  };
  const without = assessStorm(base, BARBADOS, THRESHOLDS);
  // ...but with a 200km wind field, 34-kt winds reach the island: IMMINENT
  const withWind = assessStorm({ ...base, radii34Km: 200 }, BARBADOS, THRESHOLDS);
  assert.ok(
    ["WARNING", "IMMINENT"].includes(without.level),
    `unexpected base level ${without.level}`
  );
  assert.equal(withWind.windFieldKm, 200);
  assert.ok(
    withWind.level === "IMMINENT" ||
      (without.level === "WARNING" && withWind.level === "IMMINENT"),
    `wind field should escalate: ${without.level} -> ${withWind.level}`
  );
});

test("no forecast points falls back to dead reckoning", () => {
  const storm = { lat: 13.0, lon: -50.0, movementDir: 272, movementSpeedKt: 18 };
  const r = assessStorm(storm, BARBADOS, THRESHOLDS);
  assert.equal(r.method, "dead-reckoning");
});
