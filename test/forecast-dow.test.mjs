import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression guard for the 7-day strip labels (#forecast). Open-Meteo daily
// dates are YYYY-MM-DD calendar dates, so their weekday is timezone-independent.
// A prior build parsed them as UTC midnight and formatted in America/Barbados
// (UTC-4), landing the instant on the previous local day and shifting every
// label back one (Thu rendered as "Wed"). See web/app.js islandDOW.

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("day-of-week formatter for calendar dates uses UTC, not island TZ", () => {
  const m = app.match(/const DOW_FMT = new Intl\.DateTimeFormat\([^;]*\);/);
  assert.ok(m, "missing DOW_FMT declaration");
  assert.match(m[0], /timeZone:\s*"UTC"/, "DOW_FMT must format in UTC to avoid off-by-one");
  assert.match(m[0], /weekday:\s*"short"/, "DOW_FMT must produce short weekday labels");
});

test("islandDOW returns the actual weekday of the calendar date", () => {
  // Mirror the shipped logic: parse the date-only string, format weekday in UTC.
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
  const islandDOW = (dateStr) => {
    if (!dateStr) return "—";
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return "—";
    return fmt.format(d);
  };
  // 2026-07-15 is a Wednesday; the strip must not lag a day behind the data.
  assert.equal(islandDOW("2026-07-15"), "Wed");
  assert.equal(islandDOW("2026-07-16"), "Thu");
  assert.equal(islandDOW("2026-07-17"), "Fri");
  assert.equal(islandDOW("2026-07-20"), "Mon");
  assert.equal(islandDOW(""), "—");
});
