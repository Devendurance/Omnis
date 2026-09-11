import { expect, test, type Page } from "@playwright/test";
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

const NOW = "2026-09-11T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-proof-copy";
const USER_ALICE_WALLET = "0x2222222222222222222222222222222222222222";
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
      paymentIdentifier: "0.0.7162784@1788995118.130839662",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: {
          wallet: CONTRACTOR_WALLET,
          transactionCount: "5",
          activityObserved: true,
        },
        heuristicFlags: [{ code: "known_active_wallet", severity: "info" }],
        disclaimer: "Factual observation result.",
        requestId: `req-${taskId}`,
      },
    },
    NOW,
  );
}

function makeApproval(taskId: string, policy: TaskPolicy, task: FinancialTask, testMode: boolean): ApprovalRecord {
  return createApprovalRecord({
    id: `appr-${taskId}`,
    taskId,
    settlementExecutionId: `settle-${taskId}`,
    approverId: USER_ALICE_DID,
    walletAddress: USER_ALICE_WALLET,
    amount: testMode ? P6B_TEST_MODE_AMOUNT : money("50", "USDC"),
    requestedAmount: task.paymentAmount!,
    executionAmount: testMode ? P6B_TEST_MODE_AMOUNT : money("50", "USDC"),
    asset: "USDC",
    recipient: CONTRACTOR_WALLET,
    network: "Arc Testnet",
    policySnapshot: policy,
    testMode,
    approvedAt: NOW,
  });
}

function makeConfirmedSettlement(
  task: FinancialTask,
  policy: TaskPolicy,
  approval: ApprovalRecord,
  testMode: boolean,
): SettlementExecution {
  const amount = testMode ? P6B_TEST_MODE_AMOUNT : money("50", "USDC");
  const prepared = createSettlementExecution({
    id: `settle-${task.id}`,
    taskId: task.id,
    provider: "circle",
    amount,
    requestedAmount: task.paymentAmount!,
    executionAmount: amount,
    testMode,
    recipient: CONTRACTOR_WALLET,
    network: "Arc Testnet",
    approvalRequired: true,
    policySnapshot: policy,
  });
  const awaiting = transitionSettlement(prepared, "awaiting_approval", { now: NOW });
  const submitting = transitionSettlement(awaiting, "submitting", { approval, now: NOW });
  const submitted = transitionSettlement(submitting, "submitted", {
    transactionHash: LIVE_TX_HASH,
    now: NOW,
  });
  const confirming = transitionSettlement(submitted, "confirming", { now: NOW });
  return transitionSettlement(confirming, "confirmed", {
    confirmation: {
      source: "reconciliation",
      transactionHash: LIVE_TX_HASH,
      outcome: "confirmed",
      observedAt: NOW,
    },
    now: NOW,
  });
}

async function seedProofPage(
  page: Page,
  taskId: string,
  testMode: boolean,
): Promise<string> {
  const policy = makePolicy(taskId);
  const draft = makeTask(taskId, policy);
  const purchase = makePaidPurchase(taskId, policy);
  const registry = createLiveServiceRegistry("available");
  const running = transitionTask(transitionTask(draft, "planned"), "running");
  const awaiting = transitionTask(running, "awaiting_approval", {
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
  const tempApproval = createApprovalRecord({
    id: `approval-${taskId}-temp`,
    taskId,
    settlementExecutionId: `settlement-${taskId}-temp`,
    approverId: USER_ALICE_DID,
    walletAddress: USER_ALICE_WALLET,
    amount: money("50", "USDC"),
    asset: "USDC",
    recipient: CONTRACTOR_WALLET,
    network: "Arc Testnet",
    policySnapshot: policy,
    approvedAt: NOW,
  });
  const settling = transitionTask(awaiting, "settling", {
    approval: tempApproval,
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
  const approval = makeApproval(taskId, policy, draft, testMode);
  const settlement = makeConfirmedSettlement(draft, policy, approval, testMode);
  const completedTask = transitionTask(settling, "completed", {
    settlement,
    now: NOW,
  });
  const sessionData = serializeDraftSession(
    {
      version: 5,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: completedTask,
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
        intent: draft.originalIntent,
        task: completedTask,
        policy,
        servicePurchases: [purchase],
        totalServiceSpend: money("0.003", "USD"),
        finalPayment: settlement,
        approval,
        status: testMode ? "demo_verified" : "completed",
        ...(testMode
          ? {
              testMode: true,
              demoVerificationStatus: "complete",
              originalPaymentDelivered: false,
            }
          : {}),
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
  return taskId;
}

test.describe("P8A proof copy truthfulness", () => {
  test("test-mode proof never claims the mandate completed", async ({ page }) => {
    await seedProofPage(page, "p8a-testmode-proof", true);
    await page.goto("/app/proof/p8a-testmode-proof");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toContainText("demo verified. proof is ready.");
    await expect(page.locator("h1")).not.toContainText("task complete. proof is ready.");
  });

  test("genuine proof keeps the task-complete language", async ({ page }) => {
    await seedProofPage(page, "p8a-genuine-proof", false);
    await page.goto("/app/proof/p8a-genuine-proof");
    await expect(page.locator("h1")).toContainText("task complete. proof is ready.");
  });
});
