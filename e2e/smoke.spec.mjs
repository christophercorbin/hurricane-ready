import { test, expect } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:8080";

// Renders the live dashboard (against a running container, ideally in replay
// mode) and asserts every section is populated with real data — so a silent
// frontend break is caught in CI, not by users during a storm.
test("dashboard renders every section with real data", async ({ page }) => {
  // Catch real JS errors; ignore external resource (tile/satellite) hiccups.
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) {
      jsErrors.push(m.text());
    }
  });

  await page.goto(BASE, { waitUntil: "load" });
  // wait for the first /api/status render to land
  await expect(page.locator("#banner-title")).not.toHaveText("Checking the skies…", { timeout: 15000 });

  // Right now
  await expect(page.locator("#wx-temp")).not.toHaveText("");
  await expect(page.locator("#now-summary")).toContainText("It's");

  // 7-day forecast: exactly 7 day cards
  await expect(page.locator("#days .day")).toHaveCount(7);

  // Rain & wind hourly strip
  expect(await page.locator("#hours .hr").count()).toBeGreaterThan(0);

  // Beach & sea + air/tide tiles
  expect(await page.locator("#sea-grid .wx-tile").count()).toBeGreaterThan(0);
  expect(await page.locator("#air-grid .wx-tile").count()).toBeGreaterThan(0);

  // Storms table populated (replay has Beryl, or the empty-state row otherwise)
  expect(await page.locator("#storms-body tr").count()).toBeGreaterThan(0);

  // Season name chips
  expect(await page.locator("#season-names .name-chip").count()).toBeGreaterThan(0);

  // Shelters: emergency numbers + parish filter
  await expect(page.locator(".emerg .emerg-num")).toHaveCount(5);
  await page.selectOption("#parish-select", "Christ Church");
  expect(await page.locator("#shelter-list .shelter").count()).toBeGreaterThan(0);

  // Service worker registers (PWA)
  const swOk = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  expect(swOk).toBe(true);

  expect(jsErrors, jsErrors.join("\n")).toEqual([]);
});
