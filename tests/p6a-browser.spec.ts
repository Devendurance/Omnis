import { expect, test } from "@playwright/test";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";
import { P6A_SETTLEMENT_STORAGE_PREFIX } from "../src/lib/settlement/circle/persistence";

const USER_ALICE_DID = "did:privy:alice-browser";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";

test.describe("P6A Browser Circle + Arc Settlement Surface", () => {
  test.beforeEach(async ({ page }) => {
    test.slow();
    await page.addInitScript(() => {
      (window as unknown as { __mockPublicClient: unknown }).__mockPublicClient = {
        getChainId: async () => 5042002,
        readContract: async () => BigInt(10_000_000),
        getTransactionReceipt: async () => ({
          status: "success",
          blockNumber: BigInt(42000),
          transactionHash: "0xmocktransactionhash",
          gasUsed: BigInt(21000),
        }),
        waitForTransactionReceipt: async () => ({
          status: "success",
          blockNumber: BigInt(42000),
          transactionHash: "0xmocktransactionhash",
          gasUsed: BigInt(21000),
        }),
      };
    });
    // Set up authenticated mock state before navigating
    await page.goto("/app/wallet");
    await page.evaluate(
      ({ key, val }) => {
        localStorage.setItem(key, JSON.stringify(val));
      },
      {
        key: MOCK_AUTH_STORAGE_KEY,
        val: {
          authenticated: true,
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
      },
    );
    // Clear any previous settlement execution
    await page.evaluate((prefix) => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(prefix)) localStorage.removeItem(k);
      }
    }, P6A_SETTLEMENT_STORAGE_PREFIX);

    await page.reload();
  });

  test("displays prominent notice: Final contractor payment not sent", async ({
    page,
  }) => {
    const notice = page.locator(".settlement-prominent-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Final contractor payment not sent.");
    await expect(notice).toContainText("REQUIRE_APPROVAL");
  });

  test("displays Arc Testnet status and wallet metrics", async ({ page }) => {
    await expect(page.getByText("Circle + Arc Testnet Settlement")).toBeVisible();
    await expect(page.getByText("5042002 (Active)")).toBeVisible();
    await expect(page.getByText("Arc USDC (Wallet ERC-20)")).toBeVisible();
    await expect(page.getByText("Circle Unified Balance", { exact: true })).toBeVisible();
  });

  test("runs read-only preflight and reports non-signing status", async ({
    page,
  }) => {
    const preflightBtn = page.getByRole("button", {
      name: "run preflight check",
    });
    await expect(preflightBtn).toBeVisible();
    await preflightBtn.click();

    // Verify preflight results appear
    await expect(page.locator(".preflight-results")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("not performed")).toBeVisible();
    await expect(page.getByText("not submitted")).toBeVisible();
  });

  test("explicit confirmation boundary displays parameters before submission", async ({
    page,
  }) => {
    // Run preflight
    await page.getByRole("button", { name: "run preflight check" }).click();
    await expect(page.locator(".preflight-results")).toBeVisible({
      timeout: 10_000,
    });

    // Click initiate settlement
    const initiateBtn = page.getByRole("button", {
      name: "review & initiate test settlement",
    });
    await expect(initiateBtn).toBeVisible();
    await initiateBtn.click();

    // Verify confirmation boundary modal appears
    const overlay = page.locator(".confirmation-boundary-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Explicit Settlement Confirmation");
    await expect(overlay).toContainText("Arc Testnet (Chain ID 5042002)");
    await expect(overlay).toContainText("0.01 USDC");

    // Click cancel to close
    await page.getByRole("button", { name: "cancel" }).click();
    await expect(overlay).not.toBeVisible();
  });

  test("executing test settlement submits, displays transaction hash and link, and persists across reload", async ({
    page,
  }) => {
    // Run preflight
    await page.getByRole("button", { name: "run preflight check" }).click();
    await expect(page.locator(".preflight-results")).toBeVisible({
      timeout: 10_000,
    });

    // Initiate
    await page
      .getByRole("button", { name: "review & initiate test settlement" })
      .click();

    // Confirm & send
    const confirmBtn = page.getByRole("button", {
      name: "confirm & send test settlement",
    });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Evidence card appears
    const evidenceCard = page.locator(".settlement-evidence-card");
    await expect(evidenceCard).toBeVisible({ timeout: 15_000 });
    await expect(evidenceCard).toContainText("confirmed");
    await expect(evidenceCard).toContainText("42000");
    await expect(evidenceCard).toContainText("Transaction Hash:");
    // Check explorer link
    const explorerLink = page.locator(".explorer-link");
    await expect(explorerLink).toBeVisible();
    await expect(explorerLink).toHaveAttribute(
      "href",
      /https:\/\/testnet\.arcscan\.app\/tx\/.+/,
    );

    // Refresh page: execution state must persist and cannot be resubmitted automatically
    await page.reload();
    await expect(evidenceCard).toBeVisible({ timeout: 15_000 });
    // The initiate button should NOT be visible because an execution is active
    await expect(
      page.getByRole("button", { name: "review & initiate test settlement" }),
    ).not.toBeVisible();
  });
});
