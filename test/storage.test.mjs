/**
 * Tests for storage.mjs — atomic JSON write + read with safe defaults.
 * Audit issue #21: a crash mid-write must not corrupt the destination,
 * and a corrupted destination must be surfaced (not silently reset).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonAtomic, readJsonSafe } from "../src/storage.mjs";

function tmpDir(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `hr-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("writeJsonAtomic writes the file with the serialized content", () => {
  const { dir, cleanup } = tmpDir("write");
  try {
    const file = path.join(dir, "state.json");
    writeJsonAtomic(file, { level: "WATCH", history: [] });
    const round = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(round.level, "WATCH");
    assert.deepEqual(round.history, []);
  } finally { cleanup(); }
});

test("writeJsonAtomic creates the parent directory if missing", () => {
  const { dir, cleanup } = tmpDir("mkdir");
  try {
    const file = path.join(dir, "deeply/nested/state.json");
    writeJsonAtomic(file, { ok: true });
    assert.ok(existsSync(file));
  } finally { cleanup(); }
});

test("writeJsonAtomic uses a temp + rename pattern: a rename failure leaves the destination intact", () => {
  // Trigger a real rename failure: the destination is a non-empty directory,
  // so renameSync of a file onto it throws (ENOTEMPTY/EISDIR depending on OS).
  // The pre-existing on-disk state at that path must not be disturbed.
  const { dir, cleanup } = tmpDir("atomic");
  try {
    const file = path.join(dir, "state.json");
    mkdirSync(file);
    writeFileSync(path.join(file, "blocker"), "keep me");

    assert.throws(() => writeJsonAtomic(file, { level: "CORRUPTED" }));

    // The directory and its blocker are still there — the helper did not
    // overwrite or truncate the destination path.
    assert.ok(existsSync(path.join(file, "blocker")), "destination contents must remain when rename fails");
  } finally { cleanup(); }
});

test("writeJsonAtomic cleans up its temp file when the rename fails", () => {
  const { dir, cleanup } = tmpDir("clean");
  try {
    const file = path.join(dir, "state.json");
    mkdirSync(file);
    writeFileSync(path.join(file, "blocker"), "");

    assert.throws(() => writeJsonAtomic(file, { x: 1 }));

    // The temp sibling next to the directory should not survive a failed rename.
    const stray = readdirSync(dir).filter((n) => n.startsWith("state.json.") && n.endsWith(".tmp"));
    assert.deepEqual(stray, [], "no .tmp files left behind after a failed rename");
  } finally { cleanup(); }
});

test("writeJsonAtomic does NOT leave the temp file behind on success", () => {
  const { dir, cleanup } = tmpDir("notmp");
  try {
    const file = path.join(dir, "state.json");
    writeJsonAtomic(file, { ok: 1 });
    const entries = readdirSync(dir);
    assert.deepEqual(entries.sort(), ["state.json"], "no .tmp suffix files remain after successful write");
  } finally { cleanup(); }
});

test("readJsonSafe returns the parsed contents when the file is valid JSON", () => {
  const { dir, cleanup } = tmpDir("read");
  try {
    const file = path.join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ a: 1, b: [2, 3] }));
    const r = readJsonSafe(file, {});
    assert.deepEqual(r, { a: 1, b: [2, 3] });
  } finally { cleanup(); }
});

test("readJsonSafe returns the fallback when the file is missing", () => {
  const { dir, cleanup } = tmpDir("missing");
  try {
    const file = path.join(dir, "absent.json");
    const r = readJsonSafe(file, { fallback: true });
    assert.deepEqual(r, { fallback: true });
  } finally { cleanup(); }
});

test("readJsonSafe surfaces a corruption signal via onError, then falls back", () => {
  const { dir, cleanup } = tmpDir("corrupt");
  try {
    const file = path.join(dir, "state.json");
    writeFileSync(file, "{not json");
    let observed = null;
    const r = readJsonSafe(file, { fallback: true }, { onError: (err) => { observed = err; } });
    assert.deepEqual(r, { fallback: true });
    assert.ok(observed instanceof SyntaxError, "parse error must reach onError instead of being swallowed silently");
  } finally { cleanup(); }
});
