import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: {
    // Hermetic P9A.2 coverage: the test server always rebuilds with an
    // explicit conversation-enabled mock-provider environment, never the
    // ambient .env.local. Stale servers are never reused. Production keeps
    // groq; only this test build is mock-bound.
    command:
      "npm run build && npm run start -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      OMNIS_ALLOW_MOCK_AUTH: "true",
      ENABLE_P6B_TEST_MODE: "true",
      ENABLE_P6A_DEV_HARNESS: "true",
      // An unmocked browser regression must never send a real service
      // payment: demo purchases stay off on the test server.
      OMNIS_DEMO_PURCHASES_ENABLED: "false",
      NEXT_PUBLIC_OMNIS_CONVERSATION_ENABLED: "true",
      OMNIS_LLM_PROVIDER: "mock",
      OMNIS_LLM_MODEL: "mock-1",
      OMNIS_LLM_API_KEY: "",
      OMNIS_LLM_BASE_URL: "",
      OPENAI_API_KEY: "",
      GROQ_API_KEY: "",
      // Preloads the server-side guard that throws on any fetch to an
      // external LLM host. Loopback stays allowed for localhost stubs.
      NODE_OPTIONS: "--require ./tests/guards/block-external-llm.js",
    },
  },
});
