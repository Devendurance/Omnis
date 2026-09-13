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

// Correction and locking contract. A task stays conversationally
// correctable only while replacement is safe: planned or awaiting approval
// with no paid purchase, no approval record, and no settlement. Everything
// past that boundary locks the composer under existing P9A safety rules.

const NOW = "2026-09-11T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-p1";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACTOR_WALLET = "0xC446221191062923984729104820174029466Dc9";
const SMOKE_RECIPIENT = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";

function makePolicy(taskId: string) {
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

function makeTask(taskId: string, policy = makePolicy(taskId)) {
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

function makePaidPurchase(taskId: string, policy = makePolicy(taskId)) {
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

function makeApproval(taskId: string, policy = makePolicy(taskId)) {
  const task = makeTask(taskId, policy);
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

function makeSubmittedSettlement(taskId: string) {
  const policy = makePolicy(taskId);
  const task = makeTask(taskId, policy);
  const approval = makeApproval(taskId, policy);
  const prepared = createSettlementExecution({
    id: `settle-${taskId}`,
    taskId,
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
  const submitted = transitionSettlement(submitting, "submitted", {
    transactionHash:
      "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d",
    now: NOW,
  });
  return { policy, task, approval, settlement: submitted };
}

function makeConfirmedSettlement(taskId: string) {
  const built = makeSubmittedSettlement(taskId);
  const txHash =
    "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";
  const confirming = transitionSettlement(built.settlement, "confirming", {
    now: NOW,
  });
  const confirmed = transitionSettlement(confirming, "confirmed", {
    confirmation: {
      source: "reconciliation",
      transactionHash: txHash,
      outcome: "confirmed",
      observedAt: NOW,
    },
    now: NOW,
  });
  return { ...built, settlement: confirmed };
}

async function seedAndOpen(
  page: Page,
  session: Parameters<typeof serializeDraftSession>[0],
): Promise<void> {
  const registry = createLiveServiceRegistry("available");
  const sessionData = serializeDraftSession(session, registry);
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
}

test("planned unpaid unapproved task keeps the composer enabled", async ({
  page,
}) => {
  const taskId = "p1-correctable-planned";
  const policy = makePolicy(taskId);
  const planned = transitionTask(makeTask(taskId, policy), "planned", {
    now: NOW,
  });
  await seedAndOpen(page, {
    version: 5,
    ownerSubject: USER_ALICE_DID,
    ownerWalletAddress: USER_ALICE_WALLET,
    messages: [],
    task: planned,
    policy,
  });
  await expect(page.locator(".mandate-status-pill").getByText("planned")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Your financial task" }),
  ).toBeEnabled();
});

test("amount correction replans safely before approval", async ({ page }) => {
  await page.goto("/app");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const input = page.getByRole("textbox", { name: "Your financial task" });
  const submit = page.getByRole("button", { name: "Submit task" });
  await input.fill(
    "Before you pay Alex 0.10 USDC, make sure this wallet has actually been used. " +
      "You can spend up to five cents checking it, but ask me before you send anything. " +
      "His wallet is " +
      SMOKE_RECIPIENT +
      ".",
  );
  await submit.click();
  await expect(page.getByText("validated task plan", { exact: true })).toBeVisible();
  const planCard = page.locator(".task-plan-card").last();
  await expect(planCard.getByText("0.1 USDC")).toBeVisible();

  await input.fill("Actually make that 0.20.");
  await submit.click();
  await expect(page.locator(".task-plan-card").last().getByText("0.2 USDC")).toBeVisible();
  await expect(input).toBeEnabled();
  const mainText = await page.getByRole("main").innerText();
  expect(mainText).not.toMatch(
    /service purchased|payment submitted|settled|transaction confirmed|proof is ready/i,
  );
});

test("approval record blocks correction", async ({ page }) => {
  const taskId = "p1-locked-approved";
  const policy = makePolicy(taskId);
  const purchase = makePaidPurchase(taskId, policy);
  await seedAndOpen(page, {
    version: 5,
    ownerSubject: USER_ALICE_DID,
    ownerWalletAddress: USER_ALICE_WALLET,
    messages: [],
    task: { ...makeTask(taskId, policy), status: "awaiting_approval" },
    policy,
    servicePurchases: [purchase],
    approval: makeApproval(taskId, policy),
  });
  await expect(
    page.locator(".mandate-status-pill").getByText("awaiting approval"),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Your financial task" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Submit task" }),
  ).toBeDisabled();
});

test("submitted settlement blocks correction", async ({ page }) => {
  const taskId = "p1-locked-settling";
  const built = makeSubmittedSettlement(taskId);
  await seedAndOpen(page, {
    version: 5,
    ownerSubject: USER_ALICE_DID,
    ownerWalletAddress: USER_ALICE_WALLET,
    messages: [],
    task: { ...built.task, status: "settling" },
    policy: built.policy,
    servicePurchases: [makePaidPurchase(taskId, built.policy)],
    approval: built.approval,
    settlement: built.settlement,
  });
  await expect(
    page.locator(".mandate-status-pill").getByText("settling"),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Your financial task" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Submit task" }),
  ).toBeDisabled();
});

test("completed task blocks correction", async ({ page }) => {
  const taskId = "p1-locked-completed";
  const built = makeConfirmedSettlement(taskId);
  await seedAndOpen(page, {
    version: 5,
    ownerSubject: USER_ALICE_DID,
    ownerWalletAddress: USER_ALICE_WALLET,
    messages: [],
    task: { ...built.task, status: "completed" },
    policy: built.policy,
    servicePurchases: [makePaidPurchase(taskId, built.policy)],
    approval: built.approval,
    settlement: built.settlement,
  });
  await expect(
    page.locator(".mandate-status-pill").getByText("completed"),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Your financial task" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Submit task" }),
  ).toBeDisabled();
});
