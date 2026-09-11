import { expect, test, type Page } from "@playwright/test";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";
import SettlementDevelopmentPage from "../src/app/app/dev/settlement/page";

const routes = ["/", "/app", "/app/wallet", "/evidence"] as const;
const viewports = [
  { width: 320, height: 800 },
  { width: 375, height: 812 },
  { width: 393, height: 852 },
  { width: 430, height: 932 },
  { width: 600, height: 900 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

const AUTH = {
  authenticated: true,
  subject: "did:privy:p8c-browser",
  walletAddress: "0x1111111111111111111111111111111111111111",
};

async function assertNoOverflow(page: Page, route: string, width: number) {
  const metrics = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const crossing = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter(({ left, right, width }) => width > 0 && (left < -1 || right > viewport + 1))
      .slice(0, 12);
    return {
      viewport,
      htmlScrollWidth: document.documentElement.scrollWidth,
      htmlClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      crossing,
    };
  });
  expect(metrics.htmlScrollWidth, `${route} @ ${width}: ${JSON.stringify(metrics.crossing)}`).toBeLessThanOrEqual(metrics.htmlClientWidth + 1);
  expect(metrics.bodyScrollWidth, `${route} @ ${width}: ${JSON.stringify(metrics.crossing)}`).toBeLessThanOrEqual(width + 1);
}

test.describe("P8C responsive layout", () => {
  for (const viewport of viewports) {
    for (const route of routes) {
      test(`${route} has no horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(route);
        await page.evaluate(() => document.fonts.ready);
        await assertNoOverflow(page, route, viewport.width);
      });
    }
  }

  test("mobile product drawer keeps width, focus, and route close", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto("/app");
    const trigger = page.getByRole("button", { name: "Open navigation" });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Product navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
    const before = await page.evaluate(() => ({
      html: document.documentElement.clientWidth,
      body: document.body.clientWidth,
      htmlScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    await expect(drawer).toHaveCSS("width", /.+/);
    const open = await page.evaluate(() => ({
      html: document.documentElement.clientWidth,
      body: document.body.clientWidth,
      htmlScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    expect(open.htmlScroll).toBeLessThanOrEqual(open.html + 1);
    expect(open.bodyScroll).toBeLessThanOrEqual(open.body + 1);
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await trigger.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "proof", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/proof$/);
    await expect(drawer).not.toBeVisible();
    const after = await page.evaluate(() => ({
      html: document.documentElement.clientWidth,
      body: document.body.clientWidth,
      htmlScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    expect(after).toEqual(before);
  });

  test("landing mobile header keeps one row and 44px targets", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto("/");
    const header = page.locator("[data-landing-nav]");
    const menu = page.getByRole("button", { name: "Open navigation" });
    await expect(menu).toHaveCSS("min-height", "44px");
    const boxes = await header.locator(":scope > *").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
    expect(Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top))).toBeLessThanOrEqual(64);
  });

  test("public wallet is harness-free and shows execution wallet summary", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto("/app/wallet");
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: MOCK_AUTH_STORAGE_KEY, value: AUTH });
    await page.reload();
    await expect(page.locator(".wallet-truth-list dt", { hasText: "primary execution wallet" })).toBeVisible();
    await expect(page.getByText("privy embedded wallet", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Omnis uses this wallet only for actions you explicitly authorize.", { exact: true })).toBeVisible();
    await expect(page.getByText("P6A Settlement Infrastructure", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Manual Testnet Vertical Slice", { exact: true })).toHaveCount(0);
    await assertNoOverflow(page, "/app/wallet", 393);
  });

  test("production excludes the settlement harness by default", () => {
    const env = process.env as Record<string, string | undefined>;
    const previousNodeEnv = env.NODE_ENV;
    const previousHarnessFlag = env.ENABLE_P6A_DEV_HARNESS;
    env.NODE_ENV = "production";
    delete env.ENABLE_P6A_DEV_HARNESS;
    try {
      expect(() => SettlementDevelopmentPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    } finally {
      if (previousNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previousNodeEnv;
      if (previousHarnessFlag === undefined) delete env.ENABLE_P6A_DEV_HARNESS;
      else env.ENABLE_P6A_DEV_HARNESS = previousHarnessFlag;
    }
  });

  test("desktop rail and app main stay inside their own bounds", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/app");
    const dimensions = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const main = document.querySelector<HTMLElement>(".app-main");
      if (!sidebar || !main) throw new Error("app shell is missing");
      return {
        sidebar: [sidebar.scrollWidth, sidebar.clientWidth],
        main: [main.scrollWidth, main.clientWidth],
      };
    });
    expect(dimensions.sidebar[0]).toBeLessThanOrEqual(dimensions.sidebar[1] + 1);
    expect(dimensions.main[0]).toBeLessThanOrEqual(dimensions.main[1] + 1);
  });

  test("desktop landing uses Lenis and mobile uses native scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("main.landing")).toHaveAttribute("data-lenis-state", "ready");
    await page.setViewportSize({ width: 393, height: 852 });
    await page.reload();
    await expect(page.locator("main.landing")).toHaveAttribute("data-lenis-state", "disabled");
  });

  test("reduced motion disables animated landing scrolling", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("main.landing")).toHaveAttribute("data-lenis-state", "disabled");
    await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");
  });

  test("landing anchor history supports direct navigation and back", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/#policy");
    await expect(page.locator("#policy")).toBeInViewport();
    await page.getByRole("link", { name: "the proof", exact: true }).click();
    await expect(page).toHaveURL(/#proof$/);
    await page.goBack();
    await expect(page).toHaveURL(/#policy$/);
    await expect(page.locator("#policy")).toBeInViewport();
  });
});
