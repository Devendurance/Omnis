import { expect, test, type Page } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  finalizeProof,
  money,
  transitionTask,
  type SettlementExecution,
} from "../src/lib/domain";
import {
  createLiveServiceRegistry,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
  WALLET_ACTIVITY_QUOTE,
} from "../src/lib/services/wallet-activity-descriptor";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";
import {
  getTaskSessionStorageKey,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";
import {
  TASK_SESSION_VERSION,
  type TaskSession,
} from "../src/lib/tasks/session";
import {
  getTaskArchiveStorageKey,
} from "../src/lib/tasks/archive";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T13:00:00.000Z";
const OWNER_A = "did:privy:owner-a-p9a7-browser";
const OWNER_B = "did:privy:owner-b-p9a7-browser";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const CONTRACTOR = "0x3333333333333333333333333333333333333333";

const REGISTRY = createLiveServiceRegistry("available");

function buildCompletedSession(taskId: string, summary: string): TaskSession {
  const policy = createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
  const draft = createFinancialTask(
    {
      id: taskId,
      ownerId: OWNER_A,
      ownerSubject: OWNER_A,
      ownerWalletAddress: WALLET_A,
      type: "pay_with_check",
      originalIntent: summary,
      recipient: CONTRACTOR,
      paymentAmount: money("0.10", "USDC"),
      purpose: `contractor ${taskId}`,
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const planned = transitionTask(draft, "planned", { now: NOW });
  const running = beginTaskExecution(planned, policy, NOW);
  const purchase = createServicePurchase(
    {
      id: `purchase-${taskId}`,
      taskId,
      serviceId: WALLET_ACTIVITY_SERVICE_ID,
      quotedAmount: WALLET_ACTIVITY_QUOTE,
      paymentAmount: WALLET_ACTIVITY_PRICE,
      paidAmount: WALLET_ACTIVITY_QUOTE,
      policySnapshot: policy,
      status: "paid",
      requestId: `request-${taskId}`,
      paymentIdentifier: "0.0.7162784@1788908433.043020353",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: { wallet: CONTRACTOR, activityObserved: true },
        heuristicFlags: [],
        disclaimer: "Factual observation result.",
        requestId: `request-${taskId}`,
      },
    },
    NOW,
  );
  const awaiting = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);
  const settlement: SettlementExecution = {
    id: `settlement-${taskId}`,
    taskId,
    provider: "circle_arc",
    amount: money("0.10", "USDC"),
    recipient: CONTRACTOR,
    network: "Arc Testnet",
    approvalRequired: true,
    policySnapshot: policy,
    status: "confirmed",
    transactionHash: "0xp9a7-browser-proof",
    confirmationEvidence: {
      source: "reconciliation",
      transactionHash: "0xp9a7-browser-proof",
      outcome: "confirmed",
      observedAt: LATER,
    },
    createdAt: NOW,
    updatedAt: LATER,
  };
  const approval = createApprovalRecord({
    id: `approval-${taskId}`,
    taskId,
    settlementExecutionId: settlement.id,
    approverId: OWNER_A,
    walletAddress: WALLET_A,
    amount: settlement.amount,
    asset: "USDC",
    recipient: CONTRACTOR,
    network: "Arc Testnet",
    policySnapshot: policy,
    approvedAt: NOW,
  });
  const settling = transitionTask(awaiting, "settling", {
    approval,
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
  const completed = transitionTask(settling, "completed", {
    approval,
    settlement,
    now: LATER,
  });
  const proof = finalizeProof({
    task: completed,
    policy,
    servicePurchases: [purchase],
    settlement,
    approval,
    intent: { original: summary },
    recordedAt: LATER,
  });
  return {
    version: TASK_SESSION_VERSION,
    ownerSubject: OWNER_A,
    ownerWalletAddress: WALLET_A,
    messages: [
      {
        id: `msg-${taskId}`,
        role: "user",
        kind: "message",
        content: summary,
        createdAt: NOW,
      },
    ],
    task: completed,
    policy,
    servicePurchases: [purchase],
    approval,
    settlement,
    proof,
  };
}

function buildDraftSession(taskId: string, summary: string): TaskSession {
  const policy = createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
  const task = createFinancialTask(
    {
      id: taskId,
      ownerId: OWNER_A,
      ownerSubject: OWNER_A,
      ownerWalletAddress: WALLET_A,
      type: "pay",
      originalIntent: summary,
      recipient: CONTRACTOR,
      paymentAmount: money("0.10", "USDC"),
      purpose: `contractor ${taskId}`,
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    LATER,
  );
  return {
    version: TASK_SESSION_VERSION,
    ownerSubject: OWNER_A,
    ownerWalletAddress: WALLET_A,
    messages: [
      {
        id: `msg-${taskId}`,
        role: "user",
        kind: "message",
        content: summary,
        createdAt: LATER,
      },
    ],
    task,
    policy,
  };
}

async function seedOwnerHistory(page: Page): Promise<void> {
  const archived = serializeDraftSession(
    buildCompletedSession("task-archived", "Pay contractor task-archived 0.1 USDC"),
    REGISTRY,
  );
  const active = serializeDraftSession(
    buildDraftSession("task-active", "Pay contractor task-active 0.1 USDC"),
    REGISTRY,
  );
  await page.addInitScript(
    ({ authKey, authVal, sessionKey, sessionVal, archiveKey, archiveVal }) => {
      if (window.localStorage.getItem(authKey)) return;
      window.localStorage.setItem(authKey, JSON.stringify(authVal));
      window.localStorage.setItem(sessionKey, sessionVal);
      window.localStorage.setItem(archiveKey, archiveVal);
    },
    {
      authKey: MOCK_AUTH_STORAGE_KEY,
      authVal: {
        authenticated: true,
        subject: OWNER_A,
        walletAddress: WALLET_A,
      },
      sessionKey: getTaskSessionStorageKey(OWNER_A),
      sessionVal: active,
      archiveKey: getTaskArchiveStorageKey(OWNER_A) as string,
      archiveVal: JSON.stringify([archived]),
    },
  );
}

test.describe("P9A.7 connected record pages", () => {
  test("tasks page lists real history with working filters and search", async ({
    page,
  }) => {
    await seedOwnerHistory(page);
    await page.goto("/app/tasks");

    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect(page.getByText("Pay contractor task-archived 0.1 USDC")).toBeVisible();
    await expect(page.getByText("Pay contractor task-active 0.1 USDC")).toBeVisible();
    await expect(page.getByText("not connected in this preview")).toHaveCount(0);

    await page.getByRole("button", { name: "delegate" }).click();
    await expect(page.getByText("No matching tasks.")).toBeVisible();
    await page.getByRole("button", { name: "pay", exact: true }).click();
    await expect(page.getByText("Pay contractor task-archived 0.1 USDC")).toBeVisible();

    const search = page.getByPlaceholder("search tasks...");
    await search.fill("task-active");
    await expect(page.getByText("Pay contractor task-archived 0.1 USDC")).toHaveCount(0);
    await expect(page.getByText("Pay contractor task-active 0.1 USDC")).toBeVisible();
  });

  test("clicking a task reopens its readable history", async ({ page }) => {
    await seedOwnerHistory(page);
    await page.goto("/app/tasks");
    await page.getByRole("link", { name: "Pay contractor task-archived 0.1 USDC" }).click();

    await expect(page.getByText("historical record, read only")).toBeVisible();
    await expect(page.getByText("Pay contractor task-archived 0.1 USDC").first()).toBeVisible();
    await expect(page.getByText("the conversation")).toBeVisible();
    await expect(page.getByText("the policy snapshot")).toBeVisible();
    await expect(page.getByRole("link", { name: /view proof bundle/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /back to current task/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
  });

  test("activity page derives only real events with working filters", async ({
    page,
  }) => {
    await seedOwnerHistory(page);
    await page.goto("/app/activity");

    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(page.getByText("service purchase confirmed").first()).toBeVisible();
    await expect(page.getByText("approval granted").first()).toBeVisible();
    await expect(page.getByText("settlement submitted").first()).toBeVisible();
    await expect(page.getByText("settlement confirmed").first()).toBeVisible();
    await expect(page.getByText("task completed").first()).toBeVisible();
    await expect(page.getByText("not connected in this preview")).toHaveCount(0);

    await page.getByRole("button", { name: "approvals" }).click();
    await expect(page.getByText("approval granted").first()).toBeVisible();
    await expect(page.getByText("service purchase confirmed")).toHaveCount(0);
    await page.getByRole("button", { name: "settlement" }).click();
    await expect(page.getByText("settlement confirmed").first()).toBeVisible();
    await expect(page.getByText("approval granted")).toHaveCount(0);
  });

  test("policies and approvals pages show real snapshots and decisions", async ({
    page,
  }) => {
    await seedOwnerHistory(page);
    await page.goto("/app/policies");
    await expect(page.getByText("Final payment requires approval").first()).toBeVisible();
    await expect(page.getByText("$0.05").first()).toBeVisible();
    await expect(page.getByText("not connected in this preview")).toHaveCount(0);

    await page.goto("/app/approvals");
    await expect(page.getByText("No decisions waiting here.")).toHaveCount(0);
    await expect(page.getByText(CONTRACTOR).first()).toBeVisible();
    await expect(page.getByText("0.1 USDC").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /approve payment/i })).toHaveCount(0);
  });

  test("account switch never exposes another owner history", async ({ page }) => {
    await seedOwnerHistory(page);
    await page.goto("/app/tasks");
    await expect(page.getByText("Pay contractor task-archived 0.1 USDC")).toBeVisible();

    await page.evaluate(
      ({ key, val }) => localStorage.setItem(key, JSON.stringify(val)),
      {
        key: MOCK_AUTH_STORAGE_KEY,
        val: { authenticated: true, subject: OWNER_B, walletAddress: WALLET_B },
      },
    );
    await page.reload();
    await expect(page.getByText("Pay contractor task-archived 0.1 USDC")).toHaveCount(0);
    await expect(page.getByText("Pay contractor task-active 0.1 USDC")).toHaveCount(0);
    await expect(page.getByText("Your next task starts here.")).toBeVisible();
  });

  test("start new task archives the prior task and keeps proof reachable", async ({
    page,
  }) => {
    const draftA = serializeDraftSession(
      buildDraftSession("task-a-reg", "Pay contractor task-a-reg 0.1 USDC"),
      REGISTRY,
    );
    await page.addInitScript(
      ({ authKey, authVal, sessionKey, sessionVal }) => {
        if (window.localStorage.getItem(authKey)) return;
        window.localStorage.setItem(authKey, JSON.stringify(authVal));
        window.localStorage.setItem(sessionKey, sessionVal);
      },
      {
        authKey: MOCK_AUTH_STORAGE_KEY,
        authVal: {
          authenticated: true,
          subject: OWNER_A,
          walletAddress: WALLET_A,
        },
        sessionKey: getTaskSessionStorageKey(OWNER_A),
        sessionVal: draftA,
      },
    );
    await page.goto("/app");

    await page.getByRole("button", { name: "Task actions" }).click();
    await page.getByRole("menuitem", { name: /start new task/i }).click();

    const archiveKey = getTaskArchiveStorageKey(OWNER_A) as string;
    await expect
      .poll(async () =>
        page.evaluate((key) => window.localStorage.getItem(key), archiveKey),
      )
      .not.toBeNull();
    const archivedRaw = await page.evaluate(
      (key) => window.localStorage.getItem(key) as string,
      archiveKey,
    );
    expect(JSON.parse(archivedRaw)[0]).toContain("task-a-reg");
    await page.goto("/app/tasks");
    await expect(page.getByText("Pay contractor task-a-reg 0.1 USDC")).toBeVisible();
    await expect(page.getByText("current task")).toHaveCount(0);
    await page.getByRole("link", { name: "Pay contractor task-a-reg 0.1 USDC" }).click();
    await expect(page.getByText("Pay contractor task-a-reg 0.1 USDC").first()).toBeVisible();
    await expect(page.getByText("Historical task. Read only.")).toBeVisible();
  });
});
