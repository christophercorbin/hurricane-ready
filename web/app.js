    const LEVEL_TITLE = { ALL_CLEAR: "ALL CLEAR", WATCH: "WATCH", WARNING: "WARNING", IMMINENT: "IMMINENT" };
    const LEVEL_SUB = {
      ALL_CLEAR: "No tropical systems threatening the island.",
      WATCH: "A system is active in the Atlantic basin. No immediate threat.",
      WARNING: "A storm may pass near the island. Prepare now.",
      IMMINENT: "Finish preparations and be ready to shelter.",
    };
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    // ---- Settings: units + theme, remembered in localStorage ----
    const settings = { temp: "C", wind: "kmh", theme: "auto" };
    function loadSettings() { try { Object.assign(settings, JSON.parse(localStorage.getItem("hr-settings") || "{}")); } catch { /* ignore */ } }
    function saveSettings() { try { localStorage.setItem("hr-settings", JSON.stringify(settings)); } catch { /* ignore */ } }
    const prefersDark = () => !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
    function applyTheme() {
      const eff = settings.theme === "auto" ? (prefersDark() ? "dark" : "light") : settings.theme;
      document.documentElement.setAttribute("data-theme", eff);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", eff === "light" ? "#eef3fa" : "#0b1220");
    }
    // Data is stored in °C and km/h; current-conditions wind is in knots.
    const toTemp = (c) => c == null ? null : settings.temp === "F" ? Math.round(c * 9 / 5 + 32) : Math.round(c);
    const tUnit = () => settings.temp === "F" ? "°F" : "°C";
    const fmtTemp = (c) => c == null ? "—" : `${toTemp(c)}${tUnit()}`;
    const fmtDeg = (c) => c == null ? "—" : `${toTemp(c)}°`;
    const wUnit = () => settings.wind === "kt" ? "kt" : settings.wind === "mph" ? "mph" : "km/h";
    const fromKmh = (k) => k == null ? null : settings.wind === "kt" ? Math.round(k / 1.852) : settings.wind === "mph" ? Math.round(k / 1.609) : Math.round(k);
    const fromKt = (kt) => kt == null ? null : fromKmh(kt * 1.852);

    let lastStatus = null;
    function initSettings() {
      loadSettings();
      applyTheme();
      const t = document.getElementById("set-temp"), w = document.getElementById("set-wind"), th = document.getElementById("set-theme");
      t.value = settings.temp; w.value = settings.wind; th.value = settings.theme;
      const btn = document.getElementById("settings-btn"), panel = document.getElementById("settings-panel");
      // Settings panel a11y (#47): on open, focus moves into the panel; on
      // close, focus returns to the trigger button; Escape closes from
      // anywhere inside the panel. Keyboard-only users can now reach and
      // dismiss the menu.
      function openSettings() {
        panel.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        panel.querySelector("select")?.focus();
      }
      function closeSettings({ restoreFocus = true } = {}) {
        if (panel.hidden) return;
        panel.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        if (restoreFocus) btn.focus();
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (panel.hidden) openSettings(); else closeSettings({ restoreFocus: false });
      });
      document.addEventListener("click", (e) => {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
          closeSettings({ restoreFocus: false });
        }
      });
      panel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); closeSettings(); }
      });
      const onChange = () => { settings.temp = t.value; settings.wind = w.value; settings.theme = th.value; saveSettings(); applyTheme(); if (lastStatus) render(lastStatus); };
      t.onchange = onChange; w.onchange = onChange; th.onchange = onChange;
      if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (settings.theme === "auto") applyTheme(); });
    }

    // Live-region update-on-change (#49). Each poll re-renders the same
    // banner / civil / flood / arrival / wave text most of the time; without
    // this guard, screen readers re-announce the same string every minute
    // when a civil alert is active (assertive) or whenever a level title
    // hasn't changed. Skipping the DOM write when text matches keeps the
    // live region quiet.
    function setLiveText(el, text) {
      if (!el || el.__hrLast === text) return;
      el.__hrLast = text;
      el.textContent = text;
    }
    function setLiveHtml(el, html) {
      if (!el || el.__hrLast === html) return;
      el.__hrLast = html;
      el.innerHTML = html;
    }

    // Briefing sanitization (#51). Strip bidi / format / invisible-control
    // characters that could visually reverse evacuation guidance (U+202E
    // RIGHT-TO-LEFT OVERRIDE) and cap at 4 KB so a degenerate Bedrock
    // output can't blow out layout or scroll the user past the rest of
    // the dashboard.
    // U+202A-202E: explicit bidi overrides   (LRE, RLE, PDF, LRO, RLO)
    // U+2066-2069: bidi isolates             (LRI, RLI, FSI, PDI)
    // U+200E/200F: LTR / RTL marks
    // U+FEFF:      zero-width no-break space / BOM
    // Built via RegExp() so no literal control chars sit in the source.
    const BIDI_CTL_RE = new RegExp(
      "[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\uFEFF]",
      "g"
    );
    // HTML-escape NHC-derived strings before they're interpolated into
    // template literals (#29). NHC is currently trusted, but the chain
    // NHC RSS → server regex parse → JSON → template literal → innerHTML
    // is fragile, and one bad upstream byte shouldn't be enough to land
    // executable script on the dashboard. Combined with the CSP drop of
    // `'unsafe-inline'` on script-src (the inline-script extraction this
    // file enables), even an XSS that does land can't run inline scripts.
    const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    function escapeHtml(s) {
      if (s == null) return "";
      return String(s).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
    }

    function sanitizeBriefing(s) {
      if (s == null) return "—";
      return String(s).replace(BIDI_CTL_RE, "").slice(0, 4000);
    }

    function icon(code) {
      if (code === 0) return "☀️";
      if (code === 1 || code === 2) return "🌤️";
      if (code === 3) return "☁️";
      if (code === 45 || code === 48) return "🌫️";
      if (code >= 51 && code <= 67) return "🌧️";
      if (code >= 71 && code <= 77) return "❄️";
      if (code >= 80 && code <= 82) return "🌦️";
      if (code >= 95) return "⛈️";
      return "🌡️";
    }
    const uvWord = (uv) => uv == null ? "—" : uv < 3 ? "Low" : uv < 6 ? "Moderate" : uv < 8 ? "High" : uv < 11 ? "Very high" : "Extreme";
    const uvClass = (uv) => uv == null ? "low" : uv < 3 ? "low" : uv < 6 ? "moderate" : uv < 8 ? "high" : "extreme";
    const seaWord = (m) => m == null ? "—" : m < 1 ? "Calm" : m < 1.5 ? "Slight" : m < 2.5 ? "Moderate" : m < 4 ? "Rough" : "Very rough";
    const aqiWord = (v) => v == null ? "—" : v <= 50 ? "Good" : v <= 100 ? "Moderate" : v <= 150 ? "Unhealthy (sensitive)" : v <= 200 ? "Unhealthy" : v <= 300 ? "Very unhealthy" : "Hazardous";
    const aqiClass = (v) => v == null ? "low" : v <= 50 ? "low" : v <= 100 ? "medium" : "high";
    const hazeWord = (pm10) => pm10 == null ? "—" : pm10 < 30 ? "Clear" : pm10 < 55 ? "Slight haze" : pm10 < 110 ? "Hazy" : pm10 < 180 ? "Thick dust" : "Severe dust";
    const hazeClass = (pm10) => pm10 == null ? "low" : pm10 < 55 ? "low" : pm10 < 110 ? "medium" : "high";
    const windWordKt = (kt) => kt == null ? "light" : kt < 7 ? "light" : kt < 16 ? "gentle" : kt < 22 ? "breezy" : kt < 34 ? "fresh" : "strong";

    // Plain-language "what does this rating mean + what should I do" notes,
    // shown on demand behind a "?" so the tiles stay uncluttered.
    const seaExplain = (m) => m == null ? null
      : m < 1 ? "<b>Calm</b> — flat, glassy water. Great for swimming and small boats."
      : m < 1.5 ? "<b>Slight</b> — small waves about 1 m, knee-to-waist high. Fine for a swim."
      : m < 2.5 ? "<b>Moderate</b> — choppy, waves up to about 2.5 m. Swim with care and watch children."
      : m < 4 ? "<b>Rough</b> — big waves (2.5–4 m). Best to stay out of the water."
      : "<b>Very rough</b> — dangerous seas over 4 m. Keep off the beaches and don't take a boat out.";
    const uvExplain = (uv) => uv == null ? null
      : uv < 3 ? "<b>Low</b> — little burn risk. Safe to be outside."
      : uv < 6 ? "<b>Moderate</b> — you could burn in 30–45 min. Wear a hat and sunscreen for long stints outside."
      : uv < 8 ? "<b>High</b> — skin burns in about 25 min. Wear sunscreen and seek shade around midday."
      : uv < 11 ? "<b>Very high</b> — burns in about 15 min. Cover up and limit midday sun."
      : "<b>Extreme</b> — burns in minutes. Stay out of the midday sun where you can.";
    const aqiExplain = (v) => v == null ? null
      : v <= 50 ? "<b>Good</b> — the air is clean. Fine for everyone."
      : v <= 100 ? "<b>Moderate</b> — mostly fine. A few unusually sensitive people might notice irritation."
      : v <= 150 ? "<b>Unhealthy for sensitive groups</b> — OK for most, but people with asthma, heart or lung conditions should ease up on hard outdoor activity."
      : v <= 200 ? "<b>Unhealthy</b> — everyone may start to feel it. Limit long or intense time outdoors."
      : v <= 300 ? "<b>Very unhealthy</b> — health alert. Cut outdoor activity and keep windows shut."
      : "<b>Hazardous</b> — emergency levels. Stay indoors.";
    const hazeExplain = (pm10) => pm10 == null ? null
      : pm10 < 30 ? "Saharan dust blows across the Atlantic and hazes the sky. <b>Clear</b> right now — little dust about."
      : pm10 < 55 ? "Saharan dust blows across the Atlantic and hazes the sky. <b>Slight haze</b> — the sky looks a little milky; most people won't be affected."
      : pm10 < 110 ? "Saharan dust blows across the Atlantic and hazes the sky. <b>Hazy</b> — noticeable dust; people with asthma may feel it."
      : pm10 < 180 ? "Saharan dust blows across the Atlantic and hazes the sky. <b>Thick dust</b> — hazy air; limit time outdoors if you have breathing trouble."
      : "Saharan dust blows across the Atlantic and hazes the sky. <b>Severe dust</b> — keep windows closed; asthma and allergy sufferers should stay in.";

    // Build a readout tile. If `note` is given, add a "?" that reveals a
    // plain-language explanation in the same box — kept hidden by default so
    // the grid isn't an information dump.
    function infoTile(lbl, valHtml, note) {
      // No inline onclick (#29): the document-level delegated handler in
      // start() picks up clicks on any `.tile-info` button. `lbl` is one
      // of our own labels (not user data), but escape defensively anyway.
      const info = note
        ? `<button type="button" class="tile-info" aria-label="What does ${escapeHtml(lbl)} mean?" aria-expanded="false">?</button><div class="tile-note" hidden>${note}</div>`
        : "";
      return `<div class="wx-tile"><div class="lbl">${escapeHtml(lbl)}</div><div class="val">${valHtml}</div>${info}</div>`;
    }
    function toggleTileNote(btn) {
      const note = btn.parentElement && btn.parentElement.querySelector(".tile-note");
      if (!note) return;
      const open = note.hidden;
      note.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    }
    // Turn WMO descriptions into a natural adjective for "it's 22°C and ___".
    const feel = (code, desc) =>
      code >= 95 ? "stormy" :
      code >= 80 && code <= 82 ? "showery" :
      code >= 61 && code <= 67 ? "rainy" :
      code >= 51 && code <= 55 ? "drizzly" :
      code === 45 || code === 48 ? "foggy" :
      desc.toLowerCase();
    const hourLabel = (iso) => {
      const d = new Date(iso);
      let h = d.getHours();
      const ap = h >= 12 ? "pm" : "am";
      h = h % 12; if (h === 0) h = 12;
      return h + ap;
    };
    const timeLabel = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso);
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, "0");
      const ap = h >= 12 ? "pm" : "am";
      h = h % 12; if (h === 0) h = 12;
      return `${h}:${m} ${ap}`;
    };
    const MOON_ICONS = {
      "New moon": "🌑", "Waxing crescent": "🌒", "First quarter": "🌓",
      "Waxing gibbous": "🌔", "Full moon": "🌕", "Waning gibbous": "🌖",
      "Last quarter": "🌗", "Waning crescent": "🌘",
    };

    let map, layerGroup, radarLayer, radarFrames = [], radarHost = "", radarIdx = 0, radarTimer = null;

    function initMap(island) {
      map = L.map("map", { zoomControl: false }).setView([island.lat, island.lon], 6);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19,
      }).addTo(map);
      layerGroup = L.layerGroup().addTo(map);
      setupRadar();
    }

    async function setupRadar() {
      try {
        const r = await fetch("https://api.rainviewer.com/public/weather-maps.json");
        const data = await r.json();
        radarHost = data.host;
        radarFrames = (data.radar.past || []).concat(data.radar.nowcast || []);
        if (radarFrames.length) showRadarFrame(radarFrames.length - 1);
      } catch { /* radar optional */ }
    }

    function showRadarFrame(i) {
      if (!radarHost || !radarFrames[i]) return;
      radarIdx = i;
      const f = radarFrames[i];
      const url = `${radarHost}${f.path}/256/{z}/{x}/{y}/4/1_1.png`;
      if (radarLayer) map.removeLayer(radarLayer);
      radarLayer = L.tileLayer(url, { opacity: 0.6, zIndex: 5 }).addTo(map);
      document.getElementById("radar-time").textContent =
        "Radar " + new Date(f.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function toggleRadar() {
      const btn = document.getElementById("radar-toggle");
      if (radarTimer) {
        clearInterval(radarTimer); radarTimer = null; btn.textContent = "▶ Play radar"; return;
      }
      if (!radarFrames.length) return;
      btn.textContent = "⏸ Pause";
      radarTimer = setInterval(() => {
        showRadarFrame((radarIdx + 1) % radarFrames.length);
      }, 700);
    }

    const SAT_BASE = "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/car/GEOCOLOR/";
    let satFrames = [], satIdx = 0, satTimer = null, satLoaded = false;

    const dayOfYear = (d) =>
      Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
    const satFrameUrl = (d, size) => {
      const ts = `${d.getUTCFullYear()}${String(dayOfYear(d)).padStart(3, "0")}` +
        `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
      return `${SAT_BASE}${ts}_GOES19-ABI-car-GEOCOLOR-${size}.jpg`;
    };

    function setSatellite() {
      const fig = document.getElementById("sat");
      const img = document.getElementById("sat-img");
      const bucket = Math.floor(Date.now() / 600000);
      img.onload = () => { fig.hidden = false; };
      img.onerror = () => { fig.hidden = true; };
      // Smaller image on phones — ~286 KB vs ~950 KB, easier on mobile data.
      const size = window.innerWidth < 560 ? "500x500" : "1000x1000";
      img.src = `${SAT_BASE}${size}.jpg?_=${bucket}`;
    }

    // Lazily preload the last ~100 minutes of frames (started 20 min back to
    // allow for posting latency); keep only the ones that actually load.
    function loadSatFrames() {
      if (satLoaded) return Promise.resolve();
      const now = new Date();
      now.setUTCMinutes(Math.floor(now.getUTCMinutes() / 10) * 10, 0, 0);
      const got = [];
      const tries = [];
      for (let i = 2; i < 12; i++) {
        const d = new Date(now.getTime() - i * 600000);
        const url = satFrameUrl(d, "500x500");
        tries.push(new Promise((res) => {
          const im = new Image();
          im.onload = () => { got.push({ t: d.getTime(), url }); res(); };
          im.onerror = () => res();
          im.src = url;
        }));
      }
      return Promise.all(tries).then(() => {
        got.sort((a, b) => a.t - b.t);
        satFrames = got;
        satLoaded = true;
      });
    }

    async function toggleSat() {
      const btn = document.getElementById("sat-toggle");
      const img = document.getElementById("sat-img");
      const time = document.getElementById("sat-time");
      if (satTimer) {
        clearInterval(satTimer); satTimer = null;
        btn.textContent = "▶ Play loop"; time.textContent = "";
        setSatellite();
        return;
      }
      btn.textContent = "… loading";
      await loadSatFrames();
      if (!satFrames.length) { btn.textContent = "▶ Play loop"; return; }
      btn.textContent = "⏸ Pause";
      satIdx = 0;
      img.onerror = null;
      satTimer = setInterval(() => {
        const f = satFrames[satIdx % satFrames.length];
        img.src = f.url;
        time.textContent = "Frame " + new Date(f.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        satIdx++;
      }, 600);
    }

    function renderNow(s) {
      const w = s.weather;
      const el = document.getElementById("now-summary");
      if (!w) { el.textContent = "Current conditions are unavailable right now."; return; }
      document.getElementById("wx-now").hidden = false;
      document.getElementById("wx-grid").hidden = false;
      document.getElementById("wx-temp").textContent = fmtTemp(w.tempC);
      document.getElementById("wx-desc").textContent = w.description;
      document.getElementById("wx-feels").textContent = "Feels like " + fmtTemp(w.feelsLikeC);
      document.getElementById("wx-grid").innerHTML = `
        <div class="wx-tile"><div class="lbl">Wind</div><div class="val">${fromKt(w.windKt)} ${wUnit()} ${w.windFrom}</div></div>
        <div class="wx-tile"><div class="lbl">Gusts</div><div class="val">${fromKt(w.gustKt)} ${wUnit()}</div></div>
        <div class="wx-tile"><div class="lbl">Humidity</div><div class="val">${w.humidity}%</div></div>
        <div class="wx-tile"><div class="lbl">Rain</div><div class="val">${w.precipMm} mm</div></div>`;
      document.getElementById("wx-obs").textContent =
        "Observed " + agoText(w.observedAt + "Z") + " · Open-Meteo";
      const rain = w.precipMm > 0 ? " Light rain is falling." : "";
      const today = s.outlook && s.outlook.daily && s.outlook.daily[0];
      let todayClause = "";
      if (today) {
        const rp = today.rainProb ?? 0;
        const rainPhrase = rp >= 60 ? "showers likely" : rp >= 30 ? "a chance of showers" : "mostly dry";
        todayClause = ` Today: high ${fmtTemp(today.maxC)}, ${rainPhrase}.`;
      }
      el.innerHTML = `<span class="lead">It's ${fmtTemp(w.tempC)} and ${feel(w.code, w.description)}</span>, ` +
        `with a ${windWordKt(w.windKt)} ${w.windFrom} breeze.${rain}${todayClause}`;
    }

    function renderForecast(o) {
      const wrap = document.getElementById("days");
      const age = document.getElementById("forecast-age");
      age.textContent = o && o.generatedAt ? "Updated " + agoText(o.generatedAt) + " · Open-Meteo" : "";
      if (!o || !o.daily || !o.daily.length) { wrap.innerHTML = '<p class="summary">Forecast unavailable right now.</p>'; document.getElementById("forecast-summary").textContent = ""; return; }
      wrap.innerHTML = o.daily.map((d, idx) => {
        const dow = idx === 0 ? "Today" : DOW[new Date(d.date + "T00:00").getDay()];
        const rain = d.rainProb != null ? `<div class="rain" title="Chance of rain">💧 ${d.rainProb}%</div>` : "";
        return `<div class="day"><div class="dow">${dow}</div><div class="ico" aria-hidden="true">${icon(d.code)}</div>
          <div><span class="hi">${fmtDeg(d.maxC)}</span> <span class="lo">${fmtDeg(d.minC)}</span></div>${rain}</div>`;
      }).join("");
      const wet = o.daily.filter(d => (d.rainProb ?? 0) >= 50).length;
      const hi = Math.max(...o.daily.map(d => d.maxC));
      const lo = Math.min(...o.daily.map(d => d.minC));
      const temps = `Temperatures ${toTemp(lo)}–${toTemp(hi)}${tUnit()}.`;
      let lead, rest;
      if (wet === 0) { lead = "Mostly settled week ahead."; rest = ` Highs around ${fmtTemp(hi)}, lows near ${fmtTemp(lo)}, with little rain expected.`; }
      else if (wet === 7) { lead = "A wet week ahead."; rest = ` Rain is likely every day. ${temps}`; }
      else if (wet >= 4) { lead = "A wet week."; rest = ` ${wet} of the next 7 days look rainy. ${temps}`; }
      else { lead = "A mostly fine week."; rest = ` Just ${wet} wet ${wet === 1 ? "day" : "days"} ahead. ${temps}`; }
      document.getElementById("forecast-summary").innerHTML = `<span class="lead">${lead}</span>${rest}`;
    }

    function renderRainWind(o, w) {
      const wrap = document.getElementById("hours");
      const sum = document.getElementById("rainwind-summary");
      if (!o || !o.hourly || !o.hourly.length) { sum.textContent = "Hourly outlook unavailable right now."; wrap.innerHTML = ""; return; }
      const h = o.hourly;
      wrap.innerHTML = h.map(x => `
        <div class="hr"><div class="t">${hourLabel(x.time)}</div><div class="ico" aria-hidden="true">${icon(x.code)}</div>
          <div class="r" title="Chance of rain">💧 ${x.rainProb ?? 0}%</div><div class="w">${fromKmh(x.windKmh)} ${wUnit()}</div></div>`).join("");
      let peak = h[0];
      for (const x of h) if ((x.rainProb ?? 0) > (peak.rainProb ?? 0)) peak = x;
      const winds = h.map(x => x.windKmh);
      const wlo = Math.min(...winds), whi = Math.max(...winds);
      const dir = w ? " from the " + w.windFrom : "";
      let rainText;
      if ((peak.rainProb ?? 0) < 30) rainText = "Little to no rain expected over the next 24 hours.";
      else rainText = `Showers most likely around ${hourLabel(peak.time)} (${peak.rainProb}% chance).`;
      sum.innerHTML = `<span class="lead">${rainText}</span> Winds ${fromKmh(wlo)}–${fromKmh(whi)} ${wUnit()}${dir}.`;

      // Flash-flood watch from next-24h rainfall total + peak hourly intensity.
      const total24 = Math.round(h.reduce((a, x) => a + (x.precipMm || 0), 0));
      const peakHr = h.reduce((mx, x) => Math.max(mx, x.precipMm || 0), 0);
      let lvl = total24 < 15 ? 0 : total24 < 40 ? 1 : total24 < 75 ? 2 : total24 < 125 ? 3 : 4;
      if (peakHr >= 20 && lvl > 0 && lvl < 4) lvl++; // intense bursts flood faster
      const fn = document.getElementById("flood-note");
      if (lvl === 0) {
        // Clear the dedup tag (#49) so a hide→show transition with the
        // same text still re-announces to screen readers.
        fn.hidden = true;
        fn.__hrLast = undefined;
      }
      else {
        const msg = ["", "minor ponding possible in low-lying spots",
          "flash flooding possible in low-lying areas",
          "flash flooding likely — avoid flood-prone roads",
          "dangerous flooding — stay off the roads if you can"][lvl];
        fn.hidden = false;
        // Polite live region — dedup via setLiveHtml (#49)
        setLiveHtml(fn, `<span class="chance ${lvl <= 2 ? "medium" : "high"}">Flood watch</span> About ${total24} mm of rain expected over 24h — ${msg}.`);
      }
    }

    function renderSea(o, hourlyUv) {
      const grid = document.getElementById("sea-grid");
      const sum = document.getElementById("sea-summary");
      const m = o && o.marine;
      const uvNow = o && o.hourly && o.hourly.length ? o.hourly[0].uv : null;
      const uvMax = o && o.daily && o.daily.length ? o.daily[0].uvMax : null;
      const mh = m && m.waveHeightM != null ? m.waveHeightM : null;
      const waveVal = mh != null ? mh + " m" : "—";
      const periodVal = m && m.wavePeriodS != null ? m.wavePeriodS + " s" : "—";
      grid.innerHTML =
        infoTile("Sea state", seaWord(mh), seaExplain(mh)) +
        infoTile("Wave height", waveVal, mh != null ? `How tall the waves are, measured crest to trough — about <b>${mh} m</b> right now. Sea state is the word for the same thing.` : null) +
        infoTile("Wave period", periodVal, "The gap in seconds between one wave and the next. Longer gaps (10s+) mean a stronger, more powerful swell; short gaps are choppy wind-driven sea.") +
        infoTile("UV now", `<span class="uv ${uvClass(uvNow)}">${uvWord(uvNow)}</span>`, uvExplain(uvNow));
      const uvAdvice = (uvMax != null && uvMax >= 6) ? " UV peaks " + uvWord(uvMax).toLowerCase() + " today — wear sunscreen and seek shade around midday." : "";
      if (m && m.waveHeightM != null) {
        sum.innerHTML = `<span class="lead">Seas are ${seaWord(m.waveHeightM).toLowerCase()} at about ${m.waveHeightM} m.</span>${uvAdvice}`;
      } else {
        sum.innerHTML = `<span class="lead">Sea conditions are unavailable right now.</span>${uvAdvice}`;
      }
    }

    // Official DEM Category 1 hurricane shelters (2026 booklet). Source:
    // https://dem.gov.bb/emergency/shelter — review yearly against the booklet.
    const SHELTERS = [
      { name: "Blackman and Gollop Primary School", parish: "Christ Church", wc: true },
      { name: "Christ Church Foundation School", parish: "Christ Church", wc: true },
      { name: "Dunamis Outreach Ministries (Wesleyan Holiness Church)", parish: "Christ Church", wc: true },
      { name: "St. Christopher Primary School", parish: "Christ Church", wc: true },
      { name: "Gordon Walters Primary", parish: "Christ Church", wc: false },
      { name: "The Lester Vaughn School", parish: "St. Thomas", wc: true },
      { name: "Hillaby/Turners Hall", parish: "St. Thomas", wc: true },
      { name: "Hillaby Seventh Day Adventist Church", parish: "St. Andrew", wc: true },
      { name: "Gordon Greenidge Primary", parish: "St. James", wc: true },
      { name: "Queen's College", parish: "St. James", wc: true },
      { name: "The Church of God Orange Hill", parish: "St. James", wc: false },
      { name: "Ruby Nazarene Church", parish: "St. Philip", wc: true },
      { name: "Six Roads Seventh Day Adventist Church", parish: "St. Philip", wc: false },
      { name: "Six Roads Church of Christ", parish: "St. Philip", wc: false },
      { name: "Hilda Skeene Primary School", parish: "St. Philip", wc: true },
      { name: "The Lodge School", parish: "St. John", wc: true },
      { name: "Tamarind Hall Library / Eric Holder Municipal Complex", parish: "St. Joseph", wc: true },
      { name: "Black Rock Seventh Day Adventist Church", parish: "St. Michael", wc: true },
      { name: "Combermere School", parish: "St. Michael", wc: false },
      { name: "Dalkeith Methodist Church", parish: "St. Michael", wc: true },
      { name: "St. Barnabas Day Care Centre", parish: "St. Michael", wc: false },
      { name: "Lloyd Erskine Sandiford Centre", parish: "St. Michael", wc: true },
      { name: "Harrison College", parish: "St. Michael", wc: false },
      { name: "The University of the West Indies", parish: "St. Michael", wc: true },
      { name: "Faith Wesleyan Holiness Church", parish: "St. Michael", wc: false },
      { name: "Connell Town Pentecostal House of Prayer", parish: "St. Lucy", wc: true },
      { name: "William Donald George Parish Centre (St. Lucy Parish Church)", parish: "St. Lucy", wc: true },
      { name: "Cuthbert Moore Primary", parish: "St. George", wc: true },
      { name: "Ellerton Wesleyan Holiness Church", parish: "St. George", wc: true },
      { name: "Roland Edwards Primary School", parish: "St. Peter", wc: true },
      { name: "Coleridge and Parry School", parish: "St. Peter", wc: true },
    ];
    const PARISH_ORDER = ["Christ Church", "St. Andrew", "St. George", "St. James", "St. John",
      "St. Joseph", "St. Lucy", "St. Michael", "St. Peter", "St. Philip", "St. Thomas"];

    function initShelters() {
      const sel = document.getElementById("parish-select");
      for (const p of PARISH_ORDER) {
        const count = SHELTERS.filter((s) => s.parish === p).length;
        if (!count) continue;
        const o = document.createElement("option");
        o.value = p; o.textContent = `${p} (${count})`;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        renderShelters(sel.value);
        try { localStorage.setItem("hr-parish", sel.value); } catch { /* ignore */ }
      });
      let saved = "";
      try { saved = localStorage.getItem("hr-parish") || ""; } catch { /* ignore */ }
      if (saved && PARISH_ORDER.includes(saved)) { sel.value = saved; renderShelters(saved); }
    }

    function renderShelters(parish) {
      const el = document.getElementById("shelter-list");
      if (!parish) { el.innerHTML = ""; return; }
      el.innerHTML = SHELTERS.filter((s) => s.parish === parish)
        .map((s) => `<div class="shelter"><span class="s-name">${s.name}</span>${s.wc ? '<span class="s-wc" title="Wheelchair access" aria-label="Wheelchair access">♿</span>' : ""}</div>`)
        .join("");
    }

    function renderAir(o) {
      const grid = document.getElementById("air-grid");
      const sum = document.getElementById("air-summary");
      const aq = o && o.airQuality;
      const tide = o && o.tide;
      if (!aq && !tide) { sum.textContent = "Air and tide data are unavailable right now."; grid.innerHTML = ""; return; }
      const tideState = tide ? (tide.rising ? "Rising" : "Falling") : "—";
      const nextEvent = !tide ? "—"
        : tide.rising && tide.nextHigh ? "High " + timeLabel(tide.nextHigh.time)
        : tide.nextLow ? "Low " + timeLabel(tide.nextLow.time) : "—";
      grid.innerHTML =
        infoTile("Air quality", `<span class="chance ${aq ? aqiClass(aq.usAqi) : "low"}">${aq ? aqiWord(aq.usAqi) : "—"}</span>`, aq ? aqiExplain(aq.usAqi) : null) +
        infoTile("Saharan dust", `<span class="chance ${aq ? hazeClass(aq.pm10) : "low"}">${aq ? hazeWord(aq.pm10) : "—"}</span>`, aq ? hazeExplain(aq.pm10) : null) +
        infoTile("Tide", tideState, tide ? "Whether the sea is coming in (<b>rising</b>) or going out (<b>falling</b>). Rising tides cover more of the beach." : null) +
        infoTile("Next tide", nextEvent, tide ? "The time of the next high or low tide. Around high tide the water reaches furthest up the beach." : null);
      const parts = [];
      if (aq) {
        const aqi = aqiWord(aq.usAqi).toLowerCase();
        if (aq.pm10 >= 110) parts.push(`<span class="lead">Hazy with Saharan dust.</span> Air quality is ${aqi} — sensitive groups should limit time outdoors.`);
        else if (aq.pm10 >= 55) parts.push(`<span class="lead">A little Saharan haze about.</span> Air quality is ${aqi}.`);
        else parts.push(`<span class="lead">Clear air, little dust.</span> Air quality is ${aqi}.`);
      }
      if (tide) {
        parts.push(`Tide is ${tide.rising ? "rising" : "falling"}` +
          (tide.rising && tide.nextHigh ? ` — high around ${timeLabel(tide.nextHigh.time)}.` : tide.nextLow ? ` — low around ${timeLabel(tide.nextLow.time)}.` : "."));
      }
      sum.innerHTML = parts.join(" ");
    }

    function renderSunMoon(o) {
      const g = document.getElementById("sky-grid");
      const a = o && o.astro;
      const dayEl = document.getElementById("sky-day");
      if (!a) { g.innerHTML = `<div class="wx-tile"><div class="lbl">Sun &amp; moon</div><div class="val">—</div></div>`; if (dayEl) dayEl.textContent = ""; return; }
      if (dayEl) {
        const d = a.sunrise ? new Date(a.sunrise) : new Date();
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        const ds = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
        dayEl.innerHTML = `Sunrise, sunset and moon for <b>${sameDay ? "today" : ds}</b>${sameDay ? " (" + ds + ")" : ""}.`;
      }
      const dl = a.daylightSeconds != null
        ? `${Math.floor(a.daylightSeconds / 3600)}h ${Math.round((a.daylightSeconds % 3600) / 60)}m` : "—";
      g.innerHTML = `
        <div class="wx-tile"><div class="lbl">Sunrise</div><div class="val">${timeLabel(a.sunrise)}</div></div>
        <div class="wx-tile"><div class="lbl">Sunset</div><div class="val">${timeLabel(a.sunset)}</div></div>
        <div class="wx-tile"><div class="lbl">Daylight</div><div class="val">${dl}</div></div>
        <div class="wx-tile"><div class="lbl">Moon</div><div class="val">${MOON_ICONS[a.moonPhase] || "🌙"} ${a.moonIllumination}%</div><div class="lbl" style="margin-top:0.15rem">${a.moonPhase}</div></div>`;
    }

    function renderNames(s) {
      const el = document.getElementById("season-names");
      const names = s.seasonNames || [];
      const used = s.stormsSoFar || 0;
      const active = new Set((s.storms || []).map(x => x.name));
      el.innerHTML = names.map((n, i) => {
        let cls = "upcoming", tag = "";
        if (active.has(n)) { cls = "active"; tag = " · active now"; }
        else if (i < used) { cls = "used"; }
        else if (i === used) { cls = "next"; tag = " · next"; }
        return `<span class="name-chip ${cls}" title="${n}${tag}">${n}</span>`;
      }).join("");
    }

    function renderTropical(s) {
      const t = s.tropical;
      const sum = document.getElementById("tropical-summary");
      const areas = document.getElementById("tropical-areas");
      const src = document.getElementById("tropical-src");
      renderNames(s);
      const wn = document.getElementById("wave-note");
      if (s.waves && s.waves.near) {
        wn.hidden = false;
        const dev = (t && t.formationExpected === false) ? " No tropical development is expected." : "";
        // Polite live region — dedup via setLiveHtml (#49)
        setLiveHtml(wn, `<span class="lead">🌀 A tropical wave is crossing our area</span> (axis near ${s.waves.nearAxisLonW}°W) — expect passing showers and a gusty breeze.${dev}`);
      } else { wn.hidden = true; wn.__hrLast = undefined; }
      if (!t) { sum.textContent = "The Atlantic outlook is unavailable right now."; areas.innerHTML = ""; src.textContent = ""; return; }
      // NHC text → innerHTML — escape to prevent any upstream weirdness
      // from landing in the DOM as live markup (#29).
      sum.innerHTML = `<span class="lead">${escapeHtml(t.headline)}</span>` + (t.activeSystemsText ? ` ${escapeHtml(t.activeSystemsText)}` : "");
      if (t.areas && t.areas.length) {
        areas.innerHTML = t.areas.map(a => {
          const cat = a.chance7 ? a.chance7.category : "low";
          const pct = a.chance7 ? a.chance7.pct : 0;
          return `<div class="area">
            <div class="area-where">${escapeHtml(a.where)}</div>
            <div class="area-chance"><span class="chance ${cat}">${pct}%</span> chance of forming in 7 days</div>
            ${a.chance48 ? `<div class="area-48">${a.chance48.pct}% within 48 hours</div>` : ""}
          </div>`;
        }).join("");
      } else {
        areas.innerHTML = `<div class="area calm"><div class="area-where">☀️ All quiet across the Atlantic</div><div class="area-48">No new systems are expected to form in the next 7 days.</div></div>`;
      }
      const when = t.issuedAt ? new Date(t.issuedAt).toUTCString().slice(5, 22) + " UTC" : "";
      // t.url comes from NHC parsing; restrict to https to prevent
      // javascript: / data: URIs from sneaking through (#29).
      const safeUrl = (typeof t.url === "string" && /^https:\/\//.test(t.url)) ? t.url : "https://www.nhc.noaa.gov/";
      src.innerHTML = `NHC Tropical Weather Outlook${when ? " · issued " + when : ""} · <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">read the full outlook</a>`;
    }

    const haversineKm = (a, b, c, d) => {
      const R = 6371, p = Math.PI / 180;
      const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(x));
    };
    // Earliest time a storm's 34-kt wind field reaches the island, from the
    // forecast track + wind radii (tropical-storm-force arrival).
    function windsArrival(s) {
      const isl = s.island;
      let best = null;
      for (const st of s.storms || []) {
        if (st.radii34Km && haversineKm(isl.lat, isl.lon, st.lat, st.lon) <= st.radii34Km) return { hours: 0, name: st.name };
        for (const p of st.forecastPoints || []) {
          const r = p.radii34Km ?? st.radii34Km;
          if (r && Number.isFinite(p.lat) && haversineKm(isl.lat, isl.lon, p.lat, p.lon) <= r) {
            if (!best || p.hoursFromIssuance < best.hours) best = { hours: p.hoursFromIssuance, name: st.name };
            break;
          }
        }
      }
      return best;
    }

    function renderStorms(s) {
      const an = document.getElementById("arrival-note");
      const arr = windsArrival(s);
      if (arr) {
        const when = arr.hours === 0 ? "are arriving now"
          : `could reach us by about ${timeLabel(new Date(Date.parse(s.updatedAt) + arr.hours * 3600000).toISOString())} (~+${arr.hours}h)`;
        an.hidden = false;
        // Polite live region — dedup via setLiveHtml (#49)
        setLiveHtml(an, `<span class="chance high">Winds</span> Tropical-storm-force winds (34&nbsp;kt+) from ${escapeHtml(arr.name)} ${when}. Finish preparations early.`);
      } else { an.hidden = true; an.__hrLast = undefined; }
      const passText = (a) => {
        const p = a.pass;
        if (!p || p.kind === "distant") return "";
        if (p.kind === "direct-hit-risk") return `<small style="color:#fca5a5">may track very close</small>`;
        return `<small style="color:var(--accent)">passes ~${p.distanceKm} km to the ${p.side}</small>`;
      };
      const rows = s.storms.map(st => `
        <tr>
          <td><b>${escapeHtml(st.name)}</b></td>
          <td>${escapeHtml(st.classification)}</td>
          <td>${st.intensityKt} kt</td>
          <td>${st.assessment.distanceNowKm} km</td>
          <td>${st.assessment.closestApproachKm} km in ~${st.assessment.closestApproachInHours}h ${passText(st.assessment)}
              <br><small style="color:var(--muted)">(${st.assessment.method === "official-track" ? "NHC track" : "projected"}${st.assessment.windFieldKm ? `, winds reach ${st.assessment.windFieldKm} km` : ""})</small></td>
          <td><span class="chip ${st.assessment.level}">${st.assessment.level.replace("_", " ")}</span></td>
        </tr>`).join("");
      document.getElementById("storms-body").innerHTML = rows ||
        '<tr><td colspan="6"><div class="empty"><span class="sun" aria-hidden="true">☀️</span>No active systems — enjoy the sunshine.</div></td></tr>';

      document.getElementById("history").innerHTML = (s.history ?? []).slice(-8).reverse()
        .map(h => `${new Date(h.at).toUTCString().slice(5, 22)} UTC — ${h.from.replace("_", " ")} → <b>${h.to.replace("_", " ")}</b>`)
        .join("<br>") || "No level changes yet";
    }

    // NHC Atlantic track-forecast "cone of uncertainty" radii (nautical miles
    // at each forecast hour; 2026 table, ~67% of past errors fall inside).
    const CONE_NM = [[0, 0], [12, 25], [24, 39], [36, 49], [48, 62], [60, 77], [72, 95], [96, 134], [120, 200]];
    const coneRadiusKm = (h) => {
      if (h <= 0) return 0;
      const last = CONE_NM[CONE_NM.length - 1];
      if (h >= last[0]) return last[1] * 1.852;
      for (let i = 0; i < CONE_NM.length - 1; i++) {
        const [h0, r0] = CONE_NM[i], [h1, r1] = CONE_NM[i + 1];
        if (h >= h0 && h <= h1) return (r0 + (r1 - r0) * ((h - h0) / (h1 - h0))) * 1.852;
      }
      return 0;
    };
    const _rad = (d) => d * Math.PI / 180, _deg = (r) => r * 180 / Math.PI;
    function _bearing(a, b) {
      const p1 = _rad(a[0]), p2 = _rad(b[0]), dl = _rad(b[1] - a[1]);
      return (_deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360;
    }
    function _dest(p, brg, km) {
      const d = km / 6371, t = _rad(brg), p1 = _rad(p[0]), l1 = _rad(p[1]);
      const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
      const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
      return [_deg(p2), _deg(l2)];
    }
    // Build the cone polygon: offset the forecast track left/right by the
    // error radius at each point (perpendicular to the direction of travel).
    function coneFor(st) {
      const pts = (st.forecastPoints ?? []).filter((p) => Number.isFinite(p.lat));
      if (!pts.length) return null;
      const verts = [{ lat: st.lat, lon: st.lon, h: 0 }, ...pts.map((p) => ({ lat: p.lat, lon: p.lon, h: p.hoursFromIssuance }))];
      const left = [], right = [];
      for (let i = 0; i < verts.length; i++) {
        const v = [verts[i].lat, verts[i].lon];
        const prev = verts[i - 1] && [verts[i - 1].lat, verts[i - 1].lon];
        const next = verts[i + 1] && [verts[i + 1].lat, verts[i + 1].lon];
        const brg = prev && next ? _bearing(prev, next) : next ? _bearing(v, next) : _bearing(prev, v);
        const r = coneRadiusKm(verts[i].h);
        left.push(_dest(v, brg - 90, r));
        right.push(_dest(v, brg + 90, r));
      }
      return left.concat(right.reverse());
    }

    function renderMap(s) {
      if (!map) initMap(s.island);
      layerGroup.clearLayers();
      // White dot with a dark ring — stands out from the blue radar returns.
      L.circleMarker([s.island.lat, s.island.lon], { radius: 6, color: "#0b1220", weight: 3, fillColor: "#ffffff", fillOpacity: 1 })
        .bindTooltip(s.island.name, { permanent: true, direction: "bottom" }).addTo(layerGroup);
      for (const st of s.storms) {
        // Cone of uncertainty first, so the track and markers sit on top.
        const cone = coneFor(st);
        if (cone) {
          // Leaflet's bindTooltip treats the string content as HTML (writes
          // via innerHTML on the tooltip container) — escape st.name (#29).
          L.polygon(cone, { color: "#fbbf24", weight: 1, opacity: 0.5, fillColor: "#fbbf24", fillOpacity: 0.12 })
            .bindTooltip(`${escapeHtml(st.name)}: probable path of the centre (next 5 days)`).addTo(layerGroup);
        }
        L.circleMarker([st.lat, st.lon], { radius: 10, color: "#f87171", fillColor: "#dc2626", fillOpacity: 0.8 })
          .bindTooltip(`${escapeHtml(st.name)} (${st.intensityKt} kt)`, { permanent: true, direction: "top" }).addTo(layerGroup);
        L.polyline([[st.lat, st.lon], [s.island.lat, s.island.lon]], { color: "#475569", dashArray: "6 6", weight: 1 }).addTo(layerGroup);
        if (st.radii34Km) {
          L.circle([st.lat, st.lon], { radius: st.radii34Km * 1000, color: "#f97316", weight: 1, fillColor: "#f97316", fillOpacity: 0.12 })
            .bindTooltip(`34-kt winds to ~${st.radii34Km} km`).addTo(layerGroup);
        }
        const pts = (st.forecastPoints ?? []).filter(p => Number.isFinite(p.lat));
        if (pts.length > 0) {
          const track = [[st.lat, st.lon], ...pts.map(p => [p.lat, p.lon])];
          L.polyline(track, { color: "#fbbf24", weight: 2, dashArray: "8 5" }).addTo(layerGroup);
          for (const p of pts) {
            L.circleMarker([p.lat, p.lon], { radius: 4, color: "#fbbf24", fillColor: "#f59e0b", fillOpacity: 0.9 })
              .bindTooltip(`+${p.hoursFromIssuance}h${p.maxWindKt ? ` · ${p.maxWindKt} kt` : ""} (NHC forecast)`).addTo(layerGroup);
          }
        }
      }
    }

    function renderCivil(s) {
      const ca = document.getElementById("civil-alert");
      const c = s.civilAlert;
      if (c && c.active) {
        ca.hidden = false;
        ca.href = c.url || "https://brb-secondary.capews.com/capews/public/active";
        const n = c.count || 1;
        // Assertive live region — dedup via setLiveHtml (#49) so screen
        // readers don't re-announce "Official emergency alert in effect"
        // every 60 s while the same CAP alert is still active.
        setLiveHtml(
          document.getElementById("civil-text"),
          `<b>Official emergency alert${n > 1 ? "s" : ""} in effect.</b> Barbados DEM has ${n > 1 ? n + " active alerts" : "an active alert"} — tap for details on CAP.CAP.`
        );
      } else {
        ca.hidden = true;
        // Same dedup-clearing rationale (#49): if a CAP alert returns with
        // the same wording later, the assertive live region must re-announce.
        const cText = document.getElementById("civil-text");
        if (cText) cText.__hrLast = undefined;
      }
    }

    function render(s) {
      // Defensive defaults (#46): a partial /api/status (older SW cache,
      // 5xx-but-parseable, schema drift on deploy boundary) must not abort
      // the renderer chain. Without these guards `s.island.name` and
      // `s.storms.map` would throw and freeze the dashboard until reload.
      if (!s || typeof s !== "object") return;
      if (!s.island) { console.warn("render: missing s.island, skipping"); return; }
      s.storms = Array.isArray(s.storms) ? s.storms : [];
      s.history = Array.isArray(s.history) ? s.history : [];
      lastStatus = s;
      renderCivil(s);
      document.getElementById("island").textContent = s.island.name;
      document.getElementById("now-island").textContent = s.island.name;
      document.getElementById("mode").innerHTML = s.mode === "replay" ? "🎬 <b>Replay:</b> Beryl 2024" : "📡 <b>Live:</b> NHC feed";
      document.getElementById("updated").textContent = !s.updatedAt ? ""
        : s.mode === "replay" ? new Date(s.updatedAt).toUTCString().slice(5, 22) + " UTC"
        : relTime(s.updatedAt);

      const banner = document.getElementById("banner");
      banner.className = "banner " + s.level;
      document.getElementById("banner-title").textContent = LEVEL_TITLE[s.level];
      // Banner sub is in a polite live region — only update DOM on change (#49)
      setLiveText(document.getElementById("banner-sub"), LEVEL_SUB[s.level]);
      document.getElementById("banner-storms").innerHTML = s.storms.length
        ? `tracking<b>${s.storms.map(x => escapeHtml(x.name)).join(", ")}</b>` : "";

      document.getElementById("briefing").textContent = sanitizeBriefing(s.briefing);
      document.getElementById("briefing-source").textContent =
        s.briefingSource === "claude" ? "✨ Written by Claude on Amazon Bedrock · level decided by deterministic engine" :
        s.briefingSource === "template" ? "Standard guidance · level decided by deterministic engine" : "";
      document.getElementById("replay-label").textContent = s.replayLabel ?? "";

      renderNow(s);
      renderForecast(s.outlook);
      renderRainWind(s.outlook, s.weather);
      renderSea(s.outlook);
      renderSunMoon(s.outlook);
      renderAir(s.outlook);
      renderTropical(s);
      renderStorms(s);
      renderMap(s);
    }

    // Highlight the section nav link for whichever section is in view.
    function setupScrollSpy() {
      const links = [...document.querySelectorAll(".section-nav a")];
      const byId = Object.fromEntries(links.map(a => [a.getAttribute("href").slice(1), a]));
      const obs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            links.forEach(l => l.classList.remove("active"));
            byId[e.target.id]?.classList.add("active");
          }
        }
      }, { rootMargin: "-55% 0px -40% 0px" });
      document.querySelectorAll("section[id]").forEach(sec => obs.observe(sec));
    }

    function setOffline(off) { document.getElementById("offline-note").hidden = !off; }

    const agoText = (iso) => {
      if (!iso) return "";
      const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 90) return "just now";
      if (s < 3600) return Math.round(s / 60) + " min ago";
      if (s < 86400) return Math.round(s / 3600) + " h ago";
      return new Date(iso).toUTCString().slice(5, 17);
    };
    const relTime = (iso) => iso ? "Updated " + agoText(iso) : "";

    const urlB64 = (b64) => {
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
    };

    // Show the "Get storm alerts" opt-in only when push is supported AND the
    // server has VAPID keys configured; wire up subscribe / unsubscribe.
    async function initAlerts() {
      if (!("PushManager" in window) || !("Notification" in window)) return;
      let key;
      try { const r = await fetch("/api/vapidPublicKey"); if (!r.ok) return; key = (await r.json()).key; }
      catch { return; }
      if (!key) return;
      const bar = document.getElementById("alerts-bar");
      const text = document.getElementById("alerts-text");
      const btn = document.getElementById("alerts-btn");
      const prefsBox = document.getElementById("alerts-prefs");
      const levelSel = document.getElementById("pref-level");
      const quietBox = document.getElementById("pref-quiet");
      bar.hidden = false;
      const reg = await navigator.serviceWorker.ready;

      // Load saved alert prefs into the controls.
      const prefs = { minLevel: "WATCH", quiet: false };
      try { Object.assign(prefs, JSON.parse(localStorage.getItem("hr-alert-prefs") || "{}")); } catch { /* ignore */ }
      levelSel.value = prefs.minLevel; quietBox.checked = prefs.quiet;
      const readPrefs = () => ({ minLevel: levelSel.value, quiet: quietBox.checked });
      const savePrefs = (p) => { try { localStorage.setItem("hr-alert-prefs", JSON.stringify(p)); } catch { /* ignore */ } };
      // Unsubscribe token (#18). The server hands this back on subscribe; we
      // store it in localStorage and replay it on /api/unsubscribe. Without
      // it, anyone who learns the push endpoint URL could silently mute
      // this device.
      const tokenKey = "hr-unsub-token";
      const readToken = () => { try { return localStorage.getItem(tokenKey) || ""; } catch { return ""; } };
      const writeToken = (t) => { try { if (t) localStorage.setItem(tokenKey, t); else localStorage.removeItem(tokenKey); } catch { /* ignore */ } };
      const postSub = async (sub) => {
        const r = await fetch("/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub, ...readPrefs() }) });
        if (r.ok) {
          try { const j = await r.json(); if (j.unsubscribeToken) writeToken(j.unsubscribeToken); } catch { /* ignore */ }
        }
        return r;
      };

      const setState = (on) => {
        bar.classList.toggle("on", on);
        text.textContent = on
          ? "✓ Storm alerts are on for this device."
          : "🔔 Get a push the moment the storm level rises — even with the app closed.";
        btn.textContent = on ? "Turn off" : "Get storm alerts";
        btn.dataset.on = on ? "1" : "";
        prefsBox.hidden = false;
      };
      if (Notification.permission === "denied") {
        text.textContent = "Notifications are blocked. Turn them on in your browser settings to get storm alerts.";
        btn.hidden = true;
        return;
      }
      setState(Boolean(await reg.pushManager.getSubscription()));

      // Changing prefs persists, and updates the server if already subscribed.
      const onPrefChange = async () => {
        savePrefs(readPrefs());
        if (btn.dataset.on) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await postSub(sub);
        }
      };
      levelSel.onchange = onPrefChange;
      quietBox.onchange = onPrefChange;

      btn.onclick = async () => {
        btn.disabled = true;
        try {
          if (btn.dataset.on) {
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
              await fetch("/api/unsubscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ endpoint: sub.endpoint, unsubscribeToken: readToken() }),
              });
              await sub.unsubscribe();
              writeToken("");
            }
            setState(false);
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== "granted") { text.textContent = "Notifications weren't allowed. You can enable them in browser settings."; return; }
            const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
            savePrefs(readPrefs());
            await postSub(sub);
            setState(true);
          }
        } catch {
          text.textContent = "Couldn't change alert settings — please try again.";
        } finally {
          btn.disabled = false;
        }
      };
    }

    async function refresh(first) {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) return; // 5xx — keep the prior render; the next tick retries
        const payload = await res.json();
        // Render-time exceptions (#46) must not freeze the polling loop.
        try { render(payload); } catch (err) { console.error("render failed:", err); }
        // The sections above grow once live data lands, so an initial
        // deep-link (e.g. /#sea) needs re-aligning after the first render.
        if (first && location.hash) {
          const el = document.querySelector(location.hash);
          if (el) requestAnimationFrame(() => el.scrollIntoView());
        }
      } catch { /* transient */ }
    }

    // SW update toast (#50). When a fresh SW reaches "installed" and an
    // existing controller is in place (i.e. this isn't the first install),
    // surface a button so the user opts in rather than getting a forced
    // mid-session reload. The matching SKIP_WAITING handler is in sw.js.
    // The reload-on-controllerchange listener is only ARMED after the user
    // explicitly accepts an update toast. Otherwise the FIRST SW install on
    // a fresh client triggers a controllerchange (sw.js calls clients.claim
    // on activate) and we'd reload the page mid-initialization — which both
    // breaks any test that expects a stable post-load DOM and is a poor UX
    // (an unrequested reload on every first visit).
    let userInitiatedSkip = false;
    function showUpdateToast(waiting) {
      if (document.getElementById("hr-update-toast")) return;
      const t = document.createElement("button");
      t.id = "hr-update-toast";
      t.className = "hr-update-toast";
      t.type = "button";
      t.textContent = "Update available — tap to refresh";
      t.addEventListener("click", () => {
        t.disabled = true;
        t.textContent = "Refreshing…";
        userInitiatedSkip = true;
        waiting.postMessage({ type: "SKIP_WAITING" });
      });
      document.body.appendChild(t);
    }
    function watchForSwUpdates(reg) {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          if (next.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateToast(next);
          }
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!userInitiatedSkip) return; // first-install / unrelated → ignore
        location.reload();
      });
    }

    // The server polls NHC every ~15 min and the API just returns its cached
    // status, so a 60 s UI refresh keeps the dashboard current without
    // hammering the origin.
    const start = () => {
      initSettings();
      refresh(true);
      setInterval(() => refresh(false), 60000);
      setSatellite();
      setupScrollSpy();
      initShelters();
      document.getElementById("radar-toggle").addEventListener("click", toggleRadar);
      document.getElementById("sat-toggle").addEventListener("click", toggleSat);
      // Delegated click for the per-tile "?" buttons (#29). The inline
      // `onclick="toggleTileNote(this)"` was the last thing forcing
      // `'unsafe-inline'` to stay on script-src in the CSP — gone now.
      document.addEventListener("click", (e) => {
        const btn = e.target instanceof Element ? e.target.closest(".tile-info") : null;
        if (btn) toggleTileNote(btn);
      });

      setOffline(!navigator.onLine);
      window.addEventListener("online", () => { setOffline(false); refresh(false); });
      window.addEventListener("offline", () => setOffline(true));
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js")
          .then((reg) => { initAlerts(reg); watchForSwUpdates(reg); })
          .catch(() => {});
      }
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start);
