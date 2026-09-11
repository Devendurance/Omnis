import { expect, test } from "@playwright/test";
import path from "node:path";
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
import { createLiveServiceRegistry } from "../src/lib/services/registry";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";

const NOW = "2026-09-11T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-screenshots";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACTOR_WALLET = "0xC446221191062923984729104820174029466Dc9";
const LIVE_TX_HASH =
  "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";

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

test.describe("P7 Required Screenshots Capture", () => {
  test("1. desktop empty state screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await expect(page.locator(".conversational-empty-state")).toBeVisible();
    await page.screenshot({
      path: path.join(process.cwd(), "screenshots", "desktop-empty-state.png"),
      fullPage: false,
    });
  });

  test("2. desktop flagship after wallet check screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const taskId = "p7-shot-wallet-check";
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
        messages: [
          {
            id: "msg-1",
            role: "user",
            kind: "message",
            content:
              "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
            createdAt: NOW,
          },
          {
            id: "msg-2",
            role: "omnis",
            kind: "message",
            content: "Wallet check complete.",
            createdAt: NOW,
          },
          {
            id: "msg-3",
            role: "omnis",
            kind: "message",
            content:
              "I'm ready to prepare the contractor payment. No contractor funds have moved yet.",
            createdAt: NOW,
          },
        ],
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

    const resultCard = page.locator(".service-result-card");
    await expect(resultCard).toBeVisible();
    await expect(resultCard.getByText("Valid address")).toBeVisible();
    await expect(resultCard.getByText("EOA")).toBeVisible();
    await expect(resultCard.getByText("18 transactions observed")).toBeVisible();
    await expect(resultCard.getByText("Activity observed")).toBeVisible();
    await expect(resultCard.getByText(/Paid .* via/)).toBeVisible();

    // Context-preserving full-page capture: conversation turns plus the inline
    // service result and approval cards, with the sticky composer hidden so it
    // cannot occlude the evidence. Restore in finally so a failed capture
    // cannot leak test state.
    await page.evaluate(() => {
      const composer = document.querySelector(".conversational-sticky-composer");
      if (composer) (composer as HTMLElement).style.display = "none";
    });
    try {
      await page.screenshot({
        path: path.join(
          process.cwd(),
          "screenshots",
          "desktop-flagship-after-wallet-check.png",
        ),
        fullPage: true,
      });
    } finally {
      await page.evaluate(() => {
        const composer = document.querySelector(".conversational-sticky-composer");
        if (composer) (composer as HTMLElement).style.display = "";
      });
    }
  });


  test("3. desktop approval state screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const taskId = "p7-shot-approval";
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
        messages: [
          {
            id: "msg-1",
            role: "user",
            kind: "message",
            content:
              "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
            createdAt: NOW,
          },
          {
            id: "msg-2",
            role: "omnis",
            kind: "message",
            content: "Wallet check complete.",
            createdAt: NOW,
          },
          {
            id: "msg-3",
            role: "omnis",
            kind: "message",
            content:
              "I'm ready to prepare the contractor payment. No contractor funds have moved yet.",
            createdAt: NOW,
          },
        ],
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

    const approvalCard = page.locator(".final-payment-card");
    await expect(approvalCard).toBeVisible();
    await approvalCard.getByRole("button", { name: "Review payment" }).click();
    await expect(approvalCard.locator(".conversational-test-mode-banner")).toBeVisible();
    await expect(
      approvalCard.getByRole("button", {
        name: "Approve & pay 0.01 USDC (TEST MODE)",
      }),
    ).toBeVisible();
    // Hide the sticky composer/lock so the approval controls are unoccluded;
    // restore in finally so a failed capture cannot leak state.
    await page.evaluate(() => {
      const composer = document.querySelector(".conversational-sticky-composer");
      if (composer) (composer as HTMLElement).style.display = "none";
    });
    try {
      await approvalCard.scrollIntoViewIfNeeded();
      await approvalCard.screenshot({
        path: path.join(
          process.cwd(),
          "screenshots",
          "desktop-approval-state.png",
        ),
      });
    } finally {
      await page.evaluate(() => {
        const composer = document.querySelector(".conversational-sticky-composer");
        if (composer) (composer as HTMLElement).style.display = "";
      });
    }
  });

  test("4. mobile conversation screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const taskId = "p7-shot-mobile";
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
        messages: [
          {
            id: "msg-1",
            role: "user",
            kind: "message",
            content:
              "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
            createdAt: NOW,
          },
          {
            id: "msg-2",
            role: "omnis",
            kind: "message",
            content:
              "I can do that. I'll check the wallet before preparing the payment.",
            createdAt: NOW,
          },
        ],
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

    await expect(page.locator(".conversational-canvas")).toBeVisible();
    await page.screenshot({
      path: path.join(
        process.cwd(),
        "screenshots",
        "mobile-conversation.png",
      ),
      fullPage: false,
    });
  });

  test("5. demo verified state screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const taskId = "p7-shot-demo-verified";
    const policy = makePolicy(taskId);
    const task = makeTask(taskId, policy);
    const purchase = makePaidPurchase(taskId, policy);
    const registry = createLiveServiceRegistry("available");

    const approval = makeApproval(taskId, policy, task);
    const settlement = makeConfirmedSettlement(
      task,
      policy,
      approval,
      LIVE_TX_HASH,
    );

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
    await verifiedCard.scrollIntoViewIfNeeded();
    await expect(verifiedCard.getByText("DEMO VERIFICATION", { exact: true })).toBeVisible();
    await expect(verifiedCard.getByText("PASSED")).toBeVisible();
    await expect(verifiedCard.getByText("0.01 USDC confirmed")).toBeVisible();
    await expect(verifiedCard.getByText("NOT EXECUTED")).toBeVisible();
    await verifiedCard.screenshot({
      path: path.join(
        process.cwd(),
        "screenshots",
        "demo-verified-state.png",
      ),
    });
  });
});
