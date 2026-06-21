/**
 * Hurricane-Ready: single-container service.
 * Poll loop (live NHC or replay) -> deterministic threat engine ->
 * AI briefing -> alert dispatch on level change -> dashboard + JSON API.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.mjs";
import { fetchLiveStorms, createReplaySource } from "./nhc.mjs";
import { fetchAdvisory } from "./advisory.mjs";
import { fetchCurrentWeather, fetchOutlook } from "./weather.mjs";
import { fetchTropicalOutlook, fetchTropicalWaves, ATLANTIC_NAMES_2026, stormsSoFar } from "./tropical.mjs";
import { fetchCivilAlerts } from "./civil.mjs";
import { assess } from "./threat.mjs";
import { generateBriefing } from "./briefing.mjs";
import { dispatchAlert } from "./notify.mjs";
import {
  pushEnabled,
  vapidPublicKey,
  addSubscription,
  removeSubscription,
  sendPushToAll,
} from "./push.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(path.join(here, "../web/index.html"), "utf-8");

const LEVEL_LABEL = { ALL_CLEAR: "All clear", WATCH: "Watch", WARNING: "Warning", IMMINENT: "Imminent" };

// Content types for static assets served out of web/ (favicon, icons, PWA).
const STATIC_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// Read a JSON request body (small, with a hard cap) for POST endpoints.
function readJson(req, limit = 16384) {
  return new Promise((resolve) => {
    let data = "";
    let aborted = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { aborted = true; req.destroy(); resolve(null); }
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(JSON.parse(data || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

// ---------- State (JSON file on a volume) ----------

// State is namespaced by mode so the Beryl replay demo never bleeds its
// historical (2024) transitions into the live view, and vice versa.
const MODE = config.replay ? "replay" : "live";
const FRESH = { level: "ALL_CLEAR", history: [] };

function loadAllState() {
  try {
    if (existsSync(config.stateFile)) {
      const parsed = JSON.parse(readFileSync(config.stateFile, "utf-8"));
      // Migrate the old un-namespaced shape; discard its history (it may be
      // stale replay data) but keep it from crashing.
      if (parsed.live || parsed.replay) return parsed;
    }
  } catch {
    /* corrupted state: start fresh */
  }
  return {};
}

const allState = loadAllState();

// The replay is a demo: start each run with a clean slate so history shows
// exactly one Beryl life-cycle, never stacked duplicates from prior runs.
let state =
  MODE === "replay" || !allState[MODE]
    ? { level: "ALL_CLEAR", history: [] }
    : allState[MODE];

function saveState(current) {
  try {
    mkdirSync(path.dirname(config.stateFile), { recursive: true });
    allState[MODE] = current;
    writeFileSync(config.stateFile, JSON.stringify(allState, null, 2));
  } catch (err) {
    console.warn(`Could not persist state: ${err.message}`);
  }
}

// ---------- Current status (served by the API) ----------

let status = {
  island: config.island,
  weather: null,
  outlook: null,
  tropical: null,
  waves: null,
  civilAlert: null,
  seasonNames: ATLANTIC_NAMES_2026,
  stormsSoFar: 0,
  mode: config.replay ? "replay" : "live",
  level: state.level,
  storms: [],
  briefing: null,
  briefingSource: null,
  updatedAt: null,
  replayLabel: null,
  disclaimer:
    "Unofficial project. Always follow Barbados Meteorological Services and the Department of Emergency Management.",
};

const replaySource = config.replay ? createReplaySource() : null;
let lastBriefingKm = null;

// Official-advisory cache: refetch only when the advisory number changes
const advisoryCache = new Map(); // stormId -> { advNum, parsed }

async function enrichWithAdvisories(storms) {
  return Promise.all(
    storms.map(async (storm) => {
      if (!storm.forecastAdvisoryUrl) return storm;

      const cached = advisoryCache.get(storm.id);
      let parsed = cached?.parsed;
      if (!cached || cached.advNum !== storm.forecastAdvisoryNum) {
        parsed = await fetchAdvisory(storm.forecastAdvisoryUrl);
        advisoryCache.set(storm.id, {
          advNum: storm.forecastAdvisoryNum,
          parsed,
        });
      }
      if (!parsed) return storm;

      return {
        ...storm,
        forecastPoints: parsed.forecastPoints,
        radii34Km: parsed.current?.radii34Km ?? storm.radii34Km ?? null,
        advisoryExcerpt: parsed.excerpt,
      };
    })
  );
}

async function tick() {
  try {
    let storms;
    let label = null;
    let timestamp = new Date().toISOString();

    if (config.replay) {
      const frame = replaySource.next();
      storms = frame.storms;
      label = `${frame.label} (frame ${frame.frameIndex}/${replaySource.frameCount})`;
      timestamp = frame.timestamp;
    } else {
      storms = await enrichWithAdvisories(await fetchLiveStorms(config.nhcUrl));
    }

    const assessment = assess(storms, config.island, config.thresholds);
    const levelChanged = assessment.overall !== state.level;

    // Keep the briefing's stated distance honest as a storm closes in:
    // regenerate on level change, first run, or a material shift in the
    // primary storm's closest approach (> 50 km).
    const primaryKm =
      assessment.storms.find((s) => s.assessment.level === assessment.overall)
        ?.assessment.closestApproachKm ?? null;
    const distMoved =
      lastBriefingKm != null &&
      primaryKm != null &&
      Math.abs(primaryKm - lastBriefingKm) > 50;

    if (levelChanged || !status.briefing || distMoved) {
      const briefing = await generateBriefing(
        assessment,
        config.island,
        config.bedrock
      );
      status.briefing = briefing.text;
      status.briefingSource = briefing.source;
      lastBriefingKm = primaryKm;
    }

    if (levelChanged) {
      console.log(
        `Threat level ${state.level} -> ${assessment.overall} (${label ?? "live"})`
      );
      const results = await dispatchAlert({
        level: assessment.overall,
        previousLevel: state.level,
        briefing: status.briefing,
        island: config.island,
        alerts: config.alerts,
        region: config.bedrock.region,
      });
      if (results.length > 0) console.log("Dispatch:", JSON.stringify(results));

      // Web push to everyone who opted in from the browser.
      const rising = assessment.overall !== "ALL_CLEAR";
      const pushRes = await sendPushToAll({
        title: `${config.island.name}: ${LEVEL_LABEL[assessment.overall]}`,
        body: rising
          ? (status.briefing || "").split("\n")[0]
          : "Conditions have eased — back to all clear.",
        level: assessment.overall,
        url: "/",
      });
      if (pushRes.sent || pushRes.pruned) console.log("Push:", JSON.stringify(pushRes));

      state.history.push({
        at: timestamp,
        from: state.level,
        to: assessment.overall,
      });
      state.history = state.history.slice(-50);
      state.level = assessment.overall;
      saveState(state);
    }

    const [weather, outlook, tropical, civilAlert, waves] = await Promise.all([
      fetchCurrentWeather(config.island),
      fetchOutlook(config.island),
      // In replay mode the live Atlantic outlook / civil alerts / waves are
      // irrelevant to the historical Beryl demo.
      config.replay ? Promise.resolve(null) : fetchTropicalOutlook(),
      config.replay ? Promise.resolve(null) : fetchCivilAlerts(),
      config.replay ? Promise.resolve(null) : fetchTropicalWaves(config.island.lon),
    ]);

    const cleanStorms = assessment.storms.map(({ advisoryExcerpt, ...s }) => s);
    status = {
      ...status,
      level: assessment.overall,
      // advisoryExcerpt feeds the briefing, not the API payload
      storms: cleanStorms,
      stormsSoFar: stormsSoFar(cleanStorms) || status.stormsSoFar,
      weather: weather ?? status.weather,
      outlook: outlook ?? status.outlook,
      tropical: tropical ?? status.tropical,
      waves: config.replay ? null : (waves ?? status.waves),
      civilAlert: config.replay ? null : (civilAlert ?? status.civilAlert),
      updatedAt: timestamp,
      replayLabel: label,
      history: state.history,
    };
  } catch (err) {
    console.error("Tick failed:", err.message);
  }
}

// ---------- HTTP ----------

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml);
    return;
  }
  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(status));
    return;
  }
  if (req.method === "GET" && req.url === "/healthz") {
    // 200 = process is alive (liveness). `dataAgeSeconds` / `stale` let an
    // external monitor alert on a watcher that's up but no longer updating.
    const ageS = status.updatedAt ? Math.round((Date.now() - new Date(status.updatedAt).getTime()) / 1000) : null;
    const staleAfter = (config.replay ? 60 : config.pollMinutes * 60) * 3;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({
      status: "ok",
      mode: status.mode,
      level: status.level,
      updatedAt: status.updatedAt,
      dataAgeSeconds: ageS,
      stale: ageS != null && ageS > staleAfter,
      uptimeSeconds: Math.round(process.uptime()),
      hasWeather: Boolean(status.weather),
      hasOutlook: Boolean(status.outlook),
      hasTropical: Boolean(status.tropical),
    }));
    return;
  }

  // ----- Web push opt-in -----
  if (req.method === "GET" && req.url === "/api/vapidPublicKey") {
    // Always 200 (key is null when push is disabled) so the client can check
    // quietly without logging a console error.
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ key: vapidPublicKey() }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/subscribe") {
    readJson(req).then((body) => {
      const sub = body && body.subscription ? body.subscription : body;
      const ok = sub && addSubscription(sub, { minLevel: body && body.minLevel, quiet: body && body.quiet });
      res.writeHead(ok ? 201 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: Boolean(ok) }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/unsubscribe") {
    readJson(req).then((body) => {
      if (body && body.endpoint) removeSubscription(body.endpoint);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Static assets (icons, OG image, manifest, service worker) served from web/.
  // Allowlisted extensions + basename-only lookup keeps this free of path
  // traversal — there are no sub-directories of assets to reach.
  if (req.method === "GET" && STATIC_TYPES[path.extname(req.url)]) {
    const name = path.basename(req.url);
    const file = path.join(here, "../web", name);
    if (existsSync(file)) {
      // The service worker and manifest must update promptly; everything else
      // (icons, images) can cache for a day.
      const volatile = name === "sw.js" || name === "manifest.webmanifest";
      res.writeHead(200, {
        "Content-Type": STATIC_TYPES[path.extname(req.url)],
        "Cache-Control": volatile ? "no-cache" : "public, max-age=86400",
      });
      res.end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const intervalMs = config.replay
  ? config.replayIntervalSeconds * 1000
  : config.pollMinutes * 60 * 1000;

server.listen(config.port, async () => {
  console.log(
    `Hurricane-Ready watching ${config.island.name} on :${config.port} ` +
      `(${status.mode} mode, tick every ${intervalMs / 1000}s)`
  );
  await tick();
  setInterval(tick, intervalMs);
});
