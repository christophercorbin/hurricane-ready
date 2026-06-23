/**
 * Tests for weakEtag (issue #55).
 *
 * /api/status was being JSON.stringify'd on every request even though it
 * only changes once per tick (~15 min in live, ~12 s in replay). With a
 * stable etag per tick, polling browsers get 304 Not Modified on most
 * requests — origin work drops to writing a tiny response header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { weakEtag } from "../src/etag.mjs";

test("weakEtag returns the W/\"...\" weak-validator form", () => {
  const e = weakEtag("hello");
  assert.match(e, /^W\/"[A-Za-z0-9_-]+"$/);
});

test("weakEtag is deterministic — same input → same etag", () => {
  assert.equal(weakEtag("hello"), weakEtag("hello"));
});

test("weakEtag changes when content changes by even a single byte", () => {
  assert.notEqual(weakEtag("hello"), weakEtag("helloo"));
  assert.notEqual(weakEtag("hello"), weakEtag("Hello"));
});

test("weakEtag handles empty input without throwing", () => {
  const e = weakEtag("");
  assert.match(e, /^W\/"[A-Za-z0-9_-]+"$/);
});
