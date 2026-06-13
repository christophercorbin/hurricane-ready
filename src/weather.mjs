/**
 * Current conditions for the island, from the free Open-Meteo API
 * (no key required). Returns null on any failure so the dashboard
 * simply omits the panel rather than breaking.
 */
const WMO = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  80: "Light showers", 81: "Showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm",
};

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => COMPASS[Math.round(((deg % 360) / 22.5)) % 16];

export async function fetchCurrentWeather(island) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${island.lat}&longitude=${island.lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,` +
    `weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=kn`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "hurricane-ready (github.com/christophercorbin/hurricane-ready)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const c = (await res.json()).current;
    if (!c) throw new Error("no current block");
    return {
      tempC: Math.round(c.temperature_2m),
      feelsLikeC: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      precipMm: c.precipitation,
      windKt: Math.round(c.wind_speed_10m),
      gustKt: Math.round(c.wind_gusts_10m),
      windFrom: compass(c.wind_direction_10m),
      code: c.weather_code,
      description: WMO[c.weather_code] ?? "—",
      observedAt: c.time,
    };
  } catch (err) {
    console.warn(`Weather unavailable (${err.message})`);
    return null;
  }
}
