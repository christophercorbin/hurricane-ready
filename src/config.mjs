const num = (v, fallback) => (v != null && v !== "" ? Number(v) : fallback);
const list = (v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  // Island under watch (defaults: Barbados)
  island: {
    name: process.env.ISLAND_NAME ?? "Barbados",
    lat: num(process.env.ISLAND_LAT, 13.19),
    lon: num(process.env.ISLAND_LON, -59.54),
  },

  // Threat thresholds (km / hours)
  thresholds: {
    imminentKm: num(process.env.IMMINENT_KM, 150),
    imminentHours: num(process.env.IMMINENT_HOURS, 48),
    warningKm: num(process.env.WARNING_KM, 300),
    warningHours: num(process.env.WARNING_HOURS, 72),
    // Basin awareness box for WATCH level
    watchMaxLat: num(process.env.WATCH_MAX_LAT, 25),
    watchMinLon: num(process.env.WATCH_MIN_LON, -90),
    watchMaxLon: num(process.env.WATCH_MAX_LON, -40),
  },

  pollMinutes: num(process.env.POLL_MINUTES, 15),
  port: num(process.env.PORT, 8080),

  // Replay mode: REPLAY=1 replays fixtures/beryl-2024.json
  replay: process.env.REPLAY === "1",
  replayIntervalSeconds: num(process.env.REPLAY_INTERVAL_SECONDS, 12),
  // Replay dispatch override (#40): replay defaults to NOT firing SES /
  // SNS / webhook / push. Set REPLAY_DISPATCH=1 to allow it (for end-to-end
  // channel testing).
  replayDispatch: process.env.REPLAY_DISPATCH === "1",

  // AI briefings (optional — template fallback without it)
  bedrock: {
    enabled: process.env.DISABLE_AI !== "1",
    modelId:
      process.env.MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    region: process.env.AWS_REGION ?? "us-east-1",
  },

  // Alert channels (all optional)
  alerts: {
    emails: list(process.env.ALERT_EMAILS),
    senderEmail: process.env.SENDER_EMAIL ?? "",
    phones: list(process.env.ALERT_PHONES), // E.164, e.g. +12465550123
    webhookUrl: process.env.WEBHOOK_URL ?? "",
  },

  stateFile: process.env.STATE_FILE ?? "/data/state.json",
  nhcUrl:
    process.env.NHC_URL ?? "https://www.nhc.noaa.gov/CurrentStorms.json",
};
