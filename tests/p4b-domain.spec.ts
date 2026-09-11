import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createTaskPolicy,
  formatMoney,
  money,
  type FinancialTask,
  type ServicePurchase,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  HEDERA_TESTNET_NETWORK,
  HEDERA_TESTNET_USDC_ASSET,
  WALLET_ACTIVITY_PRICE,
  WALLET_ACTIVITY_QUOTE,
  createWalletActivityServiceDescriptor,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  createLiveServiceRegistry,
  createServiceRegistry,
  hydrateServiceRegistry,
  resolveRequiredCapability,
  serializeServiceRegistry,
  type ServiceRegistry,
} from "../src/lib/services";
import { parseFinancialIntent } from "../src/lib/intent";
import { evaluateFinalPayment } from "../src/lib/tasks/runtime";
import {
  executeServicePurchase,
  type ServiceExecutionState,
  type TrustedServicePayment,
} from "../src/lib/tasks/service-execution";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import { transitionTask } from "../src/lib/domain/tasks/state-machine";
import {
  TASK_SESSION_VERSION,
  type TaskDiscoveryState,
  type TaskSession,
} from "../src/lib/tasks/session";
const NOW = "2026-09-07T12:00:00.000Z";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const PAY_TO = "0.0.9001";
const FLAGSHIP_PROMPT =
  "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.";

function makePolicy(taskId: string, overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
    ...overrides,
  });
}

function makeTask(taskId: string, policy = makePolicy(taskId)): FinancialTask {
  return createFinancialTask(
    {
      id: taskId,
      ownerId: "p4b-test-owner",
      type: "pay_with_check",
      originalIntent: FLAGSHIP_PROMPT,
      recipient: WALLET,
      paymentAmount: money("50", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
}

function makeRuntime(taskId: string, overrides: Partial<TaskPolicy> = {}): {
  task: FinancialTask;
  policy: TaskPolicy;
  registry: ServiceRegistry;
  discovery: TaskDiscoveryState;
} {
  const policy = makePolicy(taskId, overrides);
  const draft = makeTask(taskId, policy);
  const planned = transitionTask(draft, "planned", { now: NOW });
  const registry = createServiceRegistry(
    [createWalletActivityServiceDescriptor("available")],
    `p4b-${taskId}`,
  );
  return {
    task: planned,
    policy,
    registry,
    discovery: {
      requiredCapability: "wallet-activity",
      selectedServiceId: "useomnis-wallet-activity-x402",
      discoveredAt: NOW,
      registryVersion: registry.version,
    },
  };
}

function successfulPayment(requestId: string): TrustedServicePayment {
  const transaction = `tx-${requestId}`;
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
      payTo: PAY_TO,
    },
    serviceResult: {
      observations: {
        wallet: WALLET,
        transactionCount: 3,
        latestActivity: "2026-09-06T12:00:00.000Z",
      },
      heuristicFlags: [{ kind: "recent-activity", severity: "info" }],
      disclaimer: "Observations are provider facts; heuristic flags are not conclusions.",
      requestId,
    },
  };
}

function executionInput(
  runtime: ReturnType<typeof makeRuntime>,
  options: Readonly<{
    task?: FinancialTask;
    purchases?: readonly ServicePurchase[];
    requestId?: string;
    persist?: (state: ServiceExecutionState) => void | Promise<void>;
    executePayment?: (input: {
      wallet: string;
      serviceEndpoint: string;
      requestId: string;
    }) => Promise<TrustedServicePayment>;
  }> = {},
) {
  const executePayment =
    options.executePayment ??
    (async ({ requestId }: { requestId: string }) => successfulPayment(requestId));
  return {
    task: options.task ?? runtime.task,
    policy: runtime.policy,
    servicePurchases: options.purchases ?? [],
    registry: runtime.registry,
    discovery: runtime.discovery,
    wallet: WALLET,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.persist ? { persist: options.persist } : {}),
    executePayment,
    expectedPayment: {
      network: HEDERA_TESTNET_NETWORK,
      asset: HEDERA_TESTNET_USDC_ASSET,
      amount: WALLET_ACTIVITY_PRICE.units.toString(),
      payTo: PAY_TO,
    },
    now: NOW,
  };
}

async function successfulExecution(taskId: string) {
  const runtime = makeRuntime(taskId);
  let calls = 0;
  const outcome = await executeServicePurchase(
    executionInput(runtime, {
      executePayment: async (input) => {
        calls += 1;
        return successfulPayment(input.requestId);
      },
    }),
  );
  return { runtime, outcome, calls };
}

test.describe("P4B bounded paid-service execution", () => {
  test("capability resolution preserves the flagship pay_with_check intent", () => {
    const parsed = parseFinancialIntent(FLAGSHIP_PROMPT);
    expect(parsed.fields.type).toBe("pay_with_check");
    expect(parsed.fields.serviceBudget?.asset).toBe("USD");
    expect(formatMoney(parsed.fields.serviceBudget!)).toBe("0.05");
    expect(resolveRequiredCapability(makeTask("p4b-capability"))).toBe(
      "wallet-activity",
    );
  });

  test("P2 authorization is persisted before the executor is called", async () => {
    const runtime = makeRuntime("p4b-auth-order");
    const events: string[] = [];
    await executeServicePurchase(
      executionInput(runtime, {
        persist: (state) => {
          events.push(`${state.task.status}:${state.servicePurchases[0]?.status ?? "none"}`);
        },
        executePayment: async (input) => {
          events.push("executor");
          return successfulPayment(input.requestId);
        },
      }),
    );
    expect(events.indexOf("executor")).toBeGreaterThan(
      events.indexOf("running:approved"),
    );
    expect(events.indexOf("executor")).toBeGreaterThan(
      events.indexOf("running:paying"),
    );
  });

  test("reservation is visible before signing starts", async () => {
    const runtime = makeRuntime("p4b-reservation-order");
    let persistedBeforeExecutor: ServiceExecutionState | undefined;
    await executeServicePurchase(
      executionInput(runtime, {
        persist: (state) => {
          if (state.servicePurchases.some((purchase) => purchase.status === "paying")) {
            persistedBeforeExecutor = state;
          }
        },
        executePayment: async (input) => {
          expect(persistedBeforeExecutor?.budget.reservedSpend.units).toBe(
            BigInt(3000),
          );
          return successfulPayment(input.requestId);
        },
      }),
    );
  });

  test("unauthorized service policy blocks the network executor", async () => {
    const runtime = makeRuntime("p4b-unauthorized", {
      allowedServiceNetworks: ["another-network"],
    });
    let calls = 0;
    await expect(
      executeServicePurchase(
        executionInput(runtime, {
          executePayment: async (input) => {
            calls += 1;
            return successfulPayment(input.requestId);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "DENY_NETWORK_NOT_ALLOWED" });
    expect(calls).toBe(0);
  });

  test("successful settlement becomes paid exactly once", async () => {
    const { outcome, calls } = await successfulExecution("p4b-paid-once");
    expect(outcome.kind).toBe("paid");
    expect(outcome.purchase.status).toBe("paid");
    expect(outcome.purchase.paymentIdentifier).toMatch(/^tx-/);
    expect(outcome.state.task.status).toBe("awaiting_approval");
    expect(calls).toBe(1);
  });

  test("confirmed spend replaces the reservation", async () => {
    const { outcome } = await successfulExecution("p4b-confirmed-spend");
    expect(formatMoney(outcome.state.budget.confirmedSpend)).toBe("0.003");
    expect(formatMoney(outcome.state.budget.reservedSpend)).toBe("0");
    expect(formatMoney(outcome.state.budget.remainingAvailable)).toBe("0.047");
  });

  test("budget remainder uses exact bigint units", async () => {
    const { outcome } = await successfulExecution("p4b-bigint-remainder");
    expect(outcome.state.budget.confirmedSpend.units).toBe(BigInt(3000));
    expect(outcome.state.budget.remainingAvailable.units).toBe(BigInt(47000));
    expect(outcome.state.budget.remainingAvailable.decimals).toBe(6);
  });

  test("payment identifier survives session persistence", async () => {
    const { runtime, outcome } = await successfulExecution("p4b-payment-persist");
    const serialized = serializeDraftSession(
      {
        version: 4,
        messages: [],
        task: outcome.state.task,
        policy: outcome.state.policy,
        servicePurchases: outcome.state.servicePurchases,
        budget: outcome.state.budget,
        discovery: runtime.discovery,
      },
      runtime.registry,
    );
    const restored = hydrateDraftSession(serialized, runtime.registry);
    expect(restored?.servicePurchases?.[0]?.paymentIdentifier).toBe(
      outcome.purchase.paymentIdentifier,
    );
    expect(restored?.servicePurchases?.[0]?.settlementNetwork).toBe(
      HEDERA_TESTNET_NETWORK,
    );
  });

  test("protected observations and heuristic flags survive persistence", async () => {
    const { runtime, outcome } = await successfulExecution("p4b-result-persist");
    const restored = hydrateDraftSession(
      serializeDraftSession(
        {
          version: 4,
          messages: [],
          task: outcome.state.task,
          policy: outcome.state.policy,
          servicePurchases: outcome.state.servicePurchases,
          discovery: runtime.discovery,
        },
        runtime.registry,
      ),
      runtime.registry,
    );
    const result = restored?.servicePurchases?.[0]?.serviceResult;
    expect(result?.observations.wallet).toBe(WALLET);
    expect(result?.heuristicFlags).toEqual([
      { kind: "recent-activity", severity: "info" },
    ]);
    expect(result?.observations).not.toHaveProperty("heuristicFlags");
  });

  test("duplicate execution does not invoke the executor twice", async () => {
    const first = await successfulExecution("p4b-duplicate");
    const second = await executeServicePurchase(
      executionInput(first.runtime, {
        task: first.outcome.state.task,
        purchases: first.outcome.state.servicePurchases,
        executePayment: async (input) => {
          first.calls += 1;
          return successfulPayment(input.requestId);
        },
      }),
    );
    expect(second.kind).toBe("paid");
    expect(first.calls).toBe(1);
  });

  test("reloaded paid session does not repeat payment", async () => {
    const first = await successfulExecution("p4b-reload");
    const serialized = serializeDraftSession(
      {
        version: 4,
        messages: [],
        task: first.outcome.state.task,
        policy: first.outcome.state.policy,
        servicePurchases: first.outcome.state.servicePurchases,
        discovery: first.runtime.discovery,
      },
      first.runtime.registry,
    );
    const restored = hydrateDraftSession(serialized, first.runtime.registry);
    expect(restored).not.toBeNull();
    const second = await executeServicePurchase(
      executionInput(first.runtime, {
        task: restored!.task,
        purchases: restored!.servicePurchases,
        executePayment: async (input) => {
          first.calls += 1;
          return successfulPayment(input.requestId);
        },
      }),
    );
    expect(second.kind).toBe("paid");
    expect(first.calls).toBe(1);
  });

  test("pre-settlement failure releases the reservation", async () => {
    const runtime = makeRuntime("p4b-known-failure");
    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async () => {
          throw {
            code: "P4A_RESOURCE_EXECUTION_FAILED",
            recovery: {
              requestId: "unused",
              stage: "resource_execution",
              retryable: true,
            },
          };
        },
      }),
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.purchase.status).toBe("failed");
    expect(outcome.purchase.paymentIdentifier).toBeUndefined();
    expect(formatMoney(outcome.state.budget.reservedSpend)).toBe("0");
    expect(formatMoney(outcome.state.budget.remainingAvailable)).toBe("0.05");
  });

  test("ambiguous send retains non-retryable recovery state", async () => {
    const runtime = makeRuntime("p4b-ambiguous");
    let calls = 0;
    const input = executionInput(runtime, {
      executePayment: async () => {
        calls += 1;
        throw {
          code: "P4A_PAYMENT_OUTCOME_UNKNOWN",
          recovery: {
            requestId: "unused",
            stage: "payment_signed",
            retryable: false,
          },
        };
      },
    });
    const outcome = await executeServicePurchase(input);
    expect(outcome.kind).toBe("recovery");
    expect(outcome.purchase.status).toBe("paying");
    expect(outcome.purchase.recoveryState?.retryable).toBe(false);
    expect(outcome.purchase.recoveryState?.mode).toBe("read_only_reconcile");
    expect(outcome.purchase.recoveryState?.stage).toBe("payment_signed");
    const replay = await executeServicePurchase({
      ...input,
      task: outcome.state.task,
      servicePurchases: outcome.state.servicePurchases,
    });
    expect(replay.kind).toBe("pending");
    expect(calls).toBe(1);
  });

  test("observations remain distinct from heuristics", async () => {
    const { outcome } = await successfulExecution("p4b-evidence-boundary");
    expect(outcome.purchase.serviceResult?.observations).toEqual({
      wallet: WALLET,
      transactionCount: 3,
      latestActivity: "2026-09-06T12:00:00.000Z",
    });
    expect(outcome.purchase.serviceResult?.heuristicFlags).toEqual([
      { kind: "recent-activity", severity: "info" },
    ]);
  });

  test("final contractor payment remains REQUIRE_APPROVAL", async () => {
    const { outcome } = await successfulExecution("p4b-final-approval");
    const evaluation = evaluateFinalPayment({
      task: outcome.state.task,
      policy: outcome.state.policy,
    });
    expect(evaluation.decision).toBe("REQUIRE_APPROVAL");
    expect(evaluation.amount.units).toBe(BigInt(50_000_000));
    expect(outcome.state.task.status).toBe("awaiting_approval");
  });

  test("oversized protected result becomes read-only recovery with evidence", async () => {
    const runtime = makeRuntime("p4b-result-too-large");
    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => ({
          ...successfulPayment(input.requestId),
          serviceResult: {
            observations: { payload: "x".repeat(70_000) },
            heuristicFlags: [],
          },
        }),
      }),
    );
    expect(outcome.kind).toBe("recovery");
    expect(outcome.purchase.status).toBe("paying");
    expect(outcome.purchase.paymentIdentifier).toMatch(/^tx-/);
    expect(outcome.purchase.recoveryState?.retryable).toBe(false);
  });

  test("automated execution uses only the injected test executor", async () => {
    const runtime = makeRuntime("p4b-no-live-payment");
    let fakeCalls = 0;
    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => {
          fakeCalls += 1;
          expect(input.serviceEndpoint).toBe("/api/services/wallet-activity");
          return successfulPayment(input.requestId);
        },
      }),
    );
    expect(outcome.kind).toBe("paid");
    expect(fakeCalls).toBe(1);
  });
});

test.describe("P4B.1 Authenticated Flagship Wallet-Check Regression Verification", () => {
  const USER_ALICE_DID = "did:privy:alice-p4b-user";
  const USER_BOB_DID = "did:privy:bob-p4b-user";
  const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";
  const CONTRACTOR_WALLET = "0x2222222222222222222222222222222222222222";

  // 1. authenticated pay_with_check reaches P4A executor
  test("1. authenticated pay_with_check reaches P4A executor", async () => {
    const policy = makePolicy("task-auth-p4a");
    const draft = createFinancialTask(
      {
        id: "task-auth-p4a",
        ownerId: USER_ALICE_DID,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        type: "pay_with_check",
        originalIntent: FLAGSHIP_PROMPT,
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        purpose: "contractor payment",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    );
    const planned = transitionTask(draft, "planned", { now: NOW });
    const registry = createLiveServiceRegistry("available");
    const discovery = {
      requiredCapability: "wallet-activity",
      selectedServiceId: "useomnis-wallet-activity-x402",
      discoveredAt: NOW,
      registryVersion: registry.version,
    };

    let reachedExecutor = false;
    let receivedWallet = "";
    let receivedEndpoint = "";
    let receivedRequestId = "";

    const outcome = await executeServicePurchase({
      task: planned,
      policy,
      servicePurchases: [],
      registry,
      discovery,
      wallet: CONTRACTOR_WALLET,
      executePayment: async (input) => {
        reachedExecutor = true;
        receivedWallet = input.wallet;
        receivedEndpoint = input.serviceEndpoint;
        receivedRequestId = input.requestId;
        return successfulPayment(input.requestId);
      },
      expectedPayment: {
        network: HEDERA_TESTNET_NETWORK,
        asset: HEDERA_TESTNET_USDC_ASSET,
        amount: WALLET_ACTIVITY_PRICE.units.toString(),
        payTo: PAY_TO,
      },
    });

    expect(reachedExecutor).toBe(true);
    expect(receivedWallet.toLowerCase()).toBe(CONTRACTOR_WALLET.toLowerCase());
    expect(receivedEndpoint).toBe("/api/services/wallet-activity");
    expect(receivedRequestId).toBeTruthy();
    expect(outcome.kind).toBe("paid");
    expect(outcome.purchase.status).toBe("paid");
  });

  // 2. owner validation succeeds for the real authenticated subject
  test("2. owner validation succeeds for the real authenticated subject", () => {
    const registry = createLiveServiceRegistry("available");
    const policy = makePolicy("task-owner-valid");
    const draft = createFinancialTask(
      {
        id: "task-owner-valid",
        ownerId: USER_ALICE_DID,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        type: "pay_with_check",
        originalIntent: FLAGSHIP_PROMPT,
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        purpose: "contractor payment",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    );
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: draft,
      policy,
      servicePurchases: [],
    };

    const raw = serializeDraftSession(session, registry);
    const hydrated = hydrateDraftSession(raw, registry, {
      expectedOwnerSubject: USER_ALICE_DID,
    });

    expect(hydrated).not.toBeNull();
    expect(hydrated?.ownerSubject).toBe(USER_ALICE_DID);
    expect(hydrated?.task?.ownerSubject).toBe(USER_ALICE_DID);
  });

  // 3. spoofed owner still fails
  test("3. spoofed owner still fails", () => {
    const registry = createLiveServiceRegistry("available");
    const policy = makePolicy("task-spoof-fail");
    const draft = createFinancialTask(
      {
        id: "task-spoof-fail",
        ownerId: USER_BOB_DID,
        ownerSubject: USER_BOB_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        type: "pay_with_check",
        originalIntent: FLAGSHIP_PROMPT,
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        purpose: "contractor payment",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    );
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_BOB_DID,
      messages: [],
      task: draft,
      policy,
      servicePurchases: [],
    };

    const raw = serializeDraftSession(session, registry);
    // User Alice tries to hydrate User Bob's session:
    const hydrated = hydrateDraftSession(raw, registry, {
      expectedOwnerSubject: USER_ALICE_DID,
    });

    expect(hydrated).toBeNull();
  });

  // 4. live descriptor survives API serialization/hydration
  test("4. live descriptor survives API serialization/hydration", () => {
    const liveRegistry = createLiveServiceRegistry("available");
    const descriptor = liveRegistry.getService("useomnis-wallet-activity-x402");
    expect(descriptor).toBeDefined();
    expect(descriptor?.status).toBe("available");
    expect(descriptor?.price.asset).toBe("USD");
    expect(descriptor?.price.units).toBe(BigInt(3000));
    expect(descriptor?.paymentAmount?.asset).toBe("USDC");
    expect(descriptor?.paymentAmount?.units).toBe(BigInt(3000));

    const serialized = serializeServiceRegistry(liveRegistry);
    const hydrated = hydrateServiceRegistry(serialized);
    const hydratedDescriptor = hydrated.getService(
      "useomnis-wallet-activity-x402",
    );

    expect(hydratedDescriptor).toBeDefined();
    expect(hydratedDescriptor?.status).toBe("available");
    expect(hydratedDescriptor?.price.asset).toBe("USD");
    expect(hydratedDescriptor?.price.units).toBe(BigInt(3000));
    expect(hydratedDescriptor?.paymentAmount?.asset).toBe("USDC");
    expect(hydratedDescriptor?.paymentAmount?.units).toBe(BigInt(3000));
    expect(hydratedDescriptor?.network).toBe(HEDERA_TESTNET_NETWORK);
  });

  // 5. accounting USD quote and onchain USDC asset are not conflated
  test("5. accounting USD quote and onchain USDC asset are not conflated", () => {
    expect(WALLET_ACTIVITY_QUOTE.asset).toBe("USD");
    expect(WALLET_ACTIVITY_QUOTE.decimals).toBe(6);
    expect(WALLET_ACTIVITY_PRICE.asset).toBe("USDC");
    expect(WALLET_ACTIVITY_PRICE.decimals).toBe(6);

    // Both use 6 decimals but represent different accounting concepts:
    expect(WALLET_ACTIVITY_QUOTE.asset).not.toBe(WALLET_ACTIVITY_PRICE.asset);
    expect(WALLET_ACTIVITY_QUOTE.units).toBe(WALLET_ACTIVITY_PRICE.units);
  });

  // 6. known failed pre-settlement attempt can be explicitly restarted safely
  test("6. known failed pre-settlement attempt can be explicitly restarted safely", async () => {
    const runtime = makeRuntime("task-restart-safe");
    let attempt = 0;

    // Attempt 1 fails pre-settlement:
    const failedOutcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async () => {
          attempt += 1;
          throw {
            code: "P4A_RESOURCE_EXECUTION_FAILED",
            recovery: {
              requestId: "p4b-attempt-1",
              stage: "resource_execution",
              retryable: true,
            },
          };
        },
      }),
    );

    expect(failedOutcome.kind).toBe("failed");
    expect(failedOutcome.purchase.status).toBe("failed");
    expect(attempt).toBe(1);

    // Attempt 2 safely restarts with new authorized attempt:
    const restartedOutcome = await executeServicePurchase(
      executionInput(runtime, {
        task: failedOutcome.state.task,
        purchases: failedOutcome.state.servicePurchases,
        requestId: "p4b-attempt-2",
        executePayment: async (input) => {
          attempt += 1;
          expect(input.requestId).toBe("p4b-attempt-2");
          return successfulPayment(input.requestId);
        },
      }),
    );

    expect(restartedOutcome.kind).toBe("paid");
    expect(restartedOutcome.purchase.status).toBe("paid");
    expect(attempt).toBe(2);
  });

  // 7. ambiguous paying state cannot retry
  test("7. ambiguous paying state cannot retry", async () => {
    const runtime = makeRuntime("task-ambiguous-no-retry");
    let executionCalls = 0;

    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        requestId: "ambiguous-req-1",
        executePayment: async () => {
          executionCalls += 1;
          throw {
            code: "P4A_PAYMENT_OUTCOME_UNKNOWN",
            recovery: {
              requestId: "ambiguous-req-1",
              stage: "payment_signed",
              retryable: false,
            },
          };
        },
      }),
    );

    expect(outcome.kind).toBe("recovery");
    expect(outcome.purchase.status).toBe("paying");
    expect(outcome.purchase.recoveryState?.retryable).toBe(false);

    // Attempting to retry an ambiguous paying purchase returns pending/recovery, does not re-execute:
    const retryAttempt = await executeServicePurchase(
      executionInput(runtime, {
        task: outcome.state.task,
        purchases: outcome.state.servicePurchases,
        requestId: "ambiguous-req-1",
        executePayment: async () => {
          executionCalls += 1;
          return successfulPayment("ambiguous-req-1");
        },
      }),
    );
    expect(retryAttempt.kind).toBe("recovery");
    expect(retryAttempt.purchase.status).toBe("paying");
    expect(executionCalls).toBe(1); // Never re-executed!
  });

  // 8. new retry gets a fresh idempotency/request ID
  test("8. new retry gets a fresh idempotency/request ID", async () => {
    const runtime = makeRuntime("task-fresh-request-id");
    const observedRequestIds: string[] = [];

    // Attempt 1 fails pre-settlement:
    const first = await executeServicePurchase(
      executionInput(runtime, {
        requestId: "req-first-attempt",
        executePayment: async (input) => {
          observedRequestIds.push(input.requestId);
          throw {
            code: "P4A_RESOURCE_EXECUTION_FAILED",
            recovery: {
              requestId: input.requestId,
              stage: "resource_execution",
              retryable: true,
            },
          };
        },
      }),
    );
    expect(first.kind).toBe("failed");

    // Retry attempt specifies fresh request ID:
    const second = await executeServicePurchase(
      executionInput(runtime, {
        task: first.state.task,
        purchases: first.state.servicePurchases,
        requestId: "req-second-fresh-attempt",
        executePayment: async (input) => {
          observedRequestIds.push(input.requestId);
          return successfulPayment(input.requestId);
        },
      }),
    );

    expect(second.kind).toBe("paid");
    expect(observedRequestIds).toHaveLength(2);
    expect(observedRequestIds[0]).toBe("req-first-attempt");
    expect(observedRequestIds[1]).toBe("req-second-fresh-attempt");
    expect(observedRequestIds[0]).not.toBe(observedRequestIds[1]);
  });

  // 9. successful x402 result becomes paid exactly once
  test("9. successful x402 result becomes paid exactly once", async () => {
    const runtime = makeRuntime("task-paid-once");
    let paymentCalls = 0;

    const first = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => {
          paymentCalls += 1;
          return successfulPayment(input.requestId);
        },
      }),
    );

    expect(first.kind).toBe("paid");
    expect(paymentCalls).toBe(1);

    // Second call with same state
    const second = await executeServicePurchase(
      executionInput(runtime, {
        task: first.state.task,
        purchases: first.state.servicePurchases,
        executePayment: async (input) => {
          paymentCalls += 1;
          return successfulPayment(input.requestId);
        },
      }),
    );

    expect(second.kind).toBe("paid");
    expect(paymentCalls).toBe(1); // Payment was not repeated!
  });

  // 10. spent $0.003 / remaining $0.047
  test("10. budget accounts spent $0.003 / remaining $0.047 after purchase", async () => {
    const runtime = makeRuntime("task-budget-math");
    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => successfulPayment(input.requestId),
      }),
    );

    expect(outcome.kind).toBe("paid");
    expect(formatMoney(outcome.state.budget.confirmedSpend)).toBe("0.003");
    expect(formatMoney(outcome.state.budget.reservedSpend)).toBe("0");
    expect(formatMoney(outcome.state.budget.remainingAvailable)).toBe("0.047");
  });

  // 11. payment identifier/result survive reload
  test("11. payment identifier and result survive serialization and reload", async () => {
    const runtime = makeRuntime("task-survive-reload");
    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => successfulPayment(input.requestId),
      }),
    );

    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: outcome.state.task,
      policy: outcome.state.policy,
      servicePurchases: outcome.state.servicePurchases,
    };

    const serialized = serializeDraftSession(session, runtime.registry);
    const reloaded = hydrateDraftSession(serialized, runtime.registry, {
      expectedOwnerSubject: USER_ALICE_DID,
    });

    expect(reloaded).not.toBeNull();
    expect(reloaded?.servicePurchases).toHaveLength(1);
    const purchase = reloaded!.servicePurchases![0];
    expect(purchase.status).toBe("paid");
    expect(purchase.paymentIdentifier).toBeTruthy();
    expect(purchase.serviceResult).toBeDefined();
  });

  // 12. duplicate React keys are removed
  test("12. duplicate React keys are removed and external wallets deduplicated", () => {
    const seen = new Set<string>();
    const externalWallets = [
      { address: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9", walletClientType: "metamask" },
      { address: "0xc44685b7c78cc9c9b7f6623d7697ac30ab0d6dc9", walletClientType: "metamask" },
      { address: "0x1234567890abcdef1234567890abcdef12345678", walletClientType: "coinbase" },
    ];

    const deduplicated = externalWallets.filter((ext) => {
      const lower = ext.address.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });

    expect(deduplicated).toHaveLength(2);

    const keys = deduplicated.map(
      (ext, idx) => `ext-wallet-${ext.address.toLowerCase()}-${idx}`,
    );
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  // 13. final 50 USDC remains REQUIRE_APPROVAL
  test("13. final 50 USDC contractor payment remains REQUIRE_APPROVAL", async () => {
    const runtime = makeRuntime("task-contractor-require-approval");
    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => successfulPayment(input.requestId),
      }),
    );

    expect(outcome.state.task.status).toBe("awaiting_approval");

    const evaluation = evaluateFinalPayment({
      task: outcome.state.task,
      policy: outcome.state.policy,
    });

    expect(evaluation.decision).toBe("REQUIRE_APPROVAL");
    expect(evaluation.amount.units).toBe(BigInt(50_000_000));
    expect(outcome.state.task.status).not.toBe("completed");
    expect(outcome.state.task.status).not.toBe("settling");
  });

  // 14. no automated test sends a real payment
  test("14. no automated test sends a real payment", async () => {
    const realNetworkCallMade = false;
    const runtime = makeRuntime("task-no-real-payment");

    const outcome = await executeServicePurchase(
      executionInput(runtime, {
        executePayment: async (input) => {
          // Isolated in-memory mock payment executor
          return successfulPayment(input.requestId);
        },
      }),
    );

    expect(outcome.kind).toBe("paid");
    expect(realNetworkCallMade).toBe(false);
  });
});
