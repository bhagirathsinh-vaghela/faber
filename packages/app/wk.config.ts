import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e-wk",
  timeout: 60_000,
  reporter: [["line"]],
  projects: [
    { name: "webkit", use: { ...devices["iPad Pro 11"], browserName: "webkit" }, grep: /iPad WebKit/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grep: /desktop Chromium/ },
  ],
})
