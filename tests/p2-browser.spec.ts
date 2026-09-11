import { expect, test } from "@playwright/test";
import { DRAFT_SESSION_STORAGE_KEY } from "../src/lib/tasks/persistence";

test("flagship plan exposes its bounded service budget", async ({ page }) => {
  await page.goto("/app");
  await page.evaluate((key) => localStorage.removeItem(key), DRAFT_SESSION_STORAGE_KEY);
  await page.reload();

  const input = page.getByRole("textbox", { name: "Your financial task" });
  await input.fill(
    "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
  );
  await page.getByRole("button", { name: "Submit task" }).click();
  await input.fill("0x1234567890abcdef");
  await page.getByRole("button", { name: "Submit task" }).click();

  await expect(page.getByText("validated task plan", { exact: true })).toBeVisible();
  await expect(page.getByText("bounded task budget", { exact: true })).toBeVisible();
  await expect(page.getByText("service spend boundary", { exact: true })).toBeVisible();
  await expect(page.getByText("$0.05", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$0", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("remaining before purchase", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Catalog-only. No service was purchased.", { exact: true }),
  ).toBeVisible();

  const mainText = await page.getByRole("main").innerText();
  expect(mainText).not.toMatch(
    /payment submitted|settled|transaction confirmed|proof is ready|service result/i,
  );
});
