import { expect, test } from "@playwright/test";

const HEDERA_PAYMENT_ID = "0.0.7162784@1788995118.130839662";
const ARC_TX_HASH =
  "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";

test.describe("P8B public evidence surface", () => {
  test("evidence page renders verified historical evidence without login", async ({
    page,
  }) => {
    await page.goto("/evidence");
    await expect(
      page.getByRole("heading", { name: /verified hackathon demo evidence/i }),
    ).toBeVisible();
    await expect(page.getByText(HEDERA_PAYMENT_ID)).toBeVisible();
    await expect(page.getByText(ARC_TX_HASH)).toBeVisible();
    await expect(page.getByText("61303876")).toBeVisible();
    await expect(page.getByText(/NOT EXECUTED/i)).toBeVisible();
    await expect(
      page.getByText(/read-only historical record, not a new live execution/i),
    ).toBeVisible();
    await expect(
      page.getByText(/open hackathon demo for authenticated visitors/i),
    ).toBeVisible();
  });

  test("landing proof section links the public evidence page", async ({
    page,
  }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: /verified demo evidence/i });
    await expect(link.first()).toBeVisible();
    await link.first().click();
    await expect(page).toHaveURL(/\/evidence$/);
  });
});
