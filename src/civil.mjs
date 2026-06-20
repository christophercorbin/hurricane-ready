/**
 * Official civil-protection alerts for Barbados, from the Government of
 * Barbados / DEM CAP.CAP system (Optimit CAPEWS platform). We only read the
 * public active-alarm COUNT — a clean JSON endpoint the official site/app use
 * — and surface a prominent link to the authoritative source when one is live.
 * We never re-publish the alert text; CAP.CAP remains the source of truth.
 *
 * Undocumented endpoint, so this is best-effort: any failure returns null and
 * the dashboard simply hides the banner (never blocks the page, never stale).
 */
const ACTIVE_COUNT_URL =
  process.env.CAPEWS_ACTIVE_URL ||
  "https://brb-secondary.capews.com/capews/public/active/checkActiveAlarms";
const PUBLIC_URL =
  process.env.CAPEWS_PUBLIC_URL ||
  "https://brb-secondary.capews.com/capews/public/active";

// Parse the endpoint's body (a bare integer count) into a number, or null.
export function parseAlarmCount(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function fetchCivilAlerts() {
  try {
    const res = await fetch(ACTIVE_COUNT_URL, {
      headers: {
        "User-Agent": "hurricane-ready (github.com/christophercorbin/hurricane-ready)",
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`capews ${res.status}`);
    const count = parseAlarmCount(await res.text());
    if (count == null) throw new Error("unexpected response");
    return {
      active: count > 0,
      count,
      url: PUBLIC_URL,
      source: "Barbados DEM · CAP.CAP",
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`Civil alerts unavailable (${err.message})`);
    return null;
  }
}
