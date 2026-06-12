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
import { assess } from "./threat.mjs";
import { generateBriefing } from "./briefing.mjs";
import { dispatchAlert } from "./notify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(path.join(here, "../web/index.html"), "utf-8");

// ---------- State (JSON file on a volume) ----------

function loadState() {
  try {
    if (existsSync(config.stateFile)) {
      return JSON.parse(readFileSync(config.stateFile, "utf-8"));
    }
  } catch {
    /* corrupted state: start fresh */
  }
  return { level: "ALL_CLEAR", history: [] };
}

function saveState(state) {
  try {
    mkdirSync(path.dirname(config.stateFile), { recursive: true });
    writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`Could not persist state: ${err.message}`);
  }
}

let state = loadState();

// ---------- Current status (served by the API) ----------

let status = {
  island: config.island,
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

    // Briefing: regenerate on level change or first run
    if (levelChanged || !status.briefing) {
      const briefing = await generateBriefing(
        assessment,
        config.island,
        config.bedrock
      );
      status.briefing = briefing.text;
      status.briefingSource = briefing.source;
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

      state.history.push({
        at: timestamp,
        from: state.level,
        to: assessment.overall,
      });
      state.history = state.history.slice(-50);
      state.level = assessment.overall;
      saveState(state);
    }

    status = {
      ...status,
      level: assessment.overall,
      // advisoryExcerpt feeds the briefing, not the API payload
      storms: assessment.storms.map(({ advisoryExcerpt, ...s }) => s),
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: status.mode, level: status.level }));
    return;
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
