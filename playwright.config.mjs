import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: true,
  reporter: "line",
  use: {
    headless: true,
    screenshot: "only-on-failure",
  },
});
