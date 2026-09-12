import { expect, test } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createSettlementExecution,
  createTaskPolicy,
  money,
  transitionSettlement,
  transitionTask,
  type ApprovalRecord,
  type FinancialTask,
  type ServicePurchase,
  type SettlementExecution,
  type TaskPolicy,
} from "../src/lib/domain";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
} from "../src/lib/services/wallet-activity-descriptor";
import { P6B_TEST_MODE_AMOUNT } from "../src/lib/settlement/final/service";
import {
  getTaskSessionStorageKey,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import {
  createLiveServiceRegistry,
  serializeServiceRegistry,
} from "../src/lib/services/registry";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";

const NOW = "2026-09-11T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-p7";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACTOR_WALLET = "0xC446221191062923984729104820174029466Dc9";

function makePolicy(taskId: string): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
}

function makeTask(taskId: string, policy = makePolicy(taskId)): FinancialTask {
  return createFinancialTask(
    {
      id: taskId,
      ownerId: USER_ALICE_DID,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      type: "pay_with_check",
      originalIntent:
        "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
      recipient: CONTRACTOR_WALLET,
      paymentAmount: money("50", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
}

function makePaidPurchase(taskId: string, policy: TaskPolicy): ServicePurchase {
  return createServicePurchase(
    {
      id: `purchase-${taskId}`,
      taskId,
      serviceId: WALLET_ACTIVITY_SERVICE_ID,
      quotedAmount: money("0.003", "USD"),
      paymentAmount: WALLET_ACTIVITY_PRICE,
      paidAmount: money("0.003", "USD"),
      policySnapshot: policy,
      status: "paid",
      requestId: `req-${taskId}`,
      paymentIdentifier: "0.0.7162784@1788908433.043020353",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: {
          wallet: CONTRACTOR_WALLET,
          addressValidity: "valid",
          accountType: "eoa",
          transactionCount: "18",
          transactionActivityObserved: true,
        },
        heuristicFlags: [{ code: "known_active_wallet", severity: "info" }],
        disclaimer: "Factual observation result.",
        requestId: `req-${taskId}`,
      },
    },
    NOW,
  );
}

function makeApproval(
  taskId: string,
  policy: TaskPolicy,
  task: FinancialTask,
): ApprovalRecord {
  return createApprovalRecord({
    id: `appr-${taskId}`,
    taskId,
    settlementExecutionId: `settle-${taskId}`,
    approverId: USER_ALICE_DID,
    walletAddress: USER_ALICE_WALLET,
    amount: P6B_TEST_MODE_AMOUNT,
    requestedAmount: task.paymentAmount!,
    executionAmount: P6B_TEST_MODE_AMOUNT,
    asset: "USDC",
    recipient: CONTRACTOR_WALLET,
    network: "Arc Testnet",
    policySnapshot: policy,
    testMode: true,
    approvedAt: NOW,
  });
}

function makeSubmittedSettlement(
  task: FinancialTask,
  policy: TaskPolicy,
  approval: ApprovalRecord,
  txHash: string,
): SettlementExecution {
  const prepared = createSettlementExecution({
    id: `settle-${task.id}`,
    taskId: task.id,
    provider: "circle",
    amount: P6B_TEST_MODE_AMOUNT,
    executionAmount: P6B_TEST_MODE_AMOUNT,
    requestedAmount: task.paymentAmount!,
    testMode: true,
    recipient: CONTRACTOR_WALLET,
    network: "Arc Testnet",
    approvalRequired: true,
    policySnapshot: policy,
  });
  const awaiting = transitionSettlement(prepared, "awaiting_approval", {
    now: NOW,
  });
  const submitting = transitionSettlement(awaiting, "submitting", {
    approval,
    now: NOW,
  });
  return transitionSettlement(submitting, "submitted", {
    transactionHash: txHash,
    now: NOW,
  });
}

function makeConfirmedSettlement(
  task: FinancialTask,
  policy: TaskPolicy,
  approval: ApprovalRecord,
  txHash: string,
): SettlementExecution {
  const submitted = makeSubmittedSettlement(task, policy, approval, txHash);
  const confirming = transitionSettlement(submitted, "confirming", {
    now: NOW,
  });
  return transitionSettlement(confirming, "confirmed", {
    confirmation: {
      source: "reconciliation",
      transactionHash: txHash,
      outcome: "confirmed",
      observedAt: NOW,
    },
    now: NOW,
  });
}

test.describe("P7 Conversational useOmnis Agent Experience", () => {
  test("1. empty state is conversation-first with clear prompt starters and no giant panels", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Verification of required empty state copy
    await expect(page.getByText("from mandate to proof")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "What needs to get done?" }),
    ).toBeVisible();
    await expect(
      page.getByText("Give Omnis the task, budget, and rules."),
    ).toBeVisible();

    // Composer placeholder
    const textarea = page.getByRole("textbox", { name: "Your financial task" });
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveAttribute(
      "placeholder",
      "Tell Omnis what needs to get done...",
    );

    // Subtle prompt starters
    await expect(
      page.getByRole("button", { name: /Pay a contractor/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Check a wallet before paying/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Give an agent a research budget/ }),
    ).toBeVisible();

    // No giant diagnostic tables in empty state
    await expect(
      page.getByRole("heading", { name: "approval needed" }),
    ).toHaveCount(0);
    await expect(page.getByText("service spend boundary")).toHaveCount(0);
  });

  test("2. composer is persistent across conversation states", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const composerWrapper = page.locator(".conversational-sticky-composer");
    await expect(composerWrapper).toBeVisible();

    // Submit a message
    const input = page.getByRole("textbox", { name: "Your financial task" });
    await input.fill(
      "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
    );
    await page.getByRole("button", { name: "Submit task" }).click();

    // Composer remains mounted and visible
    await expect(composerWrapper).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Your financial task" }),
    ).toBeVisible();
  });

  test("3. flagship prompt renders as conversation with user right and omnis left", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const input = page.getByRole("textbox", { name: "Your financial task" });
    await input.fill(
      "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
    );
    await page.getByRole("button", { name: "Submit task" }).click();

    // User turn on right
    await expect(page.locator(".conversational-turn.user-turn")).toBeVisible();
    await expect(page.locator(".user-bubble")).toContainText(
      "Spend no more than $0.05 checking.",
    );

    // Omnis turn on left
    await expect(
      page.locator(".conversational-turn.omnis-turn").first(),
    ).toBeVisible();
    await expect(page.locator(".omnis-avatar").first()).toBeVisible();
    await expect(page.getByText("Who should receive 50 USDC?")).toBeVisible();

    // Provide recipient
    await input.fill(CONTRACTOR_WALLET);
    await page.getByRole("button", { name: "Submit task" }).click();

    // Omnis acknowledges plan
    await expect(
      page.getByText(
        "I can do that. I'll check the wallet before preparing the payment.",
      ),
    ).toBeVisible();

    // Inline compact plan card
    const planCard = page.locator(".task-plan-card").last();
    await expect(planCard).toBeVisible();
    await expect(planCard.getByText("50 USDC")).toBeVisible();
    await expect(planCard.getByText("$0.05")).toBeVisible();
    await expect(
      planCard.getByText("Final payment requires approval"),
    ).toBeVisible();
  });

  test("4. service card shows $0.003 with a $0.047 budget-after-purchase preview", async ({
    page,
  }) => {
    const liveRegistry = createLiveServiceRegistry("available");
    await page.route("**/api/services", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(serializeServiceRegistry(liveRegistry)),
      });
    });

    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const input = page.getByRole("textbox", { name: "Your financial task" });
    await input.fill(
      "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
    );
    await page.getByRole("button", { name: "Submit task" }).click();
    await input.fill("0x1234567890abcdef");
    await page.getByRole("button", { name: "Submit task" }).click();

    await expect(
      page.getByText("validated task plan", { exact: true }),
    ).toBeVisible();
    const discoveryCard = page.locator(".service-discovery-card");
    await expect(discoveryCard).toBeVisible();
    await expect(discoveryCard.getByText("$0.003").first()).toBeVisible();
    await expect(discoveryCard.getByText("$0.047").first()).toBeVisible();
    await expect(
      discoveryCard.getByText("BUDGET AFTER PURCHASE", { exact: true }),
    ).toBeVisible();
  });

  test("5. no payment action appears before required wallet check is executed", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const input = page.getByRole("textbox", { name: "Your financial task" });
    await input.fill(
      "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
    );
    await page.getByRole("button", { name: "Submit task" }).click();

    // No approve & pay button should be present
    await expect(
      page.getByRole("heading", { name: "approval needed" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Approve & pay/ })).toHaveCount(
      0,
    );
  });

  test("6. wallet observations render truthfully with separated heuristic flags", async ({
    page,
  }) => {
    const taskId = "p7-truthful-observations";
    const policy = makePolicy(taskId);
    const draft = makeTask(taskId, policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const purchase = makePaidPurchase(taskId, policy);
    const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
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
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Truthful observation pills
    const resultCard = page.locator(".service-result-card");
    await expect(resultCard).toBeVisible();
    await expect(resultCard.getByText("Valid address")).toBeVisible();
    await expect(resultCard.getByText("EOA")).toBeVisible();
    await expect(resultCard.getByText("18 transactions observed")).toBeVisible();
    await expect(resultCard.getByText("Activity observed")).toBeVisible();

    // Heuristic observations visibly separated and not labeled fraud/risk
    await expect(
      page.getByText("HEURISTIC OBSERVATIONS (NON-FACTUAL SIGNALS)"),
    ).toBeVisible();
    await expect(page.getByText("known_active_wallet")).toBeVisible();

    // Footer stats
    await expect(page.getByText("Paid $0.003 via Hedera")).toBeVisible();
    await expect(
      page.getByText("$0.047 service budget remaining"),
    ).toBeVisible();
  });

  test("6b. paid service state shows remaining $0.047 with no before-purchase wording", async ({
    page,
  }) => {
    const taskId = "p7-paid-budget-copy";
    const policy = makePolicy(taskId);
    const draft = makeTask(taskId, policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const purchase = makePaidPurchase(taskId, policy);
    const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
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
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    const budgetCard = page.locator(".bounded-budget-card");
    await expect(budgetCard).toBeVisible();
    await expect(budgetCard.getByText("budget:").first()).toBeVisible();
    await expect(budgetCard.getByText("$0.05").first()).toBeVisible();
    await expect(budgetCard.getByText("spent:").first()).toBeVisible();
    await expect(budgetCard.getByText("$0.003").first()).toBeVisible();
    await expect(budgetCard.getByText("remaining", { exact: true })).toBeVisible();
    await expect(budgetCard.getByText("$0.047").first()).toBeVisible();
    await expect(
      budgetCard.getByText("Observed 1 service interaction(s)."),
    ).toBeVisible();
    await expect(page.getByText("remaining before purchase")).toHaveCount(0);
  });

  test("7. approval appears inline only after paid wallet check", async ({
    page,
  }) => {
    const taskId = "p7-approval-boundary";
    const policy = makePolicy(taskId);
    const draft = makeTask(taskId, policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const purchase = makePaidPurchase(taskId, policy);
    const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
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
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Inline approval card is now visible
    const approvalCard = page.locator(".final-payment-card");
    await expect(approvalCard).toBeVisible();
    await expect(
      approvalCard.getByRole("heading", { name: "approval needed" }),
    ).toBeVisible();
    await expect(approvalCard.getByText("50 USDC")).toBeVisible();
    await expect(
      approvalCard.getByText("Arc Testnet", { exact: true }).first(),
    ).toBeVisible();
    await expect(approvalCard.getByText("completed")).toBeVisible();
    await expect(
      approvalCard.getByRole("button", { name: "Review payment" }),
    ).toBeVisible();
  });

  test("8. no transaction occurs before explicit approval", async ({
    page,
  }) => {
    const taskId = "p7-no-tx-before-approval";
    const policy = makePolicy(taskId);
    const draft = makeTask(taskId, policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const purchase = makePaidPurchase(taskId, policy);
    const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
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

    const outgoingFinalSettlementCalls: string[] = [];
    await page.route("**/api/tasks/final-settlement", async (route) => {
      const data = route.request().postDataJSON() as { action?: string };
      outgoingFinalSettlementCalls.push(data?.action ?? "unknown");
      await route.continue();
    });

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
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Truth banner explicitly states funds have not moved
    await expect(page.locator(".final-payment-truth")).toContainText(
      "Payment not sent.",
    );

    // Only "prepare" may be called for preflight; "approve" or "submit" must not be called
    expect(
      outgoingFinalSettlementCalls.filter(
        (a) => a === "approve" || a === "submit",
      ),
    ).toEqual([]);
  });

  test("9. submitted transaction removes duplicate pay action", async ({
    page,
  }) => {
    const taskId = "p7-submitted-dedup";
    const policy = makePolicy(taskId);
    const task = makeTask(taskId, policy);
    const purchase = makePaidPurchase(taskId, policy);
    const registry = createLiveServiceRegistry("available");
    const txHash =
      "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";

    const approval = makeApproval(taskId, policy, task);
    const settlement = makeSubmittedSettlement(task, policy, approval, txHash);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        messages: [],
        task: { ...task, status: "settling" },
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        discovery: {
          requiredCapability: "wallet-activity",
          selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
          discoveredAt: NOW,
          registryVersion: registry.version,
        },
      },
      registry,
    );

    await page.goto("/app?testMode=true");
    await page.evaluate(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
        localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Pay buttons must not be present for submitted transaction
    await expect(
      page.getByRole("button", { name: /Approve & pay/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "settling payment" }),
    ).toBeVisible();

    // Explorer link is immediately shown
    await expect(
      page.getByRole("link", { name: "view on ArcScan" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "view on ArcScan" }),
    ).toHaveAttribute("href", new RegExp(txHash));
  });

  test("10. refresh rehydrates conversation and financial state accurately", async ({
    page,
  }) => {
    const taskId = "p7-refresh-rehydrate";
    const policy = makePolicy(taskId);
    const task = makeTask(taskId, policy);
    const purchase = makePaidPurchase(taskId, policy);
    const registry = createLiveServiceRegistry("available");

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        messages: [
          {
            id: "msg-user-1",
            role: "user",
            kind: "message",
            content: "Pay this contractor 50 USDC, but check the wallet first.",
            createdAt: NOW,
          },
          {
            id: "msg-omnis-1",
            role: "omnis",
            kind: "message",
            content: "Wallet check complete.",
            createdAt: NOW,
          },
        ],
        task: { ...task, status: "awaiting_approval" },
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
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Conversation turns preserved
    await expect(
      page.getByText(
        "Pay this contractor 50 USDC, but check the wallet first.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Wallet check complete.")).toBeVisible();

    // Financial cards preserved
    await expect(page.locator(".service-result-card")).toBeVisible();
    await expect(page.locator(".final-payment-card")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "approval needed" }),
    ).toBeVisible();
  });

  test("11. test mode clearly distinguishes 50 USDC requested vs 0.01 USDC executed", async ({
    page,
  }) => {
    const taskId = "p7-testmode-distinction";
    const policy = makePolicy(taskId);
    const draft = makeTask(taskId, policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const purchase = makePaidPurchase(taskId, policy);
    const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
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

    await page.goto("/app?testMode=true");
    await page.evaluate(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
        localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Click Review payment to expand high-risk confirmation
    await page.getByRole("button", { name: "Review payment" }).click();

    // Check unmistakable test mode visual contrast
    const testBanner = page.locator(".conversational-test-mode-banner");
    await expect(testBanner).toBeVisible();
    await expect(testBanner.getByText("ORIGINAL MANDATE")).toBeVisible();
    await expect(testBanner.getByText("50 USDC")).toBeVisible();
    await expect(testBanner.getByText("NOT EXECUTED")).toBeVisible();

    await expect(testBanner.getByText("TEST SETTLEMENT")).toBeVisible();
    await expect(
      testBanner.getByText("0.01 USDC", { exact: true }),
    ).toBeVisible();
    await expect(
      testBanner.getByText("Arc Testnet", { exact: true }),
    ).toBeVisible();

    // Action button makes the 0.01 test cap explicit
    await expect(
      page.getByRole("button", {
        name: "Approve & pay 0.01 USDC (TEST MODE)",
      }),
    ).toBeVisible();
  });

  test("12. demo verified state contains no contradictory 'waiting' label", async ({
    page,
  }) => {
    const taskId = "p7-demo-verified-clean";
    const policy = makePolicy(taskId);
    const task = makeTask(taskId, policy);
    const purchase = makePaidPurchase(taskId, policy);
    const registry = createLiveServiceRegistry("available");
    const txHash =
      "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";

    const approval = makeApproval(taskId, policy, task);
    const settlement = makeConfirmedSettlement(task, policy, approval, txHash);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        messages: [],
        task: { ...task, status: "completed" },
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        proof: {
          id: `proof-${taskId}`,
          idempotencyKey: `idemp-${taskId}`,
          taskId,
          ownerId: USER_ALICE_DID,
          createdAt: NOW,
          intent: task.originalIntent,
          task,
          policy,
          servicePurchases: [purchase],
          totalServiceSpend: money("0.003", "USD"),
          finalPayment: settlement,
          approval,
          status: "demo_verified",
          testMode: true,
          demoVerificationStatus: "complete",
          originalPaymentDelivered: false,
        },
        discovery: {
          requiredCapability: "wallet-activity",
          selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
          discoveredAt: NOW,
          registryVersion: registry.version,
        },
      },
      registry,
    );

    await page.goto("/app?testMode=true");
    await page.evaluate(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
        localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    const verifiedCard = page.locator(".demo-verified-card");
    await expect(verifiedCard).toBeVisible();
    await expect(verifiedCard.getByText("DEMO VERIFICATION", { exact: true })).toBeVisible();
    await expect(verifiedCard.getByText("PASSED")).toBeVisible();
    await expect(verifiedCard.getByText("0.01 USDC confirmed")).toBeVisible();
    await expect(verifiedCard.getByText("50 USDC")).toBeVisible();
    await expect(verifiedCard.getByText("NOT EXECUTED")).toBeVisible();

    // MUST NOT have any contradictory "waiting" label
    await expect(verifiedCard.getByText(/waiting/i)).toHaveCount(0);

    // Has link to proof bundle
    await expect(
      verifiedCard.getByRole("link", { name: "View proof" }),
    ).toBeVisible();
  });

  test("13. compact proof summary links to full technical evidence", async ({
    page,
  }) => {
    const taskId = "p7-proof-summary-link";
    const policy = makePolicy(taskId);
    const task = makeTask(taskId, policy);
    const purchase = makePaidPurchase(taskId, policy);
    const registry = createLiveServiceRegistry("available");
    const txHash =
      "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";

    const approval = makeApproval(taskId, policy, task);
    const settlement = makeConfirmedSettlement(task, policy, approval, txHash);

    const sessionData = serializeDraftSession(
      {
        version: 5,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        messages: [],
        task: { ...task, status: "completed" },
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        proof: {
          id: `proof-${taskId}`,
          idempotencyKey: `idemp-${taskId}`,
          taskId,
          ownerId: USER_ALICE_DID,
          createdAt: NOW,
          intent: task.originalIntent,
          task,
          policy,
          servicePurchases: [purchase],
          totalServiceSpend: money("0.003", "USD"),
          finalPayment: settlement,
          approval,
          status: "demo_verified",
          testMode: true,
          demoVerificationStatus: "complete",
          originalPaymentDelivered: false,
        },
        discovery: {
          requiredCapability: "wallet-activity",
          selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
          discoveredAt: NOW,
          registryVersion: registry.version,
        },
      },
      registry,
    );

    await page.goto("/app?testMode=true");
    await page.evaluate(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        localStorage.setItem(authKey, JSON.stringify(authVal));
        localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: USER_ALICE_DID,
          walletAddress: USER_ALICE_WALLET,
        },
        sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
        sessionVal: sessionData,
      },
    );
    await page.reload();

    // Click View proof from the card
    await page.getByRole("link", { name: "View proof" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/proof/${taskId}`));

    // Compact proof summary appears at top
    const summaryCard = page.locator(".proof-summary-card");
    await expect(summaryCard).toBeVisible();
    await expect(summaryCard.getByText("MANDATE", { exact: true })).toBeVisible();
    await expect(summaryCard.getByText("MACHINE SERVICE", { exact: true })).toBeVisible();
    await expect(summaryCard.getByText("HUMAN CONTROL", { exact: true })).toBeVisible();
    await expect(summaryCard.getByText("TEST SETTLEMENT", { exact: true })).toBeVisible();
    await expect(summaryCard.getByText("ORIGINAL PAYMENT", { exact: true })).toBeVisible();
    await expect(summaryCard.getByText("DEMO VERIFICATION", { exact: true })).toBeVisible();

    // Toggle Technical evidence expands the forensic view
    const toggleBtn = page.getByRole("button", { name: "Technical evidence" });
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
    await expect(
      page.getByRole("heading", { name: "Approval Record" }),
    ).toBeVisible();
  });

  test("14. mobile viewport remains usable without squeezed tables or broken composer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Headline wraps properly without overflow
    const headline = page.getByRole("heading", {
      name: "What needs to get done?",
    });
    await expect(headline).toBeVisible();

    // Sticky composer stays anchored
    const stickyComposer = page.locator(".conversational-sticky-composer");
    await expect(stickyComposer).toBeVisible();

    // Textarea is reachable
    const input = page.getByRole("textbox", { name: "Your financial task" });
    await expect(input).toBeVisible();
    await input.fill("Pay contractor 50 USDC");

    const submitBtn = page.getByRole("button", { name: "Submit task" });
    await expect(submitBtn).toBeVisible();
    const box = await submitBtn.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(40);
  });

  test("15. keyboard composer works with Enter to send and Shift+Enter for newline", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const input = page.getByRole("textbox", { name: "Your financial task" });
    await input.focus();
    await input.fill("First line");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("Second line");

    const val = await input.inputValue();
    expect(val).toContain("\n");

    // Press plain Enter to submit
    await page.keyboard.press("Enter");

    // Message is submitted and displayed
    await expect(page.locator(".user-bubble")).toContainText("First line");
    await expect(page.locator(".user-bubble")).toContainText("Second line");
  });
});
