import type { PublicClient } from "viem";
import { expect, test } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  formatMoney,
  money,
  transitionTask,
  type ApprovalRecord,
  type FinancialTask,
  type ServicePurchase,
  type SettlementExecution,
  type TaskPolicy,
} from "../src/lib/domain";
import { parseFinancialIntent } from "../src/lib/intent";
import {
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  approveFinalSettlement,
  assertSettlementMatchesTaskTruth,
  reconcileFinalSettlementOnchain,
  recordFinalSettlementSubmission,
  runFinalSettlementPreflight,
  P6B_TEST_MODE_AMOUNT,
} from "../src/lib/settlement/final/service";
import {
  ARC_TESTNET_NAME,
} from "../src/lib/settlement/arc/config";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import { TASK_SESSION_VERSION, type TaskSession } from "../src/lib/tasks/session";


const NOW = "2026-09-08T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-p6b";
const USER_BOB_DID = "did:privy:bob-p6b";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const CONTRACTOR_WALLET = "0x2222222222222222222222222222222222222222" as const;

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
    readContract: async () => opts.balance ?? BigInt(0),
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

test.describe("P6B Flagship Final-Payment Approval Gate & Arc Settlement", () => {
  // 1. final settlement cannot prepare before required wallet check is paid
  test("1. final settlement cannot prepare before required wallet check is paid", async () => {
    const policy = makePolicy("task-no-check");
    const task = makeTask("task-no-check", policy);

    // No service purchases
    const outcome1 = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });
    expect(outcome1.preflight.walletCheckCompleted).toBe(false);
    expect(outcome1.preflight.readyForApproval).toBe(false);
    expect(outcome1.preflight.blockers).toContain(
      "Wallet check must be confirmed and paid before final payment",
    );

    // Failed service purchase
    const failedPurchase = createServicePurchase({
      id: "purchase-failed",
      taskId: task.id,
      serviceId: WALLET_ACTIVITY_SERVICE_ID,
      quotedAmount: money("0.003", "USD"),
      policySnapshot: policy,
      status: "failed",
    });

    const outcome2 = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [failedPurchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });
    expect(outcome2.preflight.walletCheckCompleted).toBe(false);
    expect(outcome2.preflight.readyForApproval).toBe(false);
  });

  // 2. final amount resolves to 50 USDC, not $0.05
  test("2. final amount resolves to 50 USDC, not $0.05", async () => {
    const policy = makePolicy("task-amount-50");
    const task = makeTask("task-amount-50", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { preflight } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(preflight.amount.units).toBe(BigInt(50_000_000));
    expect(preflight.amount.asset).toBe("USDC");
    expect(preflight.amount.decimals).toBe(6);
    expect(formatMoney(preflight.amount)).toBe("50");
    expect(preflight.amount.asset).not.toBe("USD");
  });

  // 3. service budget remains separate
  test("3. service budget remains separate from 50 USDC contractor payment", async () => {
    const policy = makePolicy("task-budget-separate");
    const task = makeTask("task-budget-separate", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { preflight } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(formatMoney(preflight.serviceAmountSpent)).toBe("0.003");
    expect(preflight.serviceAmountSpent.asset).toBe("USD");
    expect(formatMoney(preflight.serviceBudgetRemaining)).toBe("0.047");
    expect(preflight.serviceBudgetRemaining.asset).toBe("USD");

    // Contractor payment is still exactly 50 USDC:
    expect(formatMoney(preflight.amount)).toBe("50");
    expect(preflight.amount.asset).toBe("USDC");
  });

  // 4. final settlement uses task recipient exactly
  test("4. final settlement uses task recipient exactly", async () => {
    const policy = makePolicy("task-recipient-exact");
    const task = makeTask("task-recipient-exact", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(settlement.recipient.toLowerCase()).toBe(CONTRACTOR_WALLET.toLowerCase());

    // Mismatched recipient fails assertion:
    const forgedSettlement: SettlementExecution = {
      ...settlement,
      recipient: "0x9999999999999999999999999999999999999999",
    };
    expect(() =>
      assertSettlementMatchesTaskTruth(forgedSettlement, task, policy),
    ).toThrow(/does not match task recipient/);
  });

  // 5. final source is primaryExecutionWallet
  test("5. final source is primaryExecutionWallet", async () => {
    const policy = makePolicy("task-source-wallet");
    const task = makeTask("task-source-wallet", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { preflight, settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(preflight.executionWallet.toLowerCase()).toBe(USER_ALICE_WALLET.toLowerCase());

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });
    const { approval, authorizedExecution } = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(approval.walletAddress.toLowerCase()).toBe(USER_ALICE_WALLET.toLowerCase());
    expect(authorizedExecution.sourceWallet.toLowerCase()).toBe(USER_ALICE_WALLET.toLowerCase());
  });

  // 6. external wallet cannot replace it
  test("6. external wallet cannot replace execution wallet in approval", async () => {
    const policy = makePolicy("task-no-external");
    const task = makeTask("task-no-external", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    const EXTERNAL_WALLET = "0x9999999999999999999999999999999999999999" as const;

    // Approving with an external wallet creates an approval that does not match task execution wallet
    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });
    // Approving with an external wallet must be REJECTED fail-closed:
    expect(() =>
      approveFinalSettlement({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement,
        executionWalletAddress: EXTERNAL_WALLET,
        ownerSubject: USER_ALICE_DID,
      }),
    ).toThrow(/does not match task primary execution wallet/);

    // Preflight with external wallet must also block approval:
    const extPreflight = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: EXTERNAL_WALLET,
      ownerSubject: USER_ALICE_DID,
    });
    expect(extPreflight.preflight.readyForApproval).toBe(false);
    expect(
      extPreflight.preflight.blockers.some((b) =>
        b.includes("does not match task primary execution wallet"),
      ),
    ).toBe(true);
  });

  // 7. unauthenticated execution rejected
  test("7. unauthenticated execution rejected at API route", async ({ request }) => {
    const res = await request.post("/api/tasks/final-settlement", {
      data: { action: "prepare" },
    });
    expect(res.status()).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("missing bearer access token");
  });

  // 8. wrong owner rejected
  test("8. wrong owner rejected at API route", async ({ request }) => {
    const policy = makePolicy("task-wrong-owner");
    const task = makeTask("task-wrong-owner", policy);
    const session: TaskSession = {
      version: 5,
      ownerSubject: USER_BOB_DID,
      task: { ...task, ownerId: USER_BOB_DID, ownerSubject: USER_BOB_DID },
      policy,
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
        ownerSubject: USER_BOB_DID,
        executionWalletAddress: USER_ALICE_WALLET,
      },
    });

    expect(res.status()).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("does not match authenticated token subject");
  });

  // 9. preflight never signs
  test("9. preflight never signs and never submits", async () => {
    const policy = makePolicy("task-preflight-nosign");
    const task = makeTask("task-preflight-nosign", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { preflight } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(preflight.signing).toBe(false);
    expect(preflight.transaction).toBe("not_submitted");
  });

  // 10. insufficient balance blocks payment
  test("10. insufficient balance blocks payment truthfully", async () => {
    const policy = makePolicy("task-insufficient-bal");
    const task = makeTask("task-insufficient-bal", policy);
    const purchase = makePaidPurchase(task.id, policy);

    // Empty address with 0 balance
    const EMPTY_WALLET = "0x000000000000000000000000000000000000dEaD" as const;

    const { preflight } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: EMPTY_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeMockPublicClient({ balance: BigInt(0) }),
      testMode: false, // 50 USDC requested
    });

    expect(preflight.sufficientBalance).toBe(false);
    expect(preflight.readyForApproval).toBe(false);
    expect(preflight.blockers.some((b) => b.includes("Insufficient Arc USDC wallet balance"))).toBe(true);
  });

  // 11. approval is bound to exact settlement parameters
  test("11. approval is bound to exact settlement parameters", async () => {
    const policy = makePolicy("task-bound-approval");
    const task = makeTask("task-bound-approval", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const { approval } = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    expect(approval.taskId).toBe(task.id);
    expect(approval.settlementExecutionId).toBe(settlement.id);
    expect(approval.amount.units).toBe(settlement.amount.units);
    expect(approval.amount.asset).toBe(settlement.amount.asset);
    expect(approval.recipient.toLowerCase()).toBe(settlement.recipient.toLowerCase());
    expect(approval.network).toBe(settlement.network);
    expect(approval.decision).toBe("approved");
  });

  // 12. changed recipient invalidates approval
  test("12. changed recipient invalidates approval", async () => {
    const policy = makePolicy("task-tamper-recipient");
    const task = makeTask("task-tamper-recipient", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const { approval } = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    // Tampered settlement recipient
    const tamperedSettlement: SettlementExecution = {
      ...settlement,
      recipient: "0x3333333333333333333333333333333333333333",
    };

    expect(() =>
      assertSettlementMatchesTaskTruth(tamperedSettlement, task, policy),
    ).toThrow(/does not match task recipient/);

    expect(() =>
      recordFinalSettlementSubmission({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement: tamperedSettlement,
        approval,
        transactionHash: "0xtest123",
      }),
    ).toThrow();
  });

  // 13. changed amount invalidates approval
  test("13. changed amount invalidates approval", async () => {
    const policy = makePolicy("task-tamper-amount");
    const task = makeTask("task-tamper-amount", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const { approval } = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    // Tampered settlement amount (e.g. changed to 100 USDC)
    const tamperedSettlement: SettlementExecution = {
      ...settlement,
      amount: money("100", "USDC"),
    };

    expect(() =>
      assertSettlementMatchesTaskTruth(tamperedSettlement, task, policy),
    ).toThrow(/does not match authoritative task payment amount/);

    expect(() =>
      recordFinalSettlementSubmission({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement: tamperedSettlement,
        approval,
        transactionHash: "0xtest123",
      }),
    ).toThrow();
  });

  // 14. no transaction before explicit approval
  test("14. no transaction before explicit approval", () => {
    const policy = makePolicy("task-no-approval-submit");
    const task = makeTask("task-no-approval-submit", policy);
    const running = transitionTask(transitionTask(task, "planned"), "running");

    const settlement: SettlementExecution = {
      id: "settlement-unapproved",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "prepared",
      createdAt: NOW,
      updatedAt: NOW,
    };

    // Submitting without transitioning to submitting (which requires approval) fails domain transition
    expect(() =>
      recordFinalSettlementSubmission({
        task: running,
        policy,
        servicePurchases: [],
        settlement,
        approval: undefined as unknown as ApprovalRecord,
        transactionHash: "0x123",
      }),
    ).toThrow();
  });

  // 15. duplicate approval cannot submit twice
  test("15. duplicate submission cannot submit twice", async () => {
    const policy = makePolicy("task-dup-submit");
    const task = makeTask("task-dup-submit", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const { approval, settlement: submitting, task: settling } =
      approveFinalSettlement({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
      });

    const { settlement: confirming } = recordFinalSettlementSubmission({
      task: settling,
      policy,
      servicePurchases: [purchase],
      settlement: submitting,
      approval,
      transactionHash: "0xhash_first",
    });

    expect(confirming.status).toBe("confirming");
    expect(confirming.transactionHash).toBe("0xhash_first");

    // Attempting to submit again throws SETTLEMENT_RESUBMISSION_FORBIDDEN:
    expect(() =>
      recordFinalSettlementSubmission({
        task: settling,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        transactionHash: "0xhash_second",
      }),
    ).toThrow(/cannot transition settlement from confirming to submitted/);
  });

  // 16. tx hash persisted immediately
  test("16. tx hash persisted immediately upon submission", async () => {
    const policy = makePolicy("task-persist-hash");
    const task = makeTask("task-persist-hash", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const { approval, settlement: submitting, task: settling } =
      approveFinalSettlement({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
      });

    const { settlement: submitted } = recordFinalSettlementSubmission({
      task: settling,
      policy,
      servicePurchases: [purchase],
      settlement: submitting,
      approval,
      transactionHash: "0ximmediate_persisted_hash",
    });

    expect(submitted.transactionHash).toBe("0ximmediate_persisted_hash");
    expect(["submitted", "confirming"]).toContain(submitted.status);
  });

  // 17. refresh after submission cannot resubmit
  test("17. refresh after submission cannot resubmit", async () => {
    const policy = makePolicy("task-refresh-no-resubmit");
    const task = makeTask("task-refresh-no-resubmit", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    const settlementInput: SettlementExecution = {
      id: "settlement-refresh",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirming",
      transactionHash: "0xalready_submitted_hash",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const approval = createApprovalRecord({
      id: "approval-refresh",
      taskId: task.id,
      settlementExecutionId: settlementInput.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: settlementInput.amount,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: transitionTask(awaiting, "settling", {
        approval,
        serviceWork: { policy, purchases: [purchase] },
        now: NOW,
      }),
      policy,
      servicePurchases: [purchase],
      settlement: settlementInput,
      approval,
    };

    const serialized = serializeDraftSession(session);
    const hydrated = hydrateDraftSession(serialized, undefined, {
      expectedOwnerSubject: USER_ALICE_DID,
    });

    expect(hydrated?.settlement?.status).toBe("confirming");
    expect(() =>
      recordFinalSettlementSubmission({
        task: hydrated!.task!,
        policy,
        servicePurchases: [purchase],
        settlement: hydrated!.settlement!,
        approval: hydrated!.approval!,
        transactionHash: "0xnew_attempt_forbidden",
      }),
    ).toThrow();
  });

  // 18. confirmation delayed only reconciles read-only
  test("18. confirmation delayed only reconciles read-only and never double-sends", async () => {
    const policy = makePolicy("task-confirm-delayed");
    const task = makeTask("task-confirm-delayed", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement: SettlementExecution = {
      id: "settlement-delayed",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirming",
      transactionHash: "0xpending_delayed_tx",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const approval = createApprovalRecord({
      id: "approval-delayed",
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

    // Reconciling when onchain receipt is null:
    const result = await reconcileFinalSettlementOnchain({
      task: transitionTask(transitionTask(task, "planned"), "running"),
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.settlement.transactionHash).toBe("0xpending_delayed_tx");
    expect(result.task.status).not.toBe("completed");
  });

  // 19. confirmed receipt completes task exactly once
  test("19. confirmed receipt completes task exactly once", () => {
    const policy = makePolicy("task-confirm-receipt");
    const task = makeTask("task-confirm-receipt", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement: SettlementExecution = {
      id: "settlement-receipt-success",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirming",
      transactionHash: "0xconfirmed_receipt_hash",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const approval = createApprovalRecord({
      id: "approval-receipt",
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

    const evidence = Object.freeze({
      source: "reconciliation" as const,
      transactionHash: settlement.transactionHash!,
      outcome: "confirmed" as const,
      observedAt: NOW,
      receiptReference: "100500",
    });

    const completed = transitionTask(settling, "completed", {
      settlement: {
        status: "confirmed",
        transactionHash: settlement.transactionHash!,
        confirmationEvidence: evidence,
      },
      approval,
      now: NOW,
    });

    expect(completed.status).toBe("completed");
    expect(completed.id).toBe(task.id);

    // Cannot transition completed task again
    expect(() =>
      transitionTask(completed, "settling", { now: NOW }),
    ).toThrow(/cannot transition task from completed to settling/);
  });

  // 20. reverted tx does not become success
  test("20. reverted tx does not become success", () => {
    const policy = makePolicy("task-reverted-tx");
    const task = makeTask("task-reverted-tx", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement: SettlementExecution = {
      id: "settlement-reverted",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirming",
      transactionHash: "0xreverted_tx_hash",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const evidence = Object.freeze({
      source: "reconciliation" as const,
      transactionHash: settlement.transactionHash!,
      outcome: "reverted" as const,
      observedAt: NOW,
    });

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const awaiting = transitionTask(running, "awaiting_approval", {
      serviceWork: { policy, purchases: [purchase] },
      now: NOW,
    });

    // Reverted settlement cannot complete the task
    expect(() =>
      transitionTask(awaiting, "completed", {
        settlement: {
          status: "reverted",
          transactionHash: settlement.transactionHash!,
          confirmationEvidence: evidence,
        },
        now: NOW,
      }),
    ).toThrow(/cannot transition task from awaiting_approval to completed/);
  });

  // 21. proof contains both Hedera service payment and Arc final payment
  test("21. proof contains both Hedera service payment and Arc final payment", () => {
    const policy = makePolicy("task-proof-complete");
    const task = makeTask("task-proof-complete", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement: SettlementExecution = {
      id: "settlement-proof",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
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
      id: "approval-proof",
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

    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: completed,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
    };

    const serialized = serializeDraftSession(session);
    const hydrated = hydrateDraftSession(serialized, undefined, {
      expectedOwnerSubject: USER_ALICE_DID,
    });

    expect(hydrated?.task?.status).toBe("completed");
    expect(hydrated?.settlement?.status).toBe("confirmed");
    expect(hydrated?.settlement?.transactionHash).toBe("0xfinal_proof_arc_hash");
    expect(hydrated?.servicePurchases?.[0].settlementNetwork).toBe(HEDERA_TESTNET_NETWORK);
    expect(hydrated?.servicePurchases?.[0].paymentIdentifier).toBe("0.0.7162784@1788908433.043020353");
  });

  // 22. secrets never persist
  test("22. secrets, private keys, and bearer tokens never persist in session or proof", () => {
    const policy = makePolicy("task-clean-privacy");
    const task = makeTask("task-clean-privacy", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement: SettlementExecution = {
      id: "settlement-clean",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
      status: "confirmed",
      transactionHash: "0xclean_hash",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const approval = createApprovalRecord({
      id: "approval-clean",
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

    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
    };

    const serialized = serializeDraftSession(session);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("PAYMENT-SIGNATURE");
    expect(serialized).not.toContain("mnemonic");
  });

  // 23. automated tests make zero live payments
  test("23. automated tests make zero live payments", async () => {
    const policy = makePolicy("task-zero-live");
    const task = makeTask("task-zero-live", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const { preflight, settlement } = await runFinalSettlementPreflight({
      task,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      testMode: true,
    });

    // Test mode caps effective amount to 0.01 USDC without live transfer
    expect(preflight.testMode).toBe(true);
    expect(preflight.effectivePaymentAmount.units).toBe(P6B_TEST_MODE_AMOUNT.units);
    expect(settlement.amount.units).toBe(P6B_TEST_MODE_AMOUNT.units);
  });

  // 24. canonical flagship sentence parses without clarification
  test("24. canonical flagship sentence parses without clarification", () => {
    const res1 = parseFinancialIntent(
      `Pay this contractor ${CONTRACTOR_WALLET} 50 USDC, but check the wallet first. Spend no more than $0.05 checking.`,
    );
    expect(res1.status).toBe("ready");
    expect(res1.intentType).toBe("pay_with_check");
    expect(formatMoney(res1.fields.paymentAmount!)).toBe("50");
    expect(res1.fields.paymentAmount?.asset).toBe("USDC");
    expect(formatMoney(res1.fields.serviceBudget!)).toBe("0.05");
    expect(res1.fields.serviceBudget?.asset).toBe("USD");
    expect(res1.fields.recipient).toBe(CONTRACTOR_WALLET);

    const res2 = parseFinancialIntent(
      `Pay ${CONTRACTOR_WALLET} 50 USDC, spend no more than $0.05 checking.`,
    );
    expect(res2.status).toBe("ready");
    expect(res2.intentType).toBe("pay_with_check");
    expect(formatMoney(res2.fields.paymentAmount!)).toBe("50");
    expect(formatMoney(res2.fields.serviceBudget!)).toBe("0.05");

    const res3 = parseFinancialIntent(
      `$0.05 check budget, then pay 50 USDC to ${CONTRACTOR_WALLET}.`,
    );
    expect(res3.status).toBe("ready");
    expect(res3.intentType).toBe("pay_with_check");
    expect(formatMoney(res3.fields.paymentAmount!)).toBe("50");
    expect(formatMoney(res3.fields.serviceBudget!)).toBe("0.05");

    const res4 = parseFinancialIntent(
      `Pay 50 USDC to ${CONTRACTOR_WALLET} after a wallet check capped at $0.05.`,
    );
    expect(res4.status).toBe("ready");
    expect(res4.intentType).toBe("pay_with_check");
    expect(formatMoney(res4.fields.paymentAmount!)).toBe("50");
    expect(formatMoney(res4.fields.serviceBudget!)).toBe("0.05");
  });
});
