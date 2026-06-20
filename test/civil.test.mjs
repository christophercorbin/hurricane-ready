import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlarmCount } from "../src/civil.mjs";

test("parseAlarmCount: reads the bare integer count", () => {
  assert.equal(parseAlarmCount("0"), 0);
  assert.equal(parseAlarmCount("3"), 3);
  assert.equal(parseAlarmCount("  2 \n"), 2);
  assert.equal(parseAlarmCount("12"), 12);
});

test("parseAlarmCount: rejects junk", () => {
  assert.equal(parseAlarmCount(""), null);
  assert.equal(parseAlarmCount("abc"), null);
  assert.equal(parseAlarmCount(null), null);
  assert.equal(parseAlarmCount("<html>error</html>"), null);
});

test("active derives from count > 0", () => {
  assert.equal(parseAlarmCount("0") > 0, false);
  assert.equal(parseAlarmCount("1") > 0, true);
});
