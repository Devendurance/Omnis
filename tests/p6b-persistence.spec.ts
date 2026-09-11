import { expect, test, type Page } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  finalizeProof,
  formatMoney,
  money,
  transitionTask,
  type FinancialTask,
  type ServicePurchase,
  type SettlementExecution,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  createLiveServiceRegistry,
  serializeServiceRegistry,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
  WALLET_ACTIVITY_QUOTE,
} from "../src/lib/services/wallet-activity-descriptor";
import { MOCK_AUTH_STORAGE_KEY } from "../src/lib/auth/context";
import {
  DRAFT_SESSION_STORAGE_KEY,
  getTaskSessionStorageKey,
  hydrateDraftSession,
  isPristineInitialSession,
  loadDraftSession,
  saveDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import {
  TASK_SESSION_VERSION,
  type TaskSession,
} from "../src/lib/tasks/session";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";

type SessionWrite = { key: string; value: string };

declare global {
  interface Window {
    __sessionWrites?: SessionWrite[];
    __OMNIS_TEST_AUTH_READY?: boolean;
    __ethSendTransactionCount?: number;
  }
}

const NOW = "2026-09-08T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-p6b-persistence";
const USER_BOB_DID = "did:privy:bob-p6b-persistence";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";
const USER_BOB_WALLET = "0x2222222222222222222222222222222222222222";
const CONTRACTOR_WALLET = "0x3333333333333333333333333333333333333333";

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

function makeTask(taskId: string, policy: TaskPolicy): FinancialTask {
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
      quotedAmount: WALLET_ACTIVITY_QUOTE,
      paymentAmount: WALLET_ACTIVITY_PRICE,
      paidAmount: WALLET_ACTIVITY_QUOTE,
      policySnapshot: policy,
      status: "paid",
      requestId: `request-${taskId}`,
      paymentIdentifier: "0.0.7162784@1788908433.043020353",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: {
          wallet: CONTRACTOR_WALLET,
          transactionCount: "5",
          activityObserved: true,
        },
        heuristicFlags: [{ code: "known_active_wallet", severity: "info" }],
        disclaimer: "Factual observation result.",
        requestId: `request-${taskId}`,
      },
    },
    NOW,
  );
}

function makeAwaitingSession(taskId: string): TaskSession {
  const policy = makePolicy(taskId);
  const draft = makeTask(taskId, policy);
  const planned = transitionTask(draft, "planned", { now: NOW });
  const running = beginTaskExecution(planned, policy, NOW);
  const purchase = makePaidPurchase(taskId, policy);
  const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);
  const registry = createLiveServiceRegistry("available");
  return {
    version: TASK_SESSION_VERSION,
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
  };
}

function makeStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

test.describe("P6B authenticated task session persistence barrier", () => {
  test("pristine startup state cannot replace a persisted financial session", () => {
    const storage = makeStorage();
    const session = makeAwaitingSession("p6b-barrier");
    const key = getTaskSessionStorageKey(USER_ALICE_DID);
    const stored = serializeDraftSession(session);
    storage.setItem(key, stored);

    const pristine: TaskSession = {
      version: TASK_SESSION_VERSION,
      messages: [],
    };
    expect(isPristineInitialSession(pristine)).toBe(true);
    expect(
      saveDraftSession(pristine, storage, undefined, {
        expectedOwnerSubject: USER_ALICE_DID,
      }),
    ).toBe(false);
    expect(storage.getItem(key)).toBe(stored);

    const intentionalEmpty: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
    };
    expect(isPristineInitialSession(intentionalEmpty)).toBe(false);
    expect(
      saveDraftSession(intentionalEmpty, storage, undefined, {
        expectedOwnerSubject: USER_ALICE_DID,
        persistenceHydrated: true,
      }),
    ).toBe(true);
    expect(storage.getItem(key)).not.toBe(stored);
  });
  test("owner-scoped saves reject a mismatched candidate", () => {
    const storage = makeStorage();
    const session = makeAwaitingSession("p6b-save-owner");

    expect(
      saveDraftSession(session, storage, undefined, {
        expectedOwnerSubject: USER_BOB_DID,
        persistenceHydrated: true,
      }),
    ).toBe(false);
    expect(
      storage.getItem(getTaskSessionStorageKey(USER_ALICE_DID)),
    ).toBeNull();
    expect(storage.getItem(getTaskSessionStorageKey(USER_BOB_DID))).toBeNull();
  });

  test("empty messages do not make a financial session pristine", () => {
    const session = makeAwaitingSession("p6b-structural-pristine");
    expect(session.messages).toHaveLength(0);
    expect(isPristineInitialSession(session)).toBe(false);
  });

  test("corrupt persisted state fails closed", () => {
    const storage = makeStorage();
    const key = getTaskSessionStorageKey(USER_ALICE_DID);
    storage.setItem(key, JSON.stringify({ version: 5, messages: [{}] }));

    expect(
      loadDraftSession(storage, undefined, {
        expectedOwnerSubject: USER_ALICE_DID,
      }),
    ).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  test("version five serializer preserves the complete financial session", () => {
    const policy = makePolicy("p6b-all-fields");
    const draft = makeTask("p6b-all-fields", policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const purchase = makePaidPurchase(draft.id, policy);
    const awaiting = moveTaskToAwaitingApproval(
      running,
      policy,
      [purchase],
      NOW,
    );
    const settlement: SettlementExecution = {
      id: "settlement-all-fields",
      taskId: draft.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: "Arc Testnet",
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirmed",
      transactionHash: "0xall-fields-transaction",
      confirmationEvidence: {
        source: "reconciliation",
        transactionHash: "0xall-fields-transaction",
        outcome: "confirmed",
        observedAt: NOW,
        receiptReference: "42000",
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const approval = createApprovalRecord({
      id: "approval-all-fields",
      taskId: draft.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: settlement.amount,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
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
      now: NOW,
    });
    const proof = finalizeProof({
      task: completed,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      intent: { original: "pay contractor" },
      agentSummary: "Factual fixture summary.",
      recordedAt: NOW,
    });
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      pendingIntent: {
        type: "pay_with_check",
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        paymentAmountText: "50",
        paymentAsset: "USDC",
        purpose: "contractor payment",
        serviceBudget: money("0.05", "USD"),
        perServiceCap: money("0.05", "USD"),
        finalPaymentApprovalRequired: true,
      },
      task: completed,
      policy,
      servicePurchases: [purchase],
      discovery: {
        requiredCapability: "wallet-activity",
        selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
        discoveredAt: NOW,
        registryVersion: createLiveServiceRegistry("available").version,
      },
      approval,
      settlement,
      proof,
    };

    const raw = serializeDraftSession(session);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.ownerSubject).toBe(USER_ALICE_DID);
    expect(parsed.ownerWalletAddress).toBe(USER_ALICE_WALLET);
    expect(parsed.task).toBeDefined();
    expect(parsed.policy).toBeDefined();
    expect(parsed.discovery).toBeDefined();
    expect(parsed.servicePurchases).toBeDefined();
    expect(parsed.budget).toBeDefined();
    expect(parsed.approval).toBeDefined();
    expect(parsed.settlement).toBeDefined();
    expect(parsed.proof).toBeDefined();

    const restored = hydrateDraftSession(raw, undefined, {
      expectedOwnerSubject: USER_ALICE_DID,
    });
    if (!restored) throw new Error("complete session failed to hydrate");
    const restoredPurchase = restored.servicePurchases?.[0];
    if (!restoredPurchase) throw new Error("paid purchase failed to hydrate");
    if (!restoredPurchase.paidAmount) {
      throw new Error("paid amount failed to hydrate");
    }
    if (!restored.budget) throw new Error("budget failed to hydrate");
    const { confirmedSpend, remainingAvailable } = restored.budget;
    if (!confirmedSpend || !remainingAvailable) {
      throw new Error("budget totals failed to hydrate");
    }
    expect(formatMoney(restoredPurchase.paidAmount)).toBe("0.003");
    expect(formatMoney(confirmedSpend)).toBe("0.003");
    expect(formatMoney(remainingAvailable)).toBe("0.047");
    expect(restored.task?.status).toBe("completed");
    expect(restoredPurchase.status).toBe("paid");
    expect(restored.approval?.id).toBe("approval-all-fields");
    expect(restored.settlement?.transactionHash).toBe(
      "0xall-fields-transaction",
    );
    expect(restored.proof?.id).toBe(proof.id);
  });

  test("owner-scoped loading never falls back to the anonymous draft", () => {
    const storage = makeStorage();
    const ownerSession = makeAwaitingSession("p6b-owner-scope");
    storage.setItem(
      getTaskSessionStorageKey(USER_ALICE_DID),
      serializeDraftSession(ownerSession),
    );
    storage.setItem(
      DRAFT_SESSION_STORAGE_KEY,
      JSON.stringify({ version: 5, messages: [] }),
    );

    const loaded = loadDraftSession(storage, undefined, {
      expectedOwnerSubject: USER_ALICE_DID,
    });
    expect(loaded?.task?.id).toBe("p6b-owner-scope");
    expect(storage.getItem(DRAFT_SESSION_STORAGE_KEY)).toBe(
      JSON.stringify({ version: 5, messages: [] }),
    );
  });

  test("automated persistence fixtures execute no payment", () => {
    const session = makeAwaitingSession("p6b-no-payment");
    const serialized = serializeDraftSession(session);
    expect(serialized).toContain('"status":"paid"');
    expect(serialized).toContain("0.003");
    expect(serialized).not.toContain("eth_sendTransaction");
  });
});

async function seedDelayedOwnerPage(
  page: Page,
  session: string,
): Promise<void> {
  await page.addInitScript(
    ({ authKey, authValue, sessionKey, sessionValue }) => {
      type TestWindow = Window & {
        __OMNIS_PREVIEW_MODE?: boolean;
        __OMNIS_TEST_AUTH_DELAY_MS?: number;
        __OMNIS_TEST_AUTH_READY?: boolean;
        __sessionWrites?: Array<{ key: string; value: string }>;
        __ethSendTransactionCount?: number;
        __mockEip1193Provider?: {
          request: (args: { method: string }) => Promise<unknown>;
        };
      };
      const testWindow = window as TestWindow;
      testWindow.__OMNIS_PREVIEW_MODE = true;
      testWindow.__OMNIS_TEST_AUTH_DELAY_MS = 3000;
      testWindow.__OMNIS_TEST_AUTH_READY = false;
      testWindow.__ethSendTransactionCount = 0;
      testWindow.__mockEip1193Provider = {
        request: async ({ method }) => {
          if (method === "eth_sendTransaction") {
            testWindow.__ethSendTransactionCount =
              (testWindow.__ethSendTransactionCount ?? 0) + 1;
            return "0xmock-no-payment";
          }
          if (method === "eth_accounts") {
            return ["0x1111111111111111111111111111111111111111"];
          }
          if (method === "eth_chainId") return "0x4cf5b2";
          return null;
        },
      };
      if (!window.localStorage.getItem(authKey)) {
        window.localStorage.setItem(authKey, JSON.stringify(authValue));
        window.localStorage.setItem(sessionKey, sessionValue);
      }
      testWindow.__sessionWrites = [];
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === sessionKey || key === "useomnis:p1:draft-session") {
          testWindow.__sessionWrites?.push({ key, value });
        }
        return originalSetItem.call(this, key, value);
      };
    },
    {
      authKey: MOCK_AUTH_STORAGE_KEY,
      authValue: {
        authenticated: true,
        subject: USER_ALICE_DID,
        walletAddress: USER_ALICE_WALLET,
      },
      sessionKey: getTaskSessionStorageKey(USER_ALICE_DID),
      sessionValue: session,
    },
  );
}

test("delayed authenticated hydration never overwrites a paid task", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const session = makeAwaitingSession("p6b-delayed-browser");
  const ownerKey = getTaskSessionStorageKey(USER_ALICE_DID);
  const serviceActions: string[] = [];
  const settlementActions: string[] = [];
  await seedDelayedOwnerPage(page, serializeDraftSession(session));
  await page.route("**/api/tasks/service-purchase", async (route) => {
    serviceActions.push("service-purchase");
    await route.abort();
  });
  await page.route("**/api/tasks/final-settlement", async (route) => {
    const body = recordValue(route.request().postDataJSON());
    const action = body.action;
    if (typeof action === "string") settlementActions.push(action);
    await route.abort();
  });

  await page.goto("/app?testMode=true", { waitUntil: "commit" });
  expect(await page.evaluate(() => window.__OMNIS_TEST_AUTH_READY)).toBe(false);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      DRAFT_SESSION_STORAGE_KEY,
    ),
  ).toBeNull();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ownerKey),
  ).toBe(serializeDraftSession(session));
  expect(await page.evaluate(() => window.__sessionWrites ?? [])).toEqual([]);

  await expect(page.getByText(USER_ALICE_DID)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("heading", { name: "approval needed" }),
  ).toBeVisible({ timeout: 20_000 });
  const persistedRaw = await page.evaluate(
    (key) => localStorage.getItem(key),
    ownerKey,
  );
  if (!persistedRaw) throw new Error("persisted session is missing");
  const persisted = recordValue(JSON.parse(persistedRaw));
  const task = recordValue(persisted.task);
  const purchases = persisted.servicePurchases;
  if (!Array.isArray(purchases) || purchases.length === 0) {
    throw new Error("persisted paid purchase is missing");
  }
  const purchase = recordValue(purchases[0]);
  const budget = recordValue(persisted.budget);
  const confirmedSpend = recordValue(budget.confirmedSpend);
  const remainingAvailable = recordValue(budget.remainingAvailable);
  expect(task.status).toBe("awaiting_approval");
  expect(purchase.status).toBe("paid");
  expect(await page.evaluate(() => window.__ethSendTransactionCount ?? 0)).toBe(
    0,
  );
  expect(confirmedSpend.amount).toBe("0.003");
  expect(remainingAvailable.amount).toBe("0.047");
  expect(serviceActions).toEqual([]);
  expect(settlementActions).not.toContain("approve");
  expect(settlementActions).not.toContain("submit");

  await page.reload({ waitUntil: "commit" });
  await expect(
    page.getByRole("heading", { name: "approval needed" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  const writes = await page.evaluate(() => window.__sessionWrites ?? []);
  expect(
    writes.some(({ value }) => {
      const parsed = recordValue(JSON.parse(value));
      return (
        parsed.version === 5 &&
        Array.isArray(parsed.messages) &&
        parsed.messages.length === 0 &&
        parsed.task === undefined
      );
    }),
  ).toBe(false);
  expect(await page.evaluate(() => window.__ethSendTransactionCount ?? 0)).toBe(
    0,
  );
});
test("mounted reauthentication discards a delayed service response", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const taskId = "p6b-mounted-reauthentication";
  const policy = makePolicy(taskId);
  const draft = makeTask(taskId, policy);
  const planned = transitionTask(draft, "planned", { now: NOW });
  const running = beginTaskExecution(planned, policy, NOW);
  const registry = createLiveServiceRegistry("available");
  const session: TaskSession = {
    version: TASK_SESSION_VERSION,
    ownerSubject: USER_ALICE_DID,
    ownerWalletAddress: USER_ALICE_WALLET,
    messages: [],
    task: running,
    policy,
    servicePurchases: [],
    discovery: {
      requiredCapability: "wallet-activity",
      selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
      discoveredAt: NOW,
      registryVersion: registry.version,
    },
  };
  const ownerKey = getTaskSessionStorageKey(USER_ALICE_DID);
  let releaseService!: () => void;
  const serviceReleased = new Promise<void>((resolve) => {
    releaseService = resolve;
  });
  let resolveServiceCompleted!: () => void;
  const serviceCompleted = new Promise<void>((resolve) => {
    resolveServiceCompleted = resolve;
  });
  let resolveServiceStarted!: () => void;
  const serviceStarted = new Promise<void>((resolve) => {
    resolveServiceStarted = resolve;
  });
  const delayedResponse = makeAwaitingSession(taskId);

  await seedDelayedOwnerPage(page, serializeDraftSession(session));
  await page.route("**/api/services", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serializeServiceRegistry(registry)),
    });
  });
  await page.route("**/api/tasks/service-purchase", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "start-wallet-check") {
      await route.abort();
      return;
    }
    resolveServiceStarted();
    await serviceReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        outcome: "paid",
        session: JSON.parse(serializeDraftSession(delayedResponse)),
      }),
    });
    resolveServiceCompleted();
  });

  await page.goto("/app?testMode=true");
  await expect(page.getByText(USER_ALICE_DID)).toBeVisible({
    timeout: 10_000,
  });
  const startButton = page.getByRole("button", { name: "start wallet check" });
  await expect(startButton).toBeVisible({ timeout: 10_000 });
  await startButton.click();
  await serviceStarted;
  const aliceBefore = await page.evaluate(
    (key) => localStorage.getItem(key),
    ownerKey,
  );

  await page.getByRole("button", { name: "Log out of session" }).click();
  await expect(page.getByText("authentication required")).toBeVisible({
    timeout: 10_000,
  });
  await page.evaluate(
    ({ authKey, authValue }) => {
      localStorage.setItem(authKey, JSON.stringify(authValue));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: authKey,
          newValue: JSON.stringify(authValue),
        }),
      );
    },
    {
      authKey: MOCK_AUTH_STORAGE_KEY,
      authValue: {
        authenticated: true,
        subject: USER_ALICE_DID,
        walletAddress: USER_ALICE_WALLET,
      },
    },
  );
  await expect(page.getByText(USER_ALICE_DID)).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("button", { name: "start wallet check" }),
  ).toBeVisible({ timeout: 10_000 });
  const aliceBeforeRelease = await page.evaluate(
    (key) => localStorage.getItem(key),
    ownerKey,
  );

  releaseService();
  await serviceCompleted;
  await expect(
    page.getByRole("button", { name: "start wallet check" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "approval needed" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("wallet activity check paid and confirmed.", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ownerKey),
  ).toBe(aliceBeforeRelease);
  expect(aliceBeforeRelease).toBe(aliceBefore);
});

test("switching owner and logging out preserve User A history", async ({
  page,
}) => {
  const session = makeAwaitingSession("p6b-owner-switch");
  const ownerKey = getTaskSessionStorageKey(USER_ALICE_DID);
  const bobKey = getTaskSessionStorageKey(USER_BOB_DID);
  await page.addInitScript(
    ({ authKey, authValue, sessionKey, sessionValue }) => {
      type PreviewWindow = Window & { __OMNIS_PREVIEW_MODE?: boolean };
      const previewWindow = window as PreviewWindow;
      previewWindow.__OMNIS_PREVIEW_MODE = true;
      if (!localStorage.getItem(authKey)) {
        localStorage.setItem(authKey, JSON.stringify(authValue));
        localStorage.setItem(sessionKey, sessionValue);
      }
    },
    {
      authKey: MOCK_AUTH_STORAGE_KEY,
      authValue: {
        authenticated: true,
        subject: USER_ALICE_DID,
        walletAddress: USER_ALICE_WALLET,
      },
      sessionKey: ownerKey,
      sessionValue: serializeDraftSession(session),
    },
  );
  await page.route("**/api/tasks/final-settlement", (route) => route.abort());
  await page.goto("/app?testMode=true");
  await expect(
    page.getByRole("heading", { name: "approval needed" }),
  ).toBeVisible({
    timeout: 10_000,
  });
  const aliceBefore = await page.evaluate(
    (key) => localStorage.getItem(key),
    ownerKey,
  );

  await page.evaluate(
    ({ authKey, authValue }) => {
      localStorage.setItem(authKey, JSON.stringify(authValue));
    },
    {
      authKey: MOCK_AUTH_STORAGE_KEY,
      authValue: {
        authenticated: true,
        subject: USER_BOB_DID,
        walletAddress: USER_BOB_WALLET,
      },
    },
  );
  await page.reload();
  await expect(page.getByText(USER_BOB_DID)).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () => page.evaluate((key) => localStorage.getItem(key), bobKey),
      { timeout: 10_000 },
    )
    .not.toBeNull();
  await expect(
    page.getByRole("heading", { name: "approval needed" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ownerKey),
  ).toBe(aliceBefore);
  const bobRaw = await page.evaluate(
    (key) => localStorage.getItem(key),
    bobKey,
  );
  if (!bobRaw) throw new Error("expected User B session to be persisted");
  expect(recordValue(JSON.parse(bobRaw)).ownerSubject).toBe(USER_BOB_DID);
  expect(bobRaw).not.toBe(aliceBefore);

  const anonymousBefore = await page.evaluate(
    (key) => localStorage.getItem(key),
    DRAFT_SESSION_STORAGE_KEY,
  );
  await page.getByRole("button", { name: "Log out of session" }).click();
  await expect(page.getByText("authentication required")).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ownerKey),
  ).toBe(aliceBefore);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      DRAFT_SESSION_STORAGE_KEY,
    ),
  ).toBe(anonymousBefore);
});
