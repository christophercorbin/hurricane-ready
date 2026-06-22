/**
 * Tests for the Atlantic-basin storm filter (issue #39).
 *
 * NHC mixes upper- and lower-case bin numbers and IDs over time. The
 * pre-fix code did `binNumber.startsWith("AT") || id.startsWith("al")`,
 * which is case-sensitive and asymmetric — a feed dropping bin numbers
 * or switching either field to the opposite casing made every storm
 * silently disappear, dropping the watcher into a false ALL_CLEAR with
 * no signal. The fix lowercases both checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAtlanticStorm } from "../src/nhc.mjs";

test("accepts a storm with upper-case binNumber AT*", () => {
  assert.equal(isAtlanticStorm({ binNumber: "AT1", id: "al012026" }), true);
});

test("accepts a storm with lower-case binNumber at*", () => {
  assert.equal(isAtlanticStorm({ binNumber: "at1", id: "al012026" }), true);
});

test("accepts a storm with upper-case id AL* (no binNumber)", () => {
  assert.equal(isAtlanticStorm({ id: "AL012026" }), true);
});

test("accepts a storm with lower-case id al* (no binNumber)", () => {
  assert.equal(isAtlanticStorm({ id: "al012026" }), true);
});

test("rejects a Pacific storm (EP*)", () => {
  assert.equal(isAtlanticStorm({ binNumber: "EP1", id: "ep012026" }), false);
});

test("rejects a malformed entry with neither binNumber nor matching id", () => {
  assert.equal(isAtlanticStorm({}), false);
  assert.equal(isAtlanticStorm({ id: "xyz" }), false);
  assert.equal(isAtlanticStorm(null), false);
});
