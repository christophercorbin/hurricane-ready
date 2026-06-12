/**
 * NHC Forecast/Advisory (TCM product) parser.
 *
 * Extracts the OFFICIAL forecast track (positions at +12/24/36/48/72/96/120h),
 * max winds, and 34-kt wind radii from the plain-text product embedded in
 * pages like https://www.nhc.noaa.gov/text/MIATCMAT1.shtml
 *
 * Like the threat engine, this is deterministic parsing - no AI in the loop.
 */

const NM_TO_KM = 1.852;

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

const signedLat = (v, hemi) => (hemi === "S" ? -v : v);
const signedLon = (v, hemi) => (hemi === "W" ? -v : v);

/**
 * Resolve "DD/HHMMZ" against the advisory issuance date (month rollover safe).
 */
function resolveValidTime(day, hhmm, issued) {
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  let month = issued.getUTCMonth();
  let year = issued.getUTCFullYear();
  if (day < issued.getUTCDate()) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return new Date(Date.UTC(year, month, day, hours, minutes));
}

function parse34ktRadiiKm(block) {
  const m = block.match(/34 KT\.*\s*(\d+)NE\s+(\d+)SE\s+(\d+)SW\s+(\d+)NW/);
  if (!m) return null;
  const maxNm = Math.max(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  return Math.round(maxNm * NM_TO_KM);
}

/**
 * Parse a TCM advisory (raw page text or plain product text).
 * Returns null if the text doesn't look like a TCM product.
 */
export function parseAdvisory(text) {
  // Issuance: "0300 UTC MON JUN 08 2026"
  const issuanceMatch = text.match(
    /(\d{4}) UTC \w{3} (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) (\d{1,2}) (\d{4})/
  );
  if (!issuanceMatch) return null;
  const [, hhmm, mon, dayStr, yearStr] = issuanceMatch;
  const issuedAt = new Date(
    Date.UTC(
      Number(yearStr),
      MONTHS[mon],
      Number(dayStr),
      Number(hhmm.slice(0, 2)),
      Number(hhmm.slice(2, 4))
    )
  );

  // Current center: "CENTER LOCATED NEAR 11.3N 136.3W AT 08/0300Z"
  const centerMatch = text.match(
    /CENTER LOCATED NEAR\s+(\d{1,2}\.\d)([NS])\s+(\d{1,3}\.\d)([EW])\s+AT\s+(\d{1,2})\/(\d{4})Z/
  );

  const currentWinds = text.match(/MAX SUSTAINED WINDS\s+(\d+)\s+KT/);

  // Current 34kt radii: first radii line before the first FORECAST VALID
  const preForecast = text.split(/FORECAST VALID/)[0];
  const currentRadii34Km = parse34ktRadiiKm(preForecast);

  const current = centerMatch
    ? {
        lat: signedLat(Number(centerMatch[1]), centerMatch[2]),
        lon: signedLon(Number(centerMatch[3]), centerMatch[4]),
        maxWindKt: currentWinds ? Number(currentWinds[1]) : null,
        radii34Km: currentRadii34Km,
      }
    : null;

  // Forecast + outlook points
  const forecastPoints = [];
  const blockRe =
    /(?:FORECAST|OUTLOOK) VALID\s+(\d{1,2})\/(\d{4})Z\s+(\d{1,2}\.\d)([NS])\s+(\d{1,3}\.\d)([EW])([\s\S]*?)(?=(?:FORECAST|OUTLOOK) VALID|REQUEST FOR|\$\$|$)/g;

  for (const m of text.matchAll(blockRe)) {
    const [, day, hhmmV, latV, latH, lonV, lonH, body] = m;
    const validAt = resolveValidTime(Number(day), hhmmV, issuedAt);
    const winds = body.match(/MAX WIND\s+(\d+)\s+KT/);
    forecastPoints.push({
      validAt: validAt.toISOString(),
      hoursFromIssuance: Math.round((validAt - issuedAt) / 3_600_000),
      lat: signedLat(Number(latV), latH),
      lon: signedLon(Number(lonV), lonH),
      maxWindKt: winds ? Number(winds[1]) : null,
      radii34Km: parse34ktRadiiKm(body),
    });
  }

  // Briefing excerpt: the product text from the center fix to the end marker
  const startIdx = text.indexOf("CENTER LOCATED NEAR");
  const endIdx = text.indexOf("$$");
  const excerpt =
    startIdx >= 0
      ? text.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 2500).slice(0, 2500)
      : null;

  return { issuedAt: issuedAt.toISOString(), current, forecastPoints, excerpt };
}

/**
 * Fetch + parse a forecast advisory URL. Returns null on any failure
 * (the threat engine then falls back to dead reckoning).
 */
export async function fetchAdvisory(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "hurricane-ready (github.com/christophercorbin/hurricane-ready)",
      },
    });
    if (!res.ok) throw new Error(`advisory fetch ${res.status}`);
    return parseAdvisory(await res.text());
  } catch (err) {
    console.warn(`Advisory unavailable (${err.message}); using dead reckoning`);
    return null;
  }
}
