import path from "node:path";
import { test } from "@playwright/test";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";

const authState = {
  authenticated: true,
  subject: "did:privy:p8c-screenshot",
  walletAddress: "0x1111111111111111111111111111111111111111",
};

const captures = [
  { route: "/", width: 1440, height: 900, name: "landing-desktop" },
  { route: "/", width: 393, height: 852, name: "landing-iphone-14-pro" },
  { route: "/app", width: 1440, height: 900, name: "app-desktop" },
  { route: "/app", width: 393, height: 852, name: "app-iphone-14-pro" },
  { route: "/app/wallet", width: 1440, height: 900, name: "wallet-desktop" },
  { route: "/app/wallet", width: 393, height: 852, name: "wallet-iphone-14-pro" },
] as const;

test.describe("P8C visual captures", () => {
  for (const capture of captures) {
    test(`${capture.name} screenshot`, async ({ page }) => {
      await page.setViewportSize({ width: capture.width, height: capture.height });
      await page.goto(capture.route);
      if (capture.route.startsWith("/app")) {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
          key: MOCK_AUTH_STORAGE_KEY,
          value: authState,
        });
        await page.reload();
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: path.join(process.cwd(), "screenshots", `p8c-${capture.name}.png`),
        fullPage: false,
      });
    });
  }
});
