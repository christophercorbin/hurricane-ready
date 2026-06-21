/**
 * Tiny on-disk JSON helpers shared by state.json and subscriptions.json.
 *
 * `writeJsonAtomic` writes to `<dest>.tmp` then renames over the destination —
 * so a crash mid-write can only leave the prior valid contents or a stray .tmp,
 * never a truncated destination. (Issue #21.)
 *
 * `readJsonSafe` returns a fallback when the file is missing or corrupt, but
 * surfaces the parse error to a caller-supplied `onError` so silent data loss
 * stops being invisible.
 */
import * as fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp already gone */ }
    throw err;
  }
}

export function readJsonSafe(file, fallback, { onError } = {}) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    if (typeof onError === "function") onError(err);
    return fallback;
  }
}
