import { expect, test, type Page } from "@playwright/test";
import { trackTestRequests } from "./helpers/conversation-test";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const RECIPIENT = "0xC446221191062923984729104820174029466Dc9";
const PROMPT = `Pay ${RECIPIENT} 1 USDC.`;

async function preparePage(page: Page) {
  await page.goto("/app");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

async function stubConversation(page: Page, message: string, status = 200) {
  await page.route("**/api/conversation", async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body:
        status === 200
          ? JSON.stringify({ gate: "plan", message, fallback: false })
          : JSON.stringify({ error: "provider unavailable" }),
    });
  });
}

async function submit(page: Page, text = PROMPT) {
  const input = page.getByRole("textbox", { name: "Your financial task" });
  await input.fill(text);
  await page.getByRole("button", { name: "Submit task" }).click();
}

test.describe("P9A.3 conversational response motion", () => {
  test("shows thinking immediately and holds an early response for four seconds", async ({ page }) => {
    await stubConversation(page, "Exact response,\nwith preserved whitespace.");
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);

    await expect(page.getByTestId("omnis-thinking")).toHaveCount(1, { timeout: 100 });
    await page.clock.runFor(7_500);
    await expect(page.locator(".omnis-bubble").last()).toContainText(
      "Exact response,\nwith preserved whitespace.",
    );
  });

  test("starts immediately when a slow response arrives after the minimum", async ({ page }) => {
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/conversation", async (route) => {
      await response;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ gate: "plan", message: "slow answer", fallback: false }),
      });
    });
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);
    await page.clock.fastForward(4_001);
    await expect(page.getByTestId("omnis-thinking")).toHaveCount(1, { timeout: 100 });
    release();
    await page.clock.runFor(100);
    await expect(page.getByTestId("omnis-typing")).toHaveCount(1, { timeout: 1_000 });
  });

  test("caps long responses and keeps authoritative cards independent", async ({ page }) => {
    const longResponse = "long response ".repeat(100);
    await stubConversation(page, longResponse);
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);

    await expect(page.locator(".task-plan-card")).toHaveCount(1, { timeout: 100 });
    await expect(page.getByTestId("omnis-thinking")).toHaveCount(1, { timeout: 100 });
    await page.clock.fastForward(4_000);
    await page.clock.fastForward(3_500);
    await expect(page.locator(".omnis-bubble").last()).toContainText(longResponse);
  });

  test("hydrated messages render instantly without replaying motion", async ({ page }) => {
    await stubConversation(page, "historical response");
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);
    await page.clock.fastForward(7_500);
    await expect(page.locator(".omnis-bubble").last()).toContainText("historical response");
    await page.reload();

    await expect(page.getByText("historical response")).toBeVisible();
    await expect(page.getByTestId("omnis-thinking")).toHaveCount(0);
    await expect(page.getByTestId("omnis-typing")).toHaveCount(0);
  });

  test("a second submission completes the first reveal and leaves one active animation", async ({ page }) => {
    await stubConversation(page, "first response");
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page, "Hello there.");
    await page.clock.fastForward(4_100);
    await expect(page.getByTestId("omnis-typing")).toHaveCount(1, { timeout: 100 });
    const partialFirstResponse = await page.locator(".omnis-bubble").last().innerText();

    await submit(page, "Please explain.");
    const completedFirstResponse = await page.locator(".omnis-bubble").first().innerText();
    expect(completedFirstResponse.length).toBeGreaterThan(partialFirstResponse.length);
    await expect(page.getByTestId("omnis-thinking")).toHaveCount(1);
  });

  test("reduced motion skips typewriting and announces completed copy only", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubConversation(page, "reduced motion response");
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);

    await expect(page.getByTestId("omnis-thinking")).toHaveCount(1, { timeout: 100 });
    await page.clock.runFor(7_500);
    await expect(page.locator(".conversational-canvas").getByText("reduced motion response")).toBeVisible();
    await expect(page.getByTestId("omnis-typing")).toHaveCount(0);
    await expect(page.locator('[role="status"][aria-live="polite"]').last()).toHaveAttribute(
      "aria-label",
      "reduced motion response",
    );
  });

  test("fallback motion performs no financial writes", async ({ page }) => {
    const log = await trackTestRequests(page);
    await stubConversation(page, "unused", 500);
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);
    await page.clock.fastForward(7_500);

    expect(log.financialWrites).toEqual([]);
    expect(log.forbiddenLlm).toEqual([]);
    await expect(page.locator(".omnis-bubble").last()).toBeVisible();
  });

  test("unmount does not leave stale animation updates", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await stubConversation(page, "unmounted response");
    await preparePage(page);
    await page.clock.install({ time: NOW });
    await submit(page);
    await page.clock.fastForward(4_100);
    await page.goto("/");
    await page.clock.fastForward(7_500);
    expect(errors).toEqual([]);
  });
});
