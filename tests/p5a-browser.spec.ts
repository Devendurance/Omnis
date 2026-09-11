import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  money,
  transitionTask,
} from "../src/lib/domain";
import {
  createLiveServiceRegistry,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import { HEDERA_TESTNET_NETWORK } from "../src/lib/services/wallet-activity-descriptor";
import {
  getTaskSessionStorageKey,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";

const NOW = "2026-09-08T12:00:00.000Z";
const USER_A_DID = "did:privy:alice-111";
const USER_A_WALLET = "0x1111111111111111111111111111111111111111";
const USER_B_DID = "did:privy:bob-222";
const USER_B_WALLET = "0x2222222222222222222222222222222222222222";
const CONTRACTOR_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

test.describe("P5A Browser Authentication & Workspace Isolation", () => {
  test("unauthenticated workspace requests login and scopes tasks to identity", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate((key) => localStorage.removeItem(key), MOCK_AUTH_STORAGE_KEY);
    await page.reload();

    await expect(page.getByText("authentication required")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "log in with privy" }),
    ).toBeVisible();

    // Navigation button also invites to connect
    await expect(
      page.getByRole("button", { name: "connect wallet" }),
    ).toBeVisible();
  });

  test("authenticated user resolves stable owner subject and execution wallet badge", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(
      ({ key, val }) => localStorage.setItem(key, JSON.stringify(val)),
      {
        key: MOCK_AUTH_STORAGE_KEY,
        val: {
          authenticated: true,
          subject: USER_A_DID,
          walletAddress: USER_A_WALLET,
        },
      },
    );
    await page.reload();

    await expect(page.getByText(USER_A_DID)).toBeVisible();
    await expect(
      page.getByText(`execution wallet: ${USER_A_WALLET}`),
    ).toBeVisible();

    // App header shows truncated wallet and logout button
    await expect(
      page.getByRole("link", { name: "View execution wallet" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Log out of session" }),
    ).toBeVisible();

    const textarea = page.locator("#task-input");
    await expect(textarea).toBeEnabled();
  });

  test("wallet page displays truthful Privy state and no fake balances", async ({
    page,
  }) => {
    await page.goto("/app/wallet");
    await page.evaluate(
      ({ key, val }) => localStorage.setItem(key, JSON.stringify(val)),
      {
        key: MOCK_AUTH_STORAGE_KEY,
        val: {
          authenticated: true,
          subject: USER_A_DID,
          walletAddress: USER_A_WALLET,
          externalWallets: [
            {
              address: "0xExternalMetaMask1234567890abcdef123456",
              walletClientType: "metamask",
            },
          ],
        },
      },
    );
    await page.reload();

    await expect(page.getByText("wallet connected")).toBeVisible();
    await expect(page.getByText("Your execution wallet.")).toBeVisible();
    await expect(page.getByText(USER_A_WALLET)).toBeVisible();
    await expect(page.getByText("privy embedded wallet")).toBeVisible();
    const balanceMetric = page
      .locator(".wallet-summary-metric")
      .filter({ hasText: "Arc USDC balance" });
    await expect(balanceMetric).toBeVisible();
    await expect(balanceMetric).not.toContainText("0.00 USDC");
    await expect(
      page.getByText("primaryExecutionWallet (execution readiness)"),
    ).toBeVisible();

    // External wallet is truthfully listed under external wallets, not substituted as primary
    await expect(page.getByText("connected external wallets")).toBeVisible();
    await expect(
      page.getByText("0xExternalMetaMask1234567890abcdef123456"),
    ).toBeVisible();
  });

  test("logout removes access to authenticated task state", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(
      ({ key, val }) => localStorage.setItem(key, JSON.stringify(val)),
      {
        key: MOCK_AUTH_STORAGE_KEY,
        val: {
          authenticated: true,
          subject: USER_A_DID,
          walletAddress: USER_A_WALLET,
        },
      },
    );
    await page.reload();

    await expect(page.getByText(USER_A_DID)).toBeVisible();

    // Click logout
    await page.getByRole("button", { name: "Log out of session" }).click();

    // Workspace returns to unauthenticated prompt
    await expect(page.getByText("authentication required")).toBeVisible();
    await expect(page.getByText(USER_A_DID)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "log in with privy" }),
    ).toBeVisible();
  });

  test("switching accounts isolates task sessions between users", async ({
    page,
  }) => {
    const policy = createTaskPolicy({
      taskId: "alice-secret-task",
      maxServiceSpend: money("0.05", "USD"),
      maxPerService: money("0.05", "USD"),
      allowedServiceCategories: ["analytics"],
      allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
      allowedAssets: ["USDC"],
      allowedNetworks: [],
      finalPaymentApprovalRequired: true,
    });

    const task = createFinancialTask(
      {
        id: "alice-secret-task",
        ownerId: USER_A_DID,
        ownerSubject: USER_A_DID,
        ownerWalletAddress: USER_A_WALLET,
        type: "pay_with_check",
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        purpose: "Alice contractor confidential work",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    );

    const aliceSession = serializeDraftSession({
      version: 5,
      ownerSubject: USER_A_DID,
      ownerWalletAddress: USER_A_WALLET,
      messages: [
        {
          id: "msg-1",
          role: "user",
          kind: "message",
          content: "Alice confidential payment instruction",
          createdAt: NOW,
        },
      ],
      task,
      policy,
    });

    await page.goto("/app");

    // Seed Alice's session under her key
    await page.evaluate(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
        localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_A_DID,
          walletAddress: USER_A_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_A_DID),
        sessionVal: aliceSession,
      },
    );

    await page.reload();
    await expect(
      page.getByText("Alice confidential payment instruction"),
    ).toBeVisible();

    // Now switch identity to Bob
    await page.evaluate(
      ({ authKey, authVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_B_DID,
          walletAddress: USER_B_WALLET,
        },
      },
    );

    await page.reload();

    // Bob must NOT see Alice's task or confidential message
    await expect(page.getByText(USER_B_DID)).toBeVisible();
    await expect(
      page.getByText("Alice confidential payment instruction"),
    ).toHaveCount(0);
    await expect(
      page.getByText("Alice contractor confidential work"),
    ).toHaveCount(0);
  });

  test("flagship task reaches service-check approval state with truthful messages", async ({
    page,
  }) => {
    const policy = createTaskPolicy({
      taskId: "flagship-p5a",
      maxServiceSpend: money("0.05", "USD"),
      maxPerService: money("0.05", "USD"),
      allowedServiceCategories: ["analytics"],
      allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
      allowedAssets: ["USDC"],
      allowedNetworks: [],
      finalPaymentApprovalRequired: true,
    });

    const draft = createFinancialTask(
      {
        id: "flagship-p5a",
        ownerId: USER_A_DID,
        ownerSubject: USER_A_DID,
        ownerWalletAddress: USER_A_WALLET,
        type: "pay_with_check",
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        purpose: "Pay contractor after checking wallet",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    );

    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const service = registry.getService(WALLET_ACTIVITY_SERVICE_ID);
    if (!service?.paymentAmount) throw new Error("service fixture missing");
    const purchase = createServicePurchase(
      {
        id: "purchase-flagship",
        taskId: draft.id,
        serviceId: WALLET_ACTIVITY_SERVICE_ID,
        quotedAmount: service.price,
        paymentAmount: service.paymentAmount,
        paidAmount: service.price,
        policySnapshot: policy,
        status: "paid",
        requestId: "req-p5a-flagship",
        paymentIdentifier: "tx-hedera-p5a-001",
        settlementNetwork: HEDERA_TESTNET_NETWORK,
        serviceResult: {
          observations: { wallet: CONTRACTOR_WALLET, activityScore: "98" },
          heuristicFlags: [{ kind: "known-activity", severity: "info" }],
          disclaimer: "Fixture disclaimer",
          requestId: "req-p5a-flagship",
        },
      },
      NOW,
    );

    const task = moveTaskToAwaitingApproval(
      running,
      policy,
      [purchase],
      NOW,
    );

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_A_DID,
        ownerWalletAddress: USER_A_WALLET,
        messages: [],
        task,
        policy,
        servicePurchases: [purchase],
        discovery: {
          requiredCapability: "wallet-activity",
          selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
          discoveredAt: NOW,
          registryVersion: registry.version,
        },
      },
      registry,
    );

    await page.goto("/app");
    await page.evaluate(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
        localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_A_DID,
          walletAddress: USER_A_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_A_DID),
        sessionVal: sessionData,
      },
    );

    await page.reload();

    await expect(
      page.getByRole("heading", { name: "approval needed" }),
    ).toBeVisible();
    // The truth banner shows the loading text while the preflight resolves;
    // wait until the settled truth line is present before asserting.
    await expect(page.locator(".final-payment-truth")).toContainText(
      "Explicit approval is required before funds move.",
    );
    await expect(page.locator(".final-payment-truth")).toContainText(
      "Payment not sent.",
    );
    await expect(page.locator(".final-payment-truth")).toContainText(
      `Execution wallet: ${USER_A_WALLET}`,
    );
    await expect(
      page.getByText("paid, read-only activity confirmed"),
    ).toBeVisible();
    await expect(page.getByText("tx-hedera-p5a-001")).toBeVisible();
  });
});
