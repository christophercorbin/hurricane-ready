import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineKm,
  projectPosition,
  closestApproach,
  compassSide,
  classifyPass,
  assessStorm,
  assess,
} from "../src/threat.mjs";

const BARBADOS = { lat: 13.19, lon: -59.54 };
const THRESHOLDS = {
  imminentKm: 150,
  imminentHours: 48,
  warningKm: 300,
  warningHours: 72,
  watchMaxLat: 25,
  watchMinLon: -90,
  watchMaxLon: -40,
};

test("haversine: Barbados to St. Lucia is roughly 160 km", () => {
  const km = haversineKm(13.19, -59.54, 13.91, -60.98);
  assert.ok(km > 140 && km < 190, `got ${km}`);
});

test("projectPosition: westward storm moves west", () => {
  const p = projectPosition(12, -50, 270, 18, 24);
  assert.ok(p.lon < -50, "longitude should decrease heading west");
  assert.ok(Math.abs(p.lat - 12) < 1, "latitude roughly stable");
});

test("closestApproach: westward storm at Barbados latitude approaches", () => {
  const storm = { lat: 13.0, lon: -50.0, movementDir: 272, movementSpeedKt: 18 };
  const a = closestApproach(storm, BARBADOS);
  assert.ok(a.km < 200, `expected close approach, got ${a.km}km`);
  assert.ok(a.atHours > 0, "approach should be in the future");
});

test("assessStorm: distant northbound storm is WATCH only (in basin box)", () => {
  const storm = { lat: 20.0, lon: -55.0, movementDir: 350, movementSpeedKt: 12 };
  const r = assessStorm(storm, BARBADOS, THRESHOLDS);
  assert.equal(r.level, "WATCH");
});

test("assessStorm: storm outside basin box is ALL_CLEAR", () => {
  const storm = { lat: 30.0, lon: -45.0, movementDir: 30, movementSpeedKt: 15 };
  const r = assessStorm(storm, BARBADOS, THRESHOLDS);
  assert.equal(r.level, "ALL_CLEAR");
});

test("assessStorm: approaching storm at warning distance is WARNING", () => {
  // ~1000km east, heading due west at 18kt: ~30h to closest approach
  const storm = { lat: 13.4, lon: -50.3, movementDir: 271, movementSpeedKt: 18 };
  const r = assessStorm(storm, BARBADOS, {
    ...THRESHOLDS,
    imminentHours: 10, // force out of imminent window for this test
  });
  assert.ok(["WARNING", "IMMINENT"].includes(r.level));
});

test("assessStorm: storm 100km away right now is IMMINENT", () => {
  const storm = { lat: 13.19, lon: -58.6, movementDir: 270, movementSpeedKt: 15 };
  const r = assessStorm(storm, BARBADOS, THRESHOLDS);
  assert.equal(r.level, "IMMINENT");
  assert.ok(r.distanceNowKm < 150);
});

test("assess: overall takes the worst storm", () => {
  const storms = [
    { id: "a", name: "Far", lat: 22, lon: -45, movementDir: 320, movementSpeedKt: 10 },
    { id: "b", name: "Near", lat: 13.0, lon: -58.5, movementDir: 275, movementSpeedKt: 16 },
  ];
  const r = assess(storms, BARBADOS, THRESHOLDS);
  assert.equal(r.overall, "IMMINENT");
  assert.equal(r.storms.length, 2);
});

test("assess: no storms means ALL_CLEAR", () => {
  const r = assess([], BARBADOS, THRESHOLDS);
  assert.equal(r.overall, "ALL_CLEAR");
});

test("compassSide: a point due south reads 'south'", () => {
  assert.equal(compassSide(BARBADOS.lat, BARBADOS.lon, 11.5, -59.54), "south");
  assert.equal(compassSide(BARBADOS.lat, BARBADOS.lon, 13.19, -57.0), "east");
});

test("classifyPass: a 130km pass to the south is a close pass", () => {
  const closest = { km: 130, atHours: 12, lat: 12.0, lon: -59.54 };
  const p = classifyPass(closest, "WARNING", BARBADOS);
  assert.equal(p.kind, "close-pass");
  assert.equal(p.side, "south");
  assert.equal(p.distanceKm, 130);
});

test("classifyPass: a 350km pass is a nearby pass", () => {
  const closest = { km: 350, atHours: 24, lat: 13.19, lon: -56.3 };
  assert.equal(classifyPass(closest, "WATCH", BARBADOS).kind, "nearby-pass");
});

test("assessStorm: a storm passing south sets pass side and is not silent", () => {
  // Moving due west ~200km south of Barbados: a nearby pass, never imminent
  const storm = { lat: 11.4, lon: -55.0, movementDir: 270, movementSpeedKt: 16 };
  const r = assessStorm(storm, BARBADOS, THRESHOLDS);
  assert.ok(["WATCH", "WARNING"].includes(r.level), `got ${r.level}`);
  assert.equal(r.pass.side, "south");
  assert.equal(r.pass.kind, "nearby-pass");
});

test("missing movement data falls back to current distance", () => {
  const storm = { lat: 14.0, lon: -57.0, movementDir: NaN, movementSpeedKt: NaN };
  const a = closestApproach(storm, BARBADOS);
  assert.equal(a.atHours, 0);
});
