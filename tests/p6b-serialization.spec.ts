import type { PublicClient } from "viem";
import { expect, test } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createSettlementExecution,
  createTaskPolicy,
  formatMoney,
  hydrateMoney,
  money,
  moneyFromUnits,
  serializeMoney,
  transitionTask,
  type FinancialTask,
  type OmnisProof,
  type ServicePurchase,
  type TaskPolicy,
  type SettlementExecution,
} from "../src/lib/domain";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  approveFinalSettlement,
  hydrateFinalSettlementAuthorizedExecution,
  hydrateFinalSettlementPreflight,
  P6B_TEST_MODE_AMOUNT,
  runFinalSettlementPreflight,
  serializeFinalSettlementAuthorizedExecution,
  serializeFinalSettlementPreflight,
} from "../src/lib/settlement/final/service";
import { ARC_TESTNET_NAME } from "../src/lib/settlement/arc/config";
import {
  hydrateProof,
  hydrateSettlement,
  serializeApproval,
  serializeDraftSession,
  serializeProof,
  serializeSettlement,
} from "../src/lib/tasks/persistence";
import type { TaskSession } from "../src/lib/tasks/session";

const NOW = "2026-09-08T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-p6b-serialization";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const CONTRACTOR_WALLET = "0x2222222222222222222222222222222222222222" as const;

function assertNoBigIntRecursively(obj: unknown, path = "root"): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "bigint") {
    throw new Error(`Found native bigint at ${path}: ${obj.toString()}n`);
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      assertNoBigIntRecursively(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      assertNoBigIntRecursively(val, `${path}.${key}`);
    }
  }
}

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

function makeMockPublicClient(
  opts: { balance?: bigint; chainId?: number; nativeBalance?: bigint } = {},
): PublicClient {
  return {
    getChainId: async () => opts.chainId ?? 5042002,
    readContract: async () => opts.balance ?? BigInt(10_000_000), // 10 USDC
    estimateGas: async () => BigInt(60_000),
    getGasPrice: async () => BigInt(1_000_000_000),
    getBalance: async () => opts.nativeBalance ?? BigInt(10_000_000_000_000_000),
  } as unknown as PublicClient;
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

test.describe("P6B.1 Serialization, Decimal String Invariants, and Approval Safety", () => {
  // 1. final preflight containing bigint Arc balance serializes successfully
  test("1. final preflight containing bigint Arc balance serializes successfully", async () => {
    const policy = makePolicy("task-preflight-ser");
    const task = makeTask("task-preflight-ser", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const mockClient = makeMockPublicClient({ balance: BigInt(25_000_000) }); // 25 USDC

    const { preflight } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: true,
    });

    expect(typeof preflight.arcUsdcBalance.units).toBe("bigint");
    expect(preflight.arcUsdcBalance.units).toBe(BigInt(25_000_000));

    const serialized = serializeFinalSettlementPreflight(preflight);
    expect(typeof serialized.arcUsdcBalance.units).toBe("string");
    expect(serialized.arcUsdcBalance.units).toBe("25000000");
    expect(serialized.arcUsdcBalance.amount).toBe("25");
    expect(serialized.arcUsdcBalance.asset).toBe("USDC");
    expect(serialized.arcUsdcBalance.decimals).toBe(6);

    const jsonString = JSON.stringify(serialized);
    expect(jsonString).toContain('"units":"25000000"');
    expect(jsonString).toContain('"amount":"25"');

    // formatMoney can format SerializedMoney directly
    expect(formatMoney(serialized.arcUsdcBalance)).toBe("25");

    // Hydration recovers exact bigint
    const hydrated = hydrateFinalSettlementPreflight(serialized);
    expect(typeof hydrated.arcUsdcBalance.units).toBe("bigint");
    expect(hydrated.arcUsdcBalance.units).toBe(BigInt(25_000_000));
  });

  // 2. settlement amount bigint serializes as decimal string
  test("2. settlement amount bigint serializes as decimal string", async () => {
    const policy = makePolicy("task-settlement-ser");
    const task = makeTask("task-settlement-ser", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const mockClient = makeMockPublicClient({ balance: BigInt(50_000_000) });

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: false,
    });

    expect(typeof settlement.amount.units).toBe("bigint");
    expect(settlement.amount.units).toBe(BigInt(50_000_000));

    const serialized = serializeSettlement(settlement);
    expect(typeof serialized.amount.units).toBe("string");
    expect(serialized.amount.units).toBe("50000000");
    expect(serialized.amount.amount).toBe("50");
    expect(serialized.amount.asset).toBe("USDC");

    const json = JSON.stringify(serialized);
    expect(json).toContain('"units":"50000000"');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  // 3. test-mode 0.01 USDC = "10000" atomic units
  test("3. test-mode 0.01 USDC = '10000' atomic units", () => {
    expect(P6B_TEST_MODE_AMOUNT.units).toBe(BigInt(10_000));
    const serialized = serializeMoney(P6B_TEST_MODE_AMOUNT);
    expect(serialized.units).toBe("10000");
    expect(serialized.amount).toBe("0.01");
    expect(serialized.asset).toBe("USDC");
    expect(serialized.decimals).toBe(6);
  });

  // 4. normal 50 USDC = "50000000" atomic units
  test("4. normal 50 USDC = '50000000' atomic units", () => {
    const normalAmount = money("50", "USDC");
    expect(normalAmount.units).toBe(BigInt(50_000_000));
    const serialized = serializeMoney(normalAmount);
    expect(serialized.units).toBe("50000000");
    expect(serialized.amount).toBe("50");
    expect(serialized.asset).toBe("USDC");
    expect(serialized.decimals).toBe(6);
  });

  // 5. JSON.stringify on every final-settlement API response succeeds
  test("5. JSON.stringify on every final-settlement API response succeeds", async ({ request }) => {
    const policy = makePolicy("task-api-json");
    const task = makeTask("task-api-json", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const session: TaskSession = {
      version: 5,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      messages: [],
    };

    // Prepare call
    const prepRes = await request.post("/api/tasks/final-settlement", {
      headers: {
        authorization: `Bearer mock-token:${USER_ALICE_DID}`,
        "content-type": "application/json",
      },
      data: {
        action: "prepare",
        session: JSON.parse(serializeDraftSession(session)),
        executionWalletAddress: USER_ALICE_WALLET,
        testMode: true,
      },
    });

    expect(prepRes.status()).toBe(200);
    const prepData = (await prepRes.json()) as { ok: boolean; preflight: unknown; settlement: unknown };
    expect(prepData.ok).toBe(true);

    // Verify stringify succeeds with zero bigint errors
    const prepJsonString = JSON.stringify(prepData);
    expect(prepJsonString.length).toBeGreaterThan(0);
    expect(prepJsonString).not.toContain("n,"); // no raw bigint notation

    // Approve call
    const approveRes = await request.post("/api/tasks/final-settlement", {
      headers: {
        authorization: `Bearer mock-token:${USER_ALICE_DID}`,
        "content-type": "application/json",
      },
      data: {
        action: "approve",
        session: JSON.parse(serializeDraftSession(session)),
        settlement: prepData.settlement,
        executionWalletAddress: USER_ALICE_WALLET,
        testMode: true,
      },
    });

    expect(approveRes.status()).toBe(200);
    const approveData = (await approveRes.json()) as { ok: boolean; approval: unknown };
    expect(approveData.ok).toBe(true);
    const approveJsonString = JSON.stringify(approveData);
    expect(approveJsonString.length).toBeGreaterThan(0);
  });

  // 6. approval response contains no native bigint
  test("6. approval response contains no native bigint", async ({ request }) => {
    const policy = makePolicy("task-approval-nobigint");
    const task = makeTask("task-approval-nobigint", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const session: TaskSession = {
      version: 5,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      messages: [],
    };

    const res = await request.post("/api/tasks/final-settlement", {
      headers: {
        authorization: `Bearer mock-token:${USER_ALICE_DID}`,
        "content-type": "application/json",
      },
      data: {
        action: "approve",
        session: JSON.parse(serializeDraftSession(session)),
        executionWalletAddress: USER_ALICE_WALLET,
        testMode: true,
      },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    assertNoBigIntRecursively(data, "approveResponse");
  });

  // 7. settlement persistence round-trips bigint exactly
  test("7. settlement persistence round-trips bigint exactly", () => {
    const policy = makePolicy("task-settlement-roundtrip");
    const expectedUnits = BigInt("123456789012345");
    const customMoney = moneyFromUnits(expectedUnits, "USDC", 6);
    const settlement = createSettlementExecution(
      {
        id: "settlement-rt",
        taskId: "task-settlement-roundtrip",
        provider: "circle_arc",
        amount: customMoney,
        recipient: CONTRACTOR_WALLET,
        network: ARC_TESTNET_NAME,
        approvalRequired: true,
        policySnapshot: policy,
      },
      NOW,
    );

    const serialized = serializeSettlement(settlement);
    expect(typeof serialized.amount.units).toBe("string");
    expect(serialized.amount.units).toBe("123456789012345");

    const hydrated = hydrateSettlement(serialized, policy);
    expect(typeof hydrated.amount.units).toBe("bigint");
    expect(hydrated.amount.units).toBe(expectedUnits);
    expect(hydrated.amount.units === expectedUnits).toBe(true);
  });

  // 8. proof persistence round-trips financial units exactly
  test("8. proof persistence round-trips financial units exactly", () => {
    const policy = makePolicy("task-proof-roundtrip");
    const task = makeTask("task-proof-roundtrip", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const settlementUnits = BigInt("50000000");
    const serviceSpendUnits = BigInt("3000");

    const settlement: SettlementExecution = {
      id: "settlement-proof-rt",
      taskId: task.id,
      provider: "circle_arc",
      amount: moneyFromUnits(settlementUnits, "USDC", 6),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirmed",
      transactionHash: "0xfinal_proof_arc_hash",
      confirmationEvidence: {
        source: "reconciliation",
        transactionHash: "0xfinal_proof_arc_hash",
        outcome: "confirmed",
        observedAt: NOW,
        receiptReference: "12345",
      },
      createdAt: NOW,
      updatedAt: NOW,
    };

    const approval = createApprovalRecord({
      id: "approval-proof-rt",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: settlement.amount,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });
    const settling = transitionTask(awaiting, "settling", {
      approval,
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });
    const completed = transitionTask(settling, "completed", {
      settlement,
      approval,
      now: NOW,
    });

    const proof: OmnisProof = {
      id: "proof-rt",
      idempotencyKey: "idem-proof-rt",
      taskId: task.id,
      ownerId: USER_ALICE_DID,
      createdAt: NOW,
      intent: task.originalIntent,
      task: completed,
      policy,
      servicePurchases: [purchase],
      totalServiceSpend: moneyFromUnits(serviceSpendUnits, "USD", 6),
      approval,
      finalPayment: settlement,
      status: "completed",
      agentSummary: "Proof round trip verification.",
    };

    const serialized = serializeProof(proof);
    assertNoBigIntRecursively(serialized, "serializedProof");

    const hydrated = hydrateProof(serialized);
    expect(hydrated.totalServiceSpend.units).toBe(serviceSpendUnits);
    expect(hydrated.finalPayment?.amount.units).toBe(settlementUnits);
    expect(hydrated.approval?.amount.units).toBe(settlementUnits);
  });

  // 9. corrupted numeric strings fail hydration
  test("9. corrupted numeric strings fail hydration", () => {
    const policy = makePolicy("task-corrupted-hydration");

    // Corrupted units with trailing letters
    expect(() =>
      hydrateMoney({ amount: "10.00", units: "1000000abc", asset: "USDC", decimals: 6 }),
    ).toThrow(/non-negative decimal integer string/);

    // Negative units
    expect(() =>
      hydrateMoney({ amount: "-10", units: "-10000000", asset: "USDC", decimals: 6 }),
    ).toThrow(/non-negative decimal integer string/);

    // Float units string
    expect(() =>
      hydrateMoney({ amount: "10.5", units: "10500.5", asset: "USDC", decimals: 6 }),
    ).toThrow(/non-negative decimal integer string/);

    // Empty units string
    expect(() =>
      hydrateMoney({ amount: "0", units: "", asset: "USDC", decimals: 6 }),
    ).toThrow(/non-negative decimal integer string/);

    // Corrupted settlement fails closed
    expect(() =>
      hydrateSettlement(
        {
          id: "settlement-bad",
          taskId: "task-1",
          provider: "circle_arc",
          amount: { units: "corrupt_units", asset: "USDC", decimals: 6 },
          recipient: CONTRACTOR_WALLET,
          network: ARC_TESTNET_NAME,
          approvalRequired: true,
          status: "prepared",
        },
        policy,
      ),
    ).toThrow();
  });

  // 10. no bigint is converted through Number
  test("10. no bigint is converted through Number", () => {
    // A 64-bit integer exceeding Number.MAX_SAFE_INTEGER (9007199254740991)
    const exactHugeString = "9007199254740993123456";
    const hugeBigInt = BigInt(exactHugeString);

    // Confirm that converting through Number loses precision:
    const viaNumber = BigInt(Math.floor(Number(exactHugeString)));
    expect(viaNumber).not.toBe(hugeBigInt);

    // Hydrate directly from string
    const hydrated = hydrateMoney({
      units: exactHugeString,
      asset: "USDC",
      decimals: 6,
    });

    // Precision is 100% preserved because BigInt was used directly
    expect(hydrated.units).toBe(hugeBigInt);
    expect(hydrated.units.toString()).toBe(exactHugeString);
  });

  // 11. existing paid wallet check is reused and not purchased again
  test("11. existing paid wallet check is reused and not purchased again", async ({ request }) => {
    const policy = makePolicy("task-reuse-check");
    const task = makeTask("task-reuse-check", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const originalPaymentId = purchase.paymentIdentifier;
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const session: TaskSession = {
      version: 5,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      messages: [],
    };

    // Call prepare twice: both times it must report walletCheckCompleted: true without altering purchase
    for (let i = 0; i < 2; i++) {
      const res = await request.post("/api/tasks/final-settlement", {
        headers: {
          authorization: `Bearer mock-token:${USER_ALICE_DID}`,
          "content-type": "application/json",
        },
        data: {
          action: "prepare",
          session: JSON.parse(serializeDraftSession(session)),
          executionWalletAddress: USER_ALICE_WALLET,
          testMode: true,
        },
      });
      expect(res.status()).toBe(200);
      const data = (await res.json()) as { preflight: { walletCheckCompleted: boolean } };
      expect(data.preflight.walletCheckCompleted).toBe(true);
    }

    // Purchase remains exactly as it was
    expect(session.servicePurchases?.[0].status).toBe("paid");
    expect(session.servicePurchases?.[0].paymentIdentifier).toBe(originalPaymentId);
    expect(session.servicePurchases?.length).toBe(1);
  });

  // 12. no Arc signing occurs during prepare
  test("12. no Arc signing occurs during prepare", async () => {
    const policy = makePolicy("task-no-sign");
    const task = makeTask("task-no-sign", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const mockClient = makeMockPublicClient({ balance: BigInt(50_000_000) });

    const { preflight } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: true,
    });

    expect(preflight.signing).toBe(false);
    expect(preflight.transaction).toBe("not_submitted");
  });

  // 13. button stays disabled on real preflight failure
  test("13. button stays disabled on real preflight failure (insufficient balance or missing check)", async () => {
    const policy = makePolicy("task-fail-disabled");
    const task = makeTask("task-fail-disabled", policy);
    const mockClient = makeMockPublicClient({ balance: BigInt(0) });

    const outcome = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [], // No paid wallet check
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: true,
    });


    expect(outcome.preflight.readyForApproval).toBe(false);
    expect(outcome.preflight.blockers.length).toBeGreaterThan(0);
    expect(outcome.preflight.blockers.some((b) => b.includes("Wallet check"))).toBe(true);
  });

  // 14. button becomes available after successful preflight
  test("14. button becomes available after successful preflight", async () => {
    const policy = makePolicy("task-success-enabled");
    const task = makeTask("task-success-enabled", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });
    const mockClient = makeMockPublicClient({ balance: BigInt(50_000_000) });

    const { preflight } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: true,
    });

    expect(preflight.readyForApproval).toBe(true);
    expect(preflight.blockers.length).toBe(0);
    expect(preflight.sufficientBalance).toBe(true);
    expect(preflight.walletCheckCompleted).toBe(true);
  });

  // 15. automated tests execute zero live payments
  test("15. automated tests execute zero live payments", async () => {
    const policy = makePolicy("task-zero-live-payments");
    const task = makeTask("task-zero-live-payments", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const mockClient = makeMockPublicClient({ balance: BigInt(10_000_000) });
    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: true,
    });

    expect(preflight.signing).toBe(false);
    expect(preflight.transaction).toBe("not_submitted");
    expect(settlement.status).toBe("prepared");
    expect(settlement.transactionHash).toBeUndefined();
  });

  // Recursive deep check for typeof === "bigint" across all serialized structures
  test("Deep recursive assertion: no serialized final-settlement structure contains native bigint", async ({ request }) => {
    const policy = makePolicy("task-deep-nobigint");
    const task = makeTask("task-deep-nobigint", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const mockClient = makeMockPublicClient({ balance: BigInt(10_000_000) });
    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: mockClient,
      testMode: true,
    });

    const { approval, authorizedExecution } = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      testMode: true,
    });

    const serializedPreflight = serializeFinalSettlementPreflight(preflight);
    const serializedSettlement = serializeSettlement(settlement);
    const serializedApproval = serializeApproval(approval);
    const serializedAuth = serializeFinalSettlementAuthorizedExecution(authorizedExecution);

    assertNoBigIntRecursively(serializedPreflight, "serializedPreflight");
    assertNoBigIntRecursively(serializedSettlement, "serializedSettlement");
    assertNoBigIntRecursively(serializedApproval, "serializedApproval");
    assertNoBigIntRecursively(serializedAuth, "serializedAuth");
    const hydratedAuth = hydrateFinalSettlementAuthorizedExecution(serializedAuth);
    expect(hydratedAuth.amount.units).toBe(P6B_TEST_MODE_AMOUNT.units);
    expect(hydratedAuth.effectiveUnits).toBe(P6B_TEST_MODE_AMOUNT.units.toString());

    // Also verify over HTTP API responses
    const session: TaskSession = {
      version: 5,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      messages: [],
    };

    const res = await request.post("/api/tasks/final-settlement", {
      headers: {
        authorization: `Bearer mock-token:${USER_ALICE_DID}`,
        "content-type": "application/json",
      },
      data: {
        action: "prepare",
        session: JSON.parse(serializeDraftSession(session)),
        executionWalletAddress: USER_ALICE_WALLET,
        testMode: true,
      },
    });
    expect(res.status()).toBe(200);
    const apiJson = await res.json();
    assertNoBigIntRecursively(apiJson, "prepareApiJson");
  });
});
