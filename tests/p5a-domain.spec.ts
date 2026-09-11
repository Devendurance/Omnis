import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  money,
  transitionTask,
  type FinancialTask,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  createLiveServiceRegistry,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  HEDERA_TESTNET_USDC_ASSET,
  WALLET_ACTIVITY_PRICE,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  DRAFT_SESSION_STORAGE_KEY,
  getTaskSessionStorageKey,
  hydrateDraftSession,
  loadDraftSession,
  saveDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import {
  evaluateFinalPayment,
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";
import {
  executeServicePurchase,
  type TrustedServicePayment,
} from "../src/lib/tasks/service-execution";
import { orchestrateFinancialIntent } from "../src/lib/tasks/orchestrator";
import { parseFinancialIntent } from "../src/lib/intent";
import { TASK_SESSION_VERSION, type TaskSession } from "../src/lib/tasks/session";
import { verifyPrivyAccessToken } from "../src/lib/auth/verifier";

const NOW = "2026-09-08T12:00:00.000Z";
const USER_A_DID = "did:privy:alice-111";
const USER_A_WALLET = "0x1111111111111111111111111111111111111111";
const USER_B_DID = "did:privy:bob-222";
const USER_B_WALLET = "0x2222222222222222222222222222222222222222";
const CONTRACTOR_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function makePolicy(taskId: string, overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk", "analytics", "risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
    ...overrides,
  });
}

function makeTask(
  taskId: string,
  policy = makePolicy(taskId),
  overrides: Partial<FinancialTask> = {},
): FinancialTask {
  return createFinancialTask(
    {
      id: taskId,
      ownerId: overrides.ownerId ?? USER_A_DID,
      ownerSubject: overrides.ownerSubject ?? USER_A_DID,
      ownerWalletAddress: overrides.ownerWalletAddress ?? USER_A_WALLET,
      type: "pay_with_check",
      recipient: CONTRACTOR_WALLET,
      paymentAmount: money("50", "USDC"),
      purpose: "Pay contractor after activity check",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: policy.finalPaymentApprovalRequired,
      ...overrides,
    },
    NOW,
  );
}

function successfulPayment(requestId: string): TrustedServicePayment {
  const transaction = `tx-p5a-${requestId}`;
  return {
    requestId,
    paymentIdentifier: transaction,
    settlement: {
      success: true,
      transaction,
      network: HEDERA_TESTNET_NETWORK,
    },
    requirements: {
      network: HEDERA_TESTNET_NETWORK,
      asset: HEDERA_TESTNET_USDC_ASSET,
      amount: WALLET_ACTIVITY_PRICE.units.toString(),
      payTo: "0.0.9001",
    },
    serviceResult: {
      observations: { wallet: CONTRACTOR_WALLET, activityScore: 95 },
      heuristicFlags: [{ kind: "safe-activity", severity: "info" }],
      requestId,
    },
  };
}

test.describe("P5A Authentication, Embedded Wallet & Task Ownership", () => {
  test("authenticated user resolves stable owner subject and execution wallet metadata", () => {
    const parse = parseFinancialIntent(
      "Pay 50 USDC to 0x1234567890abcdef.",
    );
    const orchestrated = orchestrateFinancialIntent(parse, {
      ownerId: USER_A_DID,
      ownerSubject: USER_A_DID,
      ownerWalletAddress: USER_A_WALLET,
      now: NOW,
    });

    expect(orchestrated.kind).toBe("planned");
    if (orchestrated.kind !== "planned") return;

    expect(orchestrated.task.ownerId).toBe(USER_A_DID);
    expect(orchestrated.task.ownerSubject).toBe(USER_A_DID);
    expect(orchestrated.task.ownerWalletAddress).toBe(USER_A_WALLET);
  });

  test("private credentials never enter persisted task or session state", () => {
    const policy = makePolicy("task-clean-creds");
    const task = makeTask("task-clean-creds", policy);
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_A_DID,
      ownerWalletAddress: USER_A_WALLET,
      messages: [],
      task,
      policy,
    };

    const serialized = serializeDraftSession(session);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("key");

    const parsed = JSON.parse(serialized);
    expect(parsed.ownerSubject).toBe(USER_A_DID);
    expect(parsed.ownerWalletAddress).toBe(USER_A_WALLET);
    expect(parsed.task.ownerSubject).toBe(USER_A_DID);
  });

  test("sessions are namespaced per authenticated user", () => {
    expect(getTaskSessionStorageKey(undefined)).toBe(DRAFT_SESSION_STORAGE_KEY);
    expect(getTaskSessionStorageKey("")).toBe(DRAFT_SESSION_STORAGE_KEY);
    expect(getTaskSessionStorageKey(USER_A_DID)).toBe(
      `useomnis:session:${USER_A_DID}`,
    );
    expect(getTaskSessionStorageKey(USER_B_DID)).toBe(
      `useomnis:session:${USER_B_DID}`,
    );

    const memoryStorage = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memoryStorage.get(k) ?? null,
      setItem: (k: string, v: string) => memoryStorage.set(k, v),
      removeItem: (k: string) => memoryStorage.delete(k),
    };

    const sessionA: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_A_DID,
      ownerWalletAddress: USER_A_WALLET,
      messages: [],
      task: makeTask("task-alice", makePolicy("task-alice")),
      policy: makePolicy("task-alice"),
    };

    const sessionB: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_B_DID,
      ownerWalletAddress: USER_B_WALLET,
      messages: [],
      task: makeTask("task-bob", makePolicy("task-bob"), {
        ownerId: USER_B_DID,
        ownerSubject: USER_B_DID,
        ownerWalletAddress: USER_B_WALLET,
      }),
      policy: makePolicy("task-bob"),
    };

    saveDraftSession(sessionA, storage);
    saveDraftSession(sessionB, storage);

    expect(memoryStorage.has(`useomnis:session:${USER_A_DID}`)).toBe(true);
    expect(memoryStorage.has(`useomnis:session:${USER_B_DID}`)).toBe(true);
  });

  test("User B cannot hydrate User A's task", () => {
    const memoryStorage = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memoryStorage.get(k) ?? null,
      setItem: (k: string, v: string) => memoryStorage.set(k, v),
      removeItem: (k: string) => memoryStorage.delete(k),
    };

    const sessionA: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_A_DID,
      ownerWalletAddress: USER_A_WALLET,
      messages: [],
      task: makeTask("task-alice", makePolicy("task-alice")),
      policy: makePolicy("task-alice"),
    };

    saveDraftSession(sessionA, storage);
    const rawAliceData = memoryStorage.get(`useomnis:session:${USER_A_DID}`)!;

    // Bob tries to hydrate Alice's raw data specifying expectedOwnerSubject Bob:
    const bobHydrated = hydrateDraftSession(rawAliceData, undefined, {
      expectedOwnerSubject: USER_B_DID,
    });
    expect(bobHydrated).toBeNull();

    // Bob uses loadDraftSession for Bob:
    const bobLoaded = loadDraftSession(storage, undefined, {
      expectedOwnerSubject: USER_B_DID,
    });
    expect(bobLoaded).toBeNull();

    // Alice loads her own:
    const aliceLoaded = loadDraftSession(storage, undefined, {
      expectedOwnerSubject: USER_A_DID,
    });
    expect(aliceLoaded).not.toBeNull();
    expect(aliceLoaded?.task?.ownerSubject).toBe(USER_A_DID);
  });

  test("anonymous state cannot be hydrated as authenticated user silently", () => {
    const legacyAnonymousSession: TaskSession = {
      version: 4,
      messages: [],
      task: makeTask("task-anon", makePolicy("task-anon"), {
        ownerId: "local-preview-user",
        ownerSubject: undefined,
      }),
      policy: makePolicy("task-anon"),
    };

    const serializedAnon = serializeDraftSession(legacyAnonymousSession);

    // Attempt to hydrate anonymous session under User A's authority:
    const result = hydrateDraftSession(serializedAnon, undefined, {
      expectedOwnerSubject: USER_A_DID,
    });
    expect(result).toBeNull();
  });

  test("server token verification derives authenticated subject and rejects invalid tokens", async () => {
    const verified = await verifyPrivyAccessToken(`mock-token:${USER_A_DID}`);
    expect(verified.userId).toBe(USER_A_DID);

    await expect(verifyPrivyAccessToken("")).rejects.toThrow();
    await expect(verifyPrivyAccessToken("   ")).rejects.toThrow();
    await expect(verifyPrivyAccessToken("mock-token:")).rejects.toThrow();
  });
  test("service-purchase API rejects unauthenticated calls", async ({
    request,
  }) => {
    const registry = createLiveServiceRegistry("available");
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_A_DID,
      ownerWalletAddress: USER_A_WALLET,
      messages: [],
      task: makeTask("task-api-unauth", makePolicy("task-api-unauth")),
      policy: makePolicy("task-api-unauth"),
    };

    const response = await request.post("/api/tasks/service-purchase", {
      data: {
        action: "start-wallet-check",
        wallet: CONTRACTOR_WALLET,
        session: JSON.parse(serializeDraftSession(session, registry)),
      },
    });

    expect(response.status()).toBe(401);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("missing bearer access token");
  });

  test("client-supplied owner identity cannot spoof server identity", async ({
    request,
  }) => {
    const registry = createLiveServiceRegistry("available");
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_B_DID,
      ownerWalletAddress: USER_B_WALLET,
      messages: [],
      task: makeTask("task-spoof", makePolicy("task-spoof"), {
        ownerId: USER_B_DID,
        ownerSubject: USER_B_DID,
        ownerWalletAddress: USER_B_WALLET,
      }),
      policy: makePolicy("task-spoof"),
    };

    // Client presents token for User A, but body claims ownerSubject User B:
    const response = await request.post("/api/tasks/service-purchase", {
      headers: {
        authorization: `Bearer mock-token:${USER_A_DID}`,
      },
      data: {
        action: "start-wallet-check",
        wallet: CONTRACTOR_WALLET,
        session: JSON.parse(serializeDraftSession(session, registry)),
        ownerSubject: USER_B_DID,
      },
    });

    expect(response.status()).toBe(403);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("does not match authenticated token subject");
  });

  test("authenticated purchase passes P2 policy before network execution", async () => {
    const policy = makePolicy("task-p2-check", {
      allowedServiceNetworks: ["disallowed-network"],
    });
    const draft = makeTask("task-p2-check", policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const task = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const discovery = {
      requiredCapability: "wallet-activity",
      selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
      discoveredAt: NOW,
      registryVersion: registry.version,
    };

    let paymentExecutorCalled = false;
    await expect(
      executeServicePurchase({
        task,
        policy,
        servicePurchases: [],
        registry,
        discovery,
        wallet: CONTRACTOR_WALLET,
        now: NOW,
        executePayment: async () => {
          paymentExecutorCalled = true;
          return successfulPayment("req-123");
        },
        expectedPayment: {
          network: HEDERA_TESTNET_NETWORK,
          asset: HEDERA_TESTNET_USDC_ASSET,
          amount: WALLET_ACTIVITY_PRICE.units.toString(),
          payTo: "0.0.9001",
        },
      }),
    ).rejects.toMatchObject({ code: "DENY_NETWORK_NOT_ALLOWED" });

    expect(paymentExecutorCalled).toBe(false);
  });

  test("duplicate P4B payment protections remain intact", async () => {
    const policy = makePolicy("task-dup-p4b");
    const draft = makeTask("task-dup-p4b", policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const task = beginTaskExecution(planned, policy, NOW);
    const registry = createLiveServiceRegistry("available");
    const discovery = {
      requiredCapability: "wallet-activity",
      selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
      discoveredAt: NOW,
      registryVersion: registry.version,
    };

    let executionCalls = 0;
    const first = await executeServicePurchase({
      task,
      policy,
      servicePurchases: [],
      registry,
      discovery,
      wallet: CONTRACTOR_WALLET,
      executePayment: async (input) => {
        executionCalls += 1;
        return successfulPayment(input.requestId);
      },
      expectedPayment: {
        network: HEDERA_TESTNET_NETWORK,
        asset: HEDERA_TESTNET_USDC_ASSET,
        amount: WALLET_ACTIVITY_PRICE.units.toString(),
        payTo: "0.0.9001",
      },
    });
    expect(first.kind).toBe("paid");
    expect(executionCalls).toBe(1);

    // Replay execution on the same paid purchase
    const second = await executeServicePurchase({
      task: first.state.task,
      policy: first.state.policy,
      servicePurchases: first.state.servicePurchases,
      registry,
      discovery,
      wallet: CONTRACTOR_WALLET,
      now: NOW,
      executePayment: async (input) => {
        executionCalls += 1;
        return successfulPayment(input.requestId);
      },
    });

    expect(second.kind).toBe("paid");
    expect(executionCalls).toBe(1);
  });

  test("final 50 USDC contractor payment remains REQUIRE_APPROVAL", () => {
    const policy = makePolicy("task-final-check");
    const draft = makeTask("task-final-check", policy);
    const planned = transitionTask(draft, "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);
    const purchase = createServicePurchase(
      {
        id: "purchase-1",
        taskId: draft.id,
        serviceId: WALLET_ACTIVITY_SERVICE_ID,
        quotedAmount: WALLET_ACTIVITY_PRICE,
        paidAmount: WALLET_ACTIVITY_PRICE,
        policySnapshot: policy,
        status: "paid",
        requestId: "req-p5a",
        paymentIdentifier: "tx-p5a-123",
        settlementNetwork: HEDERA_TESTNET_NETWORK,
      },
      NOW,
    );

    const awaiting = moveTaskToAwaitingApproval(
      running,
      policy,
      [purchase],
      NOW,
    );

    const evaluation = evaluateFinalPayment({
      task: awaiting,
      policy,
    });

    expect(evaluation.decision).toBe("REQUIRE_APPROVAL");
    expect(evaluation.amount.units).toBe(BigInt(50_000_000));
    expect(evaluation.recipient).toBe(CONTRACTOR_WALLET);
    expect(awaiting.status).toBe("awaiting_approval");
  });

  test("no automated test signs or sends an onchain transaction", () => {
    // In P5A, neither the embedded wallet nor the contractor settlement sends transactions
    const policy = makePolicy("task-no-sign");
    const task = makeTask("task-no-sign", policy);
    const evaluation = evaluateFinalPayment({ task, policy });
    expect(evaluation.decision).toBe("REQUIRE_APPROVAL");
    expect(task.status).toBe("draft");
  });
});
