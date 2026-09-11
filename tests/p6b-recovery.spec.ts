import type { PublicClient } from "viem";
import { expect, test } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createSettlementExecution,
  createTaskPolicy,
  formatMoney,
  money,
  transitionSettlement,
  transitionTask,
  type ApprovalRecord,
  type FinancialTask,
  type ServicePurchase,
  type SettlementStatus,
  type TaskPolicy,
} from "../src/lib/domain";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services";
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
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  ARC_TESTNET_USDC_ADDRESS,
} from "../src/lib/settlement/arc/config";
import {
  verifyArcScanTxEvidence,
  type ArcScanLog,
  type ArcScanTxInfoResult,
} from "../src/lib/settlement/arc/fallback";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import { serviceRegistry } from "../src/lib/services/registry";
import type { TaskSession } from "../src/lib/tasks/session";

const NOW = "2026-09-10T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-recovery";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const CONTRACTOR_WALLET = "0x2222222222222222222222222222222222222222" as const;
const LIVE_RECORDED_HASH =
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

function makeAwaitingTask(
  task: FinancialTask,
  policy: TaskPolicy,
  purchase: ServicePurchase,
): FinancialTask {
  const running = transitionTask(transitionTask(task, "planned"), "running");
  return transitionTask(running, "awaiting_approval", {
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
}

function makeSettlingTask(
  task: FinancialTask,
  policy: TaskPolicy,
  purchase: ServicePurchase,
  approval: ApprovalRecord,
): FinancialTask {
  const awaiting = makeAwaitingTask(task, policy, purchase);
  return transitionTask(awaiting, "settling", {
    approval,
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
}

function createReceiptLog(opts: {
  contract?: string;
  from?: string;
  to?: string;
  units?: bigint;
}) {
  const contract = opts.contract ?? ARC_TESTNET_USDC_ADDRESS;
  const from = (opts.from ?? USER_ALICE_WALLET).toLowerCase().replace("0x", "");
  const to = (opts.to ?? CONTRACTOR_WALLET).toLowerCase().replace("0x", "");
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const fromTopic = `0x000000000000000000000000${from}`;
  const toTopic = `0x000000000000000000000000${to}`;
  const dataHex = `0x${(opts.units ?? BigInt(10_000)).toString(16)}`;

  return {
    address: contract,
    topics: [transferTopic, fromTopic, toTopic],
    data: dataHex,
  };
}
function createFallbackTxInfo(opts: {
  hash?: string;
  success?: boolean;
  blockNumber?: string;
  from?: string;
  to?: string;
  contract?: string;
  units?: bigint;
  gasUsed?: string;
  gasPrice?: string;
} = {}): ArcScanTxInfoResult {
  const hash = opts.hash ?? LIVE_RECORDED_HASH;
  const from = opts.from ?? USER_ALICE_WALLET;
  const to = opts.to ?? CONTRACTOR_WALLET;
  const contract = opts.contract ?? ARC_TESTNET_USDC_ADDRESS;
  const units = opts.units ?? BigInt(10_000);
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const fromTopic = `0x000000000000000000000000${from.toLowerCase().replace("0x", "")}`;
  const toTopic = `0x000000000000000000000000${to.toLowerCase().replace("0x", "")}`;

  const logs: ArcScanLog[] = [
    {
      address: "0xfffffffffffffffffffffffffffffffffffffffe",
      topics: [transferTopic, fromTopic, toTopic, null],
      data: "0x000000000000000000000000000000000000000000000000002386f26fc10000",
      index: "32",
    },
    {
      address: contract,
      topics: [transferTopic, fromTopic, toTopic, null],
      data: `0x${units.toString(16)}`,
      index: "33",
    },
  ];

  return Object.freeze({
    blockNumber: opts.blockNumber ?? "61303876",
    confirmations: "185600",
    from,
    to: contract,
    hash,
    gasUsed: opts.gasUsed ?? "48938",
    gasPrice: opts.gasPrice ?? "25000000000",
    success: opts.success ?? true,
    logs: Object.freeze(logs),
  });
}

test.describe("P6B.3 Test Mode Reconciliation & Ambiguous Arc Submission Recovery", () => {
  // 1. normal 50 USDC mode requires exact 50 USDC onchain
  test("1. normal 50 USDC mode requires exact 50 USDC onchain", () => {
    const policy = makePolicy("task-1-normal-mode");
    const task = makeTask("task-1-normal-mode", policy);

    // Settlement with 0.01 in normal mode must fail
    const testAmountSettlement = createSettlementExecution({
      id: "settlement-1",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: false,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    expect(() =>
      assertSettlementMatchesTaskTruth(testAmountSettlement, task, policy, false),
    ).toThrowError("settlement amount does not match authoritative task payment amount");

    // Settlement with exact 50 USDC passes
    const exact50Settlement = createSettlementExecution({
      id: "settlement-50",
      taskId: task.id,
      provider: "circle_arc",
      amount: money("50", "USDC"),
      requestedAmount: money("50", "USDC"),
      executionAmount: money("50", "USDC"),
      testMode: false,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    expect(() =>
      assertSettlementMatchesTaskTruth(exact50Settlement, task, policy, false),
    ).not.toThrow();
  });

  // 2. test mode stores requested 50 and execution 0.01 separately
  test("2. test mode stores requested 50 and execution 0.01 separately without mutating task amount", async () => {
    const policy = makePolicy("task-2-separate-amounts");
    const task = makeTask("task-2-separate-amounts", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaitingTask = makeAwaitingTask(task, policy, purchase);

    const mockClient = {
      getChainId: async () => ARC_TESTNET_CHAIN_ID,
      readContract: async () => BigInt(10_000_000), // 10 USDC
    } as unknown as PublicClient;

    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: awaitingTask,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      testMode: true,
      publicClient: mockClient,
      now: NOW,
    });

    // Task amount is intact
    expect(awaitingTask.paymentAmount?.units).toBe(BigInt(50_000_000));
    expect(formatMoney(awaitingTask.paymentAmount!)).toBe("50");

    // Preflight has separate requested vs effective amounts
    expect(preflight.amount.units).toBe(BigInt(50_000_000));
    expect(preflight.effectivePaymentAmount.units).toBe(BigInt(10_000));
    expect(preflight.testMode).toBe(true);

    // Settlement stores both requested and execution amounts
    expect(settlement.requestedAmount?.units).toBe(BigInt(50_000_000));
    expect(settlement.executionAmount?.units).toBe(BigInt(10_000));
    expect(settlement.amount.units).toBe(BigInt(10_000));
    expect(settlement.testMode).toBe(true);
  });

  // 3. test mode accepts 10,000 atomic only when explicitly authorized
  test("3. test mode accepts 10,000 atomic only when explicitly authorized", () => {
    const policy = makePolicy("task-3-authorized");
    const task = makeTask("task-3-authorized", policy);

    const settlementAuthorized = createSettlementExecution({
      id: "settlement-auth",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    // When authorized as test mode, passes
    expect(() =>
      assertSettlementMatchesTaskTruth(settlementAuthorized, task, policy, true),
    ).not.toThrow();

    // When test mode is NOT authorized, 10,000 atomic is rejected
    const settlementUnauthorized = createSettlementExecution({
      id: "settlement-unauth",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: false,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    expect(() =>
      assertSettlementMatchesTaskTruth(settlementUnauthorized, task, policy, false),
    ).toThrowError("settlement amount does not match authoritative task payment amount");
  });

  // 4. any other onchain amount fails
  test("4. any other onchain amount fails in test mode", async () => {
    const policy = makePolicy("task-4-wrong-amount");
    const task = makeTask("task-4-wrong-amount", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-wrong-amount",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-wrong-amount",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const submitting = transitionSettlement(settlement, "submitting", { approval, now: NOW });
    const submitted = transitionSettlement(submitting, "submitted", {
      transactionHash: "0xamount_test_hash",
      now: NOW,
    });
    const confirming = transitionSettlement(submitted, "confirming", { now: NOW });

    // Mock receipt with 20,000 atomic units instead of 10,000
    const wrongAmountClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(100),
        logs: [createReceiptLog({ units: BigInt(20_000) })],
      }),
    } as unknown as PublicClient;

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: wrongAmountClient,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 5. source mismatch fails
  test("5. source mismatch fails", async () => {
    const policy = makePolicy("task-5-source-mismatch");
    const task = makeTask("task-5-source-mismatch", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-5",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-5",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: "0xsource_test", now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    // From address in log is an unauthorized address
    const wrongSourceClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(101),
        logs: [
          createReceiptLog({
            from: "0x9999999999999999999999999999999999999999",
            units: BigInt(10_000),
          }),
        ],
      }),
    } as unknown as PublicClient;

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: wrongSourceClient,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 6. recipient mismatch fails
  test("6. recipient mismatch fails", async () => {
    const policy = makePolicy("task-6-recipient-mismatch");
    const task = makeTask("task-6-recipient-mismatch", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-6",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-6",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: "0xrecip_test", now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    // To address in log does not match recipient
    const wrongRecipientClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(102),
        logs: [
          createReceiptLog({
            to: "0x8888888888888888888888888888888888888888",
            units: BigInt(10_000),
          }),
        ],
      }),
    } as unknown as PublicClient;

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: wrongRecipientClient,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 7. token mismatch fails
  test("7. token mismatch fails", async () => {
    const policy = makePolicy("task-7-token-mismatch");
    const task = makeTask("task-7-token-mismatch", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-7",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-7",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: "0xtoken_test", now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    // Contract address is not ARC_TESTNET_USDC_ADDRESS
    const wrongTokenClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(103),
        logs: [
          createReceiptLog({
            contract: "0x7777777777777777777777777777777777777777",
            units: BigInt(10_000),
          }),
        ],
      }),
    } as unknown as PublicClient;

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: wrongTokenClient,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 8. wrong chain fails
  test("8. wrong chain fails", async () => {
    const policy = makePolicy("task-8-wrong-chain");
    const task = makeTask("task-8-wrong-chain", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaitingTask = makeAwaitingTask(task, policy, purchase);

    const wrongChainClient = {
      getChainId: async () => 1, // Mainnet instead of Arc Testnet 5042002
      readContract: async () => BigInt(10_000_000),
    } as unknown as PublicClient;

    const { preflight } = await runFinalSettlementPreflight({
      task: awaitingTask,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      testMode: true,
      publicClient: wrongChainClient,
      now: NOW,
    });

    expect(preflight.readyForApproval).toBe(false);
    expect(preflight.arcChainReadiness).toBe(false);
  });

  // 9. test-mode approval stores requested + execution amounts
  test("9. test-mode approval stores requested + execution amounts", () => {
    const policy = makePolicy("task-9-approval-binding");
    const task = makeTask("task-9-approval-binding", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaitingTask = makeAwaitingTask(task, policy, purchase);

    const settlement = createSettlementExecution({
      id: "settlement-9",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const { approval, authorizedExecution } = approveFinalSettlement({
      task: awaitingTask,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      testMode: true,
      now: NOW,
    });

    // Approval binds both requested 50 USDC and authorized test 0.01 USDC
    expect(approval.requestedAmount?.units).toBe(BigInt(50_000_000));
    expect(approval.executionAmount?.units).toBe(BigInt(10_000));
    expect(approval.testMode).toBe(true);

    // Authorized execution for wallet signs only 0.01 USDC
    expect(authorizedExecution.effectiveUnits).toBe(BigInt(10_000).toString());
    expect(authorizedExecution.testMode).toBe(true);
  });

  // 10. wallet/provider return value is classified explicitly
  test("10. wallet/provider return value is classified explicitly", () => {
    expect(LIVE_RECORDED_HASH.startsWith("0x")).toBe(true);
    expect(LIVE_RECORDED_HASH.length).toBe(66);

    const policy = makePolicy("task-10-classify");
    const task = makeTask("task-10-classify", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaitingTask = makeAwaitingTask(task, policy, purchase);

    const settlement = createSettlementExecution({
      id: "settlement-10",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const { settlement: submittingSettlement, task: settlingTask } =
      approveFinalSettlement({
        task: awaitingTask,
        policy,
        servicePurchases: [purchase],
        settlement,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
        testMode: true,
        now: NOW,
      });

    const approval = createApprovalRecord({
      id: "approval-10",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const { settlement: submittedSettlement } = recordFinalSettlementSubmission({
      task: settlingTask,
      policy,
      settlement: submittingSettlement,
      approval,
      transactionHash: LIVE_RECORDED_HASH,
      testMode: true,
      now: NOW,
    });

    expect(submittedSettlement.transactionHash).toBe(LIVE_RECORDED_HASH);
    expect(submittedSettlement.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
  });

  // 11. transaction visible + receipt null -> receipt pending
  test("11. transaction visible + receipt null -> receipt pending", async () => {
    const policy = makePolicy("task-11-receipt-pending");
    const task = makeTask("task-11-receipt-pending", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-11",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-11",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    // Mock client where getTransaction returns a valid tx, but getTransactionReceipt returns null
    const receiptPendingClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => ({
        hash: LIVE_RECORDED_HASH,
        from: USER_ALICE_WALLET,
        to: ARC_TESTNET_USDC_ADDRESS,
      }),
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: receiptPendingClient,
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.reconciliationState).toBe("HASH_RECORDED_RECEIPT_PENDING");
    expect(result.settlement.reconciliationState).toBe("HASH_RECORDED_RECEIPT_PENDING");
  });

  // 12. transaction null + receipt null -> chain unobserved
  test("12. transaction null + receipt null -> chain unobserved", async () => {
    const policy = makePolicy("task-12-chain-unobserved");
    const task = makeTask("task-12-chain-unobserved", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-12",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-12",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    // Mock client where BOTH getTransaction and getTransactionReceipt return null
    const chainUnobservedClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: chainUnobservedClient,
      fallbackTxInfoFetcher: async () => null,
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
    expect(result.settlement.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
    expect(result.message).toContain("Arc Testnet has not observed the transaction yet");
  });

  // 13. chain unobserved never confirms or reverts
  test("13. chain unobserved never confirms or reverts", async () => {
    const policy = makePolicy("task-13-no-false-outcome");
    const task = makeTask("task-13-no-false-outcome", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-13",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-13",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const client = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: client,
      fallbackTxInfoFetcher: async () => null,
      now: NOW,
    });

    expect(result.status).not.toBe("confirmed");
    expect(result.status).not.toBe("reverted");
    expect(result.settlement.status).not.toBe("confirmed");
    expect(result.settlement.status).not.toBe("reverted");
  });

  // 14. chain unobserved never auto-resubmits
  test("14. chain unobserved never auto-resubmits", () => {
    const policy = makePolicy("task-14-no-resubmit");
    const task = makeTask("task-14-no-resubmit", policy);

    const settlement = createSettlementExecution({
      id: "settlement-14",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });
    const approval = createApprovalRecord({
      id: "approval-14",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const submitting = transitionSettlement(settlement, "submitting", { approval, now: NOW });
    const submitted = transitionSettlement(submitting, "submitted", {
      transactionHash: LIVE_RECORDED_HASH,
      now: NOW,
    });
    const confirming = transitionSettlement(submitted, "confirming", {
      reconciliationState: "HASH_RECORDED_CHAIN_UNOBSERVED",
      now: NOW,
    });
    // Attempting to transition to submitting when transactionHash exists must throw
    expect(() =>
      transitionSettlement(confirming, "submitting" as SettlementStatus),
    ).toThrowError("cannot transition settlement from confirming to submitting");
  });

  // 15. refresh with recorded identifier exposes reconciliation only
  test("15. refresh with recorded identifier preserves identifier and exposes reconciliation state", () => {
    const policy = makePolicy("task-15-refresh");
    const task = makeTask("task-15-refresh", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-15",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-15",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const submittedSettlement = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { reconciliationState: "HASH_RECORDED_CHAIN_UNOBSERVED", now: NOW },
    );

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);

    const session: TaskSession = {
      version: 4,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      approval,
      settlement: submittedSettlement,
    };

    // Serialize session as would happen to localStorage
    const serialized = serializeDraftSession(session, serviceRegistry);
    // Hydrate session after refresh
    const hydrated = hydrateDraftSession(serialized, serviceRegistry, {
      expectedOwnerSubject: USER_ALICE_DID,
    });

    expect(hydrated?.settlement?.transactionHash).toBe(LIVE_RECORDED_HASH);
    expect(hydrated?.settlement?.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
    expect(hydrated?.settlement?.requestedAmount?.units).toBe(BigInt(50_000_000));
    expect(hydrated?.settlement?.executionAmount?.units).toBe(BigInt(10_000));
    expect(hydrated?.settlement?.testMode).toBe(true);
  });

  // 16. read-only reconciliation sends zero eth_sendTransaction calls
  test("16. read-only reconciliation sends zero eth_sendTransaction calls", async () => {
    const policy = makePolicy("task-16-read-only");
    const task = makeTask("task-16-read-only", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-16",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-16",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    let sendTransactionCalls = 0;
    const readOnlyClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
      sendTransaction: async () => {
        sendTransactionCalls++;
        throw new Error("sendTransaction must NEVER be called during reconciliation");
      },
    } as unknown as PublicClient;

    await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: readOnlyClient,
      fallbackTxInfoFetcher: async () => null,
      now: NOW,
    });

    expect(sendTransactionCalls).toBe(0);
  });

  // 17. 0.01 test settlement never marks original 50 USDC fulfilled
  test("17. 0.01 test settlement never marks original 50 USDC fulfilled", async () => {
    const policy = makePolicy("task-17-test-truth");
    const task = makeTask("task-17-test-truth", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-17",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-17",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);

    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const successClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(500),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      }),
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: successClient,
      now: NOW,
    });

    expect(result.status).toBe("confirmed");
    expect(result.settlement.status).toBe("confirmed");
    // Task is NOT completed: original contractor payment NOT EXECUTED
    expect(result.task.status).toBe("awaiting_approval");
    expect(result.proof?.status).toBe("demo_verified");
    expect(result.proof?.demoVerificationStatus).toBe("complete");
    expect(result.proof?.originalPaymentDelivered).toBe(false);
  });

  // 18. proof distinguishes requested vs executed amount
  test("18. proof distinguishes requested vs executed amount", async () => {
    const policy = makePolicy("task-18-proof-truth");
    const task = makeTask("task-18-proof-truth", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-18",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-18",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);

    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const successClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(600),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      }),
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: successClient,
      now: NOW,
    });

    const proof = result.proof!;
    expect(proof).toBeDefined();
    // Original mandate is 50 USDC
    expect(proof.task.paymentAmount?.units).toBe(BigInt(50_000_000));
    // Test execution is 0.01 USDC
    expect(proof.finalPayment?.amount.units).toBe(BigInt(10_000));
    expect(proof.finalPayment?.requestedAmount?.units).toBe(BigInt(50_000_000));
    expect(proof.finalPayment?.executionAmount?.units).toBe(BigInt(10_000));
    // Test mode flags
    expect(proof.testMode).toBe(true);
    expect(proof.demoVerificationStatus).toBe("complete");
    expect(proof.originalPaymentDelivered).toBe(false);
  });

  // 19. automated tests execute zero live payments
  test("19. automated tests execute zero live payments", async () => {
    const policy = makePolicy("task-19-zero-live");
    const task = makeTask("task-19-zero-live", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaitingTask = makeAwaitingTask(task, policy, purchase);

    // Run full test mode flow with mock client
    const mockClient = {
      getChainId: async () => ARC_TESTNET_CHAIN_ID,
      readContract: async () => BigInt(10_000_000),
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: awaitingTask,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      testMode: true,
      publicClient: mockClient,
      now: NOW,
    });

    const { approval, authorizedExecution, settlement: approvedSettlement, task: settlingTask } =
      approveFinalSettlement({
        task: awaitingTask,
        policy,
        servicePurchases: [purchase],
        settlement,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
        testMode: true,
        now: NOW,
      });

    const { settlement: submittedSettlement } = recordFinalSettlementSubmission({
      task: settlingTask,
      policy,
      settlement: approvedSettlement,
      approval,
      transactionHash: LIVE_RECORDED_HASH,
      testMode: true,
      now: NOW,
    });

    const reconcileResult = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: submittedSettlement,
      approval,
      testMode: true,
      publicClient: mockClient,
      fallbackTxInfoFetcher: async () => null,
      now: NOW,
    });

    expect(preflight.testMode).toBe(true);
    expect(authorizedExecution.testMode).toBe(true);
    expect(reconcileResult.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
    // Zero onchain transactions broadcast
    expect(reconcileResult.status).toBe("pending");
  });
});

test.describe("P6B.4 Trusted Fallback Reconciliation for Confirmed Arc Transaction", () => {
  // 1. primary receipt confirms without fallback
  test("1. primary receipt confirms without fallback", async () => {
    const policy = makePolicy("task-fb-1-primary-only");
    const task = makeTask("task-fb-1-primary-only", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-1",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-1",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    let fallbackCalled = false;
    const primaryClient = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      }),
    } as unknown as PublicClient;

    const fallbackFetcher = async () => {
      fallbackCalled = true;
      return createFallbackTxInfo();
    };

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: primaryClient,
      fallbackTxInfoFetcher: fallbackFetcher,
      now: NOW,
    });

    expect(result.status).toBe("confirmed");
    expect(fallbackCalled).toBe(false);
    expect(result.proof?.reconciliationProvenance?.sourceType).toBe("primary_rpc");
    expect(result.proof?.reconciliationProvenance?.primaryRpcObserved).toBe(true);
    expect(result.proof?.reconciliationProvenance?.fallbackObserved).toBe(false);
  });

  // 2. primary null -> fallback success -> confirmed
  test("2. primary null -> fallback success -> confirmed", async () => {
    const policy = makePolicy("task-fb-2-fallback-success");
    const task = makeTask("task-fb-2-fallback-success", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-2",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-2",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullPrimaryClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const fallbackFetcher = async (hash: string) => createFallbackTxInfo({ hash });

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: nullPrimaryClient,
      fallbackTxInfoFetcher: fallbackFetcher,
      now: NOW,
    });

    expect(result.status).toBe("confirmed");
    expect(result.settlement.status).toBe("confirmed");
    expect(result.proof?.reconciliationProvenance?.sourceType).toBe("blockscout_api");
    expect(result.proof?.reconciliationProvenance?.primaryRpcObserved).toBe(false);
    expect(result.proof?.reconciliationProvenance?.fallbackObserved).toBe(true);
    expect(result.proof?.reconciliationProvenance?.blockNumber).toBe("61303876");
  });

  // 3. fallback validates exact tx hash
  test("3. fallback validates exact tx hash", () => {
    const fallbackTx = createFallbackTxInfo({
      hash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    expect(() =>
      verifyArcScanTxEvidence({
        txInfo: fallbackTx,
        expectedHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        expectedSourceWallet: USER_ALICE_WALLET,
        expectedRecipient: CONTRACTOR_WALLET,
        expectedUnits: BigInt(10_000),
        now: NOW,
      }),
    ).toThrowError(/does not match expected transaction hash/);

    const verified = verifyArcScanTxEvidence({
      txInfo: fallbackTx,
      expectedHash:
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      expectedSourceWallet: USER_ALICE_WALLET,
      expectedRecipient: CONTRACTOR_WALLET,
      expectedUnits: BigInt(10_000),
      now: NOW,
    });
    expect(verified.canonicalHash).toBe(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });

  // 4. fallback validates chain 5042002
  test("4. fallback validates chain 5042002", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
    expect(ARC_TESTNET_NAME).toBe("Arc Testnet");
  });

  // 5. fallback validates token contract
  test("5. fallback validates token contract", async () => {
    const policy = makePolicy("task-fb-5-token");
    const task = makeTask("task-fb-5-token", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-5",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-5",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullPrimaryClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    // Fallback log has wrong contract address
    const fallbackFetcher = async () =>
      createFallbackTxInfo({
        contract: "0x8888888888888888888888888888888888888888",
      });

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: nullPrimaryClient,
        fallbackTxInfoFetcher: fallbackFetcher,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 6. fallback validates source wallet
  test("6. fallback validates source wallet", async () => {
    const policy = makePolicy("task-fb-6-source");
    const task = makeTask("task-fb-6-source", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-6",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-6",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullPrimaryClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    // Fallback log has wrong sender
    const fallbackFetcher = async () =>
      createFallbackTxInfo({
        from: "0x7777777777777777777777777777777777777777",
      });

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: nullPrimaryClient,
        fallbackTxInfoFetcher: fallbackFetcher,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 7. fallback validates recipient
  test("7. fallback validates recipient", async () => {
    const policy = makePolicy("task-fb-7-recip");
    const task = makeTask("task-fb-7-recip", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-7",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-7",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullPrimaryClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    // Fallback log has wrong recipient
    const fallbackFetcher = async () =>
      createFallbackTxInfo({
        to: "0x6666666666666666666666666666666666666666",
      });

    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: nullPrimaryClient,
        fallbackTxInfoFetcher: fallbackFetcher,
        now: NOW,
      }),
    ).rejects.toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 8. fallback validates 10000 atomic transfer
  test("8. fallback validates 10000 atomic transfer", () => {
    const txInfo = createFallbackTxInfo({ units: BigInt(10_000) });
    const result = verifyArcScanTxEvidence({
      txInfo,
      expectedHash: txInfo.hash,
      expectedSourceWallet: USER_ALICE_WALLET,
      expectedRecipient: CONTRACTOR_WALLET,
      expectedUnits: BigInt(10_000),
      now: NOW,
    });

    expect(result.verified).toBe(true);
    expect(result.blockNumber).toBe("61303876");
    expect(result.provenance.sourceType).toBe("blockscout_api");
  });

  // 9. wrong fallback amount fails
  test("9. wrong fallback amount fails", () => {
    const txInfo = createFallbackTxInfo({ units: BigInt(20_000) });

    expect(() =>
      verifyArcScanTxEvidence({
        txInfo,
        expectedHash: txInfo.hash,
        expectedSourceWallet: USER_ALICE_WALLET,
        expectedRecipient: CONTRACTOR_WALLET,
        expectedUnits: BigInt(10_000),
        now: NOW,
      }),
    ).toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 10. wrong recipient fails
  test("10. wrong recipient fails", () => {
    const txInfo = createFallbackTxInfo({
      to: "0x3333333333333333333333333333333333333333",
    });

    expect(() =>
      verifyArcScanTxEvidence({
        txInfo,
        expectedHash: txInfo.hash,
        expectedSourceWallet: USER_ALICE_WALLET,
        expectedRecipient: CONTRACTOR_WALLET,
        expectedUnits: BigInt(10_000),
        now: NOW,
      }),
    ).toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 11. wrong source fails
  test("11. wrong source fails", () => {
    const txInfo = createFallbackTxInfo({
      from: "0x4444444444444444444444444444444444444444",
    });

    expect(() =>
      verifyArcScanTxEvidence({
        txInfo,
        expectedHash: txInfo.hash,
        expectedSourceWallet: USER_ALICE_WALLET,
        expectedRecipient: CONTRACTOR_WALLET,
        expectedUnits: BigInt(10_000),
        now: NOW,
      }),
    ).toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 12. wrong token fails
  test("12. wrong token fails", () => {
    const txInfo = createFallbackTxInfo({
      contract: "0x5555555555555555555555555555555555555555",
    });

    expect(() =>
      verifyArcScanTxEvidence({
        txInfo,
        expectedHash: txInfo.hash,
        expectedSourceWallet: USER_ALICE_WALLET,
        expectedRecipient: CONTRACTOR_WALLET,
        expectedUnits: BigInt(10_000),
        now: NOW,
      }),
    ).toThrowError(/did not contain the expected Arc USDC Transfer event/);
  });

  // 13. malformed fallback response fails closed
  test("13. malformed fallback response fails closed", async () => {
    const policy = makePolicy("task-fb-13-malformed");
    const task = makeTask("task-fb-13-malformed", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-13",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-13",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullPrimaryClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    // Fallback fetcher returns null (e.g. malformed or HTTP error)
    const malformedFetcher = async () => null;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: nullPrimaryClient,
      fallbackTxInfoFetcher: malformedFetcher,
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
    expect(result.settlement.status).not.toBe("confirmed");
  });

  // 14. both sources null remains chain-unobserved
  test("14. both sources null remains chain-unobserved", async () => {
    const policy = makePolicy("task-fb-14-both-null");
    const task = makeTask("task-fb-14-both-null", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-14",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-14",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullPrimaryClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const nullFallbackFetcher = async () => null;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: nullPrimaryClient,
      fallbackTxInfoFetcher: nullFallbackFetcher,
      now: NOW,
    });

    expect(result.status).toBe("pending");
    expect(result.reconciliationState).toBe("HASH_RECORDED_CHAIN_UNOBSERVED");
    expect(result.settlement.status).toBe("confirming");
  });

  // 15. conflicting sources do not confirm
  test("15. conflicting sources do not confirm", async () => {
    const policy = makePolicy("task-fb-15-conflict");
    const task = makeTask("task-fb-15-conflict", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-15",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-15",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    // Primary says reverted
    const revertedPrimaryClient = {
      getTransactionReceipt: async () => ({
        status: "reverted",
        blockNumber: BigInt(61303876),
      }),
    } as unknown as PublicClient;

    // Fallback says success
    const successFallbackFetcher = async () => createFallbackTxInfo({ success: true });

    // Material conflict must throw RECONCILIATION_CONFLICT and NOT confirm
    await expect(
      reconcileFinalSettlementOnchain({
        task: settlingTask,
        policy,
        servicePurchases: [purchase],
        settlement: confirming,
        approval,
        testMode: true,
        publicClient: revertedPrimaryClient,
        fallbackTxInfoFetcher: successFallbackFetcher,
        now: NOW,
      }),
    ).rejects.toThrowError(/Material conflict/);
  });

  // 16. reconciliation performs zero eth_sendTransaction calls
  test("16. reconciliation performs zero eth_sendTransaction calls", async () => {
    const policy = makePolicy("task-fb-16-no-send");
    const task = makeTask("task-fb-16-no-send", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-16",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-16",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    let sendTxCount = 0;
    const mockClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
      sendTransaction: async () => {
        sendTxCount++;
        throw new Error("Must not send tx");
      },
    } as unknown as PublicClient;

    const fallbackFetcher = async () => createFallbackTxInfo();

    await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: mockClient,
      fallbackTxInfoFetcher: fallbackFetcher,
      now: NOW,
    });

    expect(sendTxCount).toBe(0);
  });

  // 17. no new approval is generated
  test("17. no new approval is generated", async () => {
    const policy = makePolicy("task-fb-17-no-new-approval");
    const task = makeTask("task-fb-17-no-new-approval", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-17",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const initialApproval = createApprovalRecord({
      id: "approval-fb-17-original",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, initialApproval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval: initialApproval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval: initialApproval,
      testMode: true,
      publicClient: nullClient,
      fallbackTxInfoFetcher: async () => createFallbackTxInfo(),
      now: NOW,
    });

    // Proof reuses the exact same initial approval record ID
    expect(result.proof?.approval?.id).toBe(initialApproval.id);
  });

  // 18. proof records reconciliation provenance
  test("18. proof records reconciliation provenance", async () => {
    const policy = makePolicy("task-fb-18-provenance");
    const task = makeTask("task-fb-18-provenance", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-18",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-18",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: nullClient,
      fallbackTxInfoFetcher: async () => createFallbackTxInfo(),
      now: NOW,
    });

    const prov = result.proof?.reconciliationProvenance;
    expect(prov).toBeDefined();
    expect(prov?.sourceType).toBe("blockscout_api");
    expect(prov?.primaryRpcObserved).toBe(false);
    expect(prov?.fallbackObserved).toBe(true);
    expect(prov?.blockNumber).toBe("61303876");
    expect(prov?.transactionHash).toBe(LIVE_RECORDED_HASH);
    expect(prov?.transactionFee).toBeDefined();
  });

  // 19. original 50 USDC mandate remains NOT EXECUTED
  test("19. original 50 USDC mandate remains NOT EXECUTED", async () => {
    const policy = makePolicy("task-fb-19-not-executed");
    const task = makeTask("task-fb-19-not-executed", policy);
    const purchase = makePaidPurchase(task.id, policy);

    const settlement = createSettlementExecution({
      id: "settlement-fb-19",
      taskId: task.id,
      provider: "circle_arc",
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      approvalRequired: true,
      policySnapshot: policy,
    });

    const approval = createApprovalRecord({
      id: "approval-fb-19",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: USER_ALICE_DID,
      walletAddress: USER_ALICE_WALLET,
      amount: P6B_TEST_MODE_AMOUNT,
      requestedAmount: task.paymentAmount!,
      executionAmount: P6B_TEST_MODE_AMOUNT,
      testMode: true,
      asset: "USDC",
      recipient: CONTRACTOR_WALLET,
      network: ARC_TESTNET_NAME,
      policySnapshot: policy,
      approvedAt: NOW,
    });

    const settlingTask = makeSettlingTask(task, policy, purchase, approval);
    const confirming = transitionSettlement(
      transitionSettlement(
        transitionSettlement(settlement, "submitting", { approval, now: NOW }),
        "submitted",
        { transactionHash: LIVE_RECORDED_HASH, now: NOW },
      ),
      "confirming",
      { now: NOW },
    );

    const nullClient = {
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
    } as unknown as PublicClient;

    const result = await reconcileFinalSettlementOnchain({
      task: settlingTask,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval,
      testMode: true,
      publicClient: nullClient,
      fallbackTxInfoFetcher: async () => createFallbackTxInfo(),
      now: NOW,
    });

    expect(result.status).toBe("confirmed");
    expect(result.settlement.status).toBe("confirmed");
    // Task remains awaiting_approval
    expect(result.task.status).toBe("awaiting_approval");
    // Original 50 USDC contractor payment is NOT delivered
    expect(result.proof?.originalPaymentDelivered).toBe(false);
    expect(result.proof?.demoVerificationStatus).toBe("complete");
    expect(result.proof?.status).toBe("demo_verified");
  });
});
