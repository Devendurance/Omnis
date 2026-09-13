import { expect, test } from "@playwright/test";

const viewports = [320, 375, 393, 430, 1024] as const;

test.describe("P9A.6 composer task actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app");
  });

  test("places task actions opposite the send control", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Task actions" });
    const submit = page.getByRole("button", { name: "Submit task" });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const [triggerBox, submitBox] = await Promise.all([
      trigger.boundingBox(),
      submit.boundingBox(),
    ]);
    expect(triggerBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(triggerBox!.width).toBeGreaterThanOrEqual(44);
    expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
    expect(triggerBox!.x).toBeLessThan(submitBox!.x);
  });

  test("opens the menu and supports Escape, outside click, and activation focus", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Task actions" });
    const input = page.getByRole("textbox", { name: "Your financial task" });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /start new task/i })).toBeVisible();
    await expect(menu.getByRole("menuitem")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await input.click();
    await expect(menu).toBeHidden();
    await trigger.click();
    await menu.getByRole("menuitem", { name: /start new task/i }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
  });

  test("supports keyboard activation and cancels a pending interpretation", async ({ page }) => {
    let release: (() => void) | undefined;
    await page.route("**/api/conversation", async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          gate: "plan",
          message: "stale response must not appear",
          fallback: false,
        }),
      });
    });
    const input = page.getByRole("textbox", { name: "Your financial task" });
    await input.fill("Pay a contractor 1 USDC.");
    await input.press("Enter");
    await expect(page.getByTestId("omnis-thinking")).toBeVisible();

    const trigger = page.getByRole("button", { name: "Task actions" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitem", { name: /start new task/i });
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await expect(page.getByTestId("omnis-thinking")).toHaveCount(0);
    await expect(input).toHaveValue("");
    release?.();
    await expect(page.getByText("stale response must not appear", { exact: true })).toHaveCount(0);
  });

  for (const width of viewports) {
    test(`stays contained at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/app");
      const trigger = page.getByRole("button", { name: "Task actions" });
      await trigger.click();
      const metrics = await page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        if (!menu) throw new Error("task actions menu missing");
        const rect = menu.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewport: window.innerWidth,
          htmlScrollWidth: document.documentElement.scrollWidth,
          htmlClientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
        };
      });
      expect(metrics.left).toBeGreaterThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewport);
      expect(metrics.htmlScrollWidth).toBeLessThanOrEqual(metrics.htmlClientWidth + 1);
      expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(width + 1);
    });
  }

  test("does not delete sentinel records or issue a financial write", async ({ page }) => {
    const sentinel = "useomnis:test:external-proof";
    await page.evaluate((key) => localStorage.setItem(key, "proof-sentinel"), sentinel);
    const financialRequests: string[] = [];
    page.on("request", (request) => {
      if (/service-purchase|final-settlement|eth_sendTransaction/i.test(request.url())) {
        financialRequests.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.getByRole("button", { name: "Task actions" }).click();
    await page.getByRole("menuitem", { name: /start new task/i }).click();
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), sentinel))
      .toBe("proof-sentinel");
    expect(financialRequests).toEqual([]);
  });
});
