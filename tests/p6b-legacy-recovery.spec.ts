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
import {
  assertLegacyRecoveryEligibility,
  recoverLegacyP6BSettlement,
  P6B_TEST_MODE_AMOUNT,
} from "../src/lib/settlement/final/service";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  ARC_TESTNET_USDC_ADDRESS,
} from "../src/lib/settlement/arc/config";
import type {
  ArcScanLog,
  ArcScanTxInfoResult,
} from "../src/lib/settlement/arc/fallback";

const NOW = "2026-09-10T12:00:00.000Z";
const LIVE_OWNER_DID = "did:privy:cmtsflz2d01d80bl87emk9635";
const LIVE_EXECUTION_WALLET = "0x6eEcBa18f23ada98c894476D8Da34db21cb64456";
const LIVE_CONTRACTOR_RECIPIENT = "0xc44685b7c78cc9c9b7f6623d7697ac30ab0d6dc9";
const LIVE_TASK_ID = "task-b51baf29-8b2d-4c97-96df-887e10057a9c";
const LIVE_HEDERA_PAYMENT_ID = "0.0.7162784@1788995118.130839662";
const CONFIRMED_ARC_TX_HASH =
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

function makeTask(taskId = LIVE_TASK_ID, policy = makePolicy(taskId)): FinancialTask {
  const draft = createFinancialTask(
    {
      id: taskId,
      ownerId: LIVE_OWNER_DID,
      ownerSubject: LIVE_OWNER_DID,
      ownerWalletAddress: LIVE_EXECUTION_WALLET,
      type: "pay_with_check",
      originalIntent:
        "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
      recipient: LIVE_CONTRACTOR_RECIPIENT,
      paymentAmount: money("50", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const purchase = makePaidPurchase(taskId, policy);
  const running = transitionTask(transitionTask(draft, "planned"), "running");
  const awaiting = transitionTask(running, "awaiting_approval", {
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
  const tempApproval = createApprovalRecord({
    id: `approval-${taskId}-temp`,
    taskId,
    settlementExecutionId: `settlement-${taskId}-temp`,
    approverId: LIVE_OWNER_DID,
    walletAddress: LIVE_EXECUTION_WALLET,
    amount: money("50", "USDC"),
    asset: "USDC",
    recipient: LIVE_CONTRACTOR_RECIPIENT,
    network: ARC_TESTNET_NAME,
    policySnapshot: policy,
    approvedAt: NOW,
  });
  return transitionTask(awaiting, "settling", {
    approval: tempApproval,
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
}

function makePaidPurchase(taskId = LIVE_TASK_ID, policy = makePolicy(taskId)): ServicePurchase {
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
      paymentIdentifier: LIVE_HEDERA_PAYMENT_ID,
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: {
          wallet: LIVE_CONTRACTOR_RECIPIENT,
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

function makeStaleApprovalAndSettlement(
  task: FinancialTask,
  policy: TaskPolicy,
): { approval: ApprovalRecord; settlement: SettlementExecution } {
  const approval = createApprovalRecord({
    id: `approval-${task.id}-legacy`,
    taskId: task.id,
    settlementExecutionId: `settlement-${task.id}-legacy`,
    approverId: LIVE_OWNER_DID,
    walletAddress: LIVE_EXECUTION_WALLET,
    amount: P6B_TEST_MODE_AMOUNT,
    requestedAmount: P6B_TEST_MODE_AMOUNT, // Stale! Should be 50
    executionAmount: P6B_TEST_MODE_AMOUNT,
    testMode: false, // Stale!
    asset: "USDC",
    recipient: LIVE_CONTRACTOR_RECIPIENT,
    network: ARC_TESTNET_NAME,
    policySnapshot: policy,
    approvedAt: NOW,
  });

  const settlement = createSettlementExecution({
    id: `settlement-${task.id}-legacy`,
    taskId: task.id,
    provider: "circle_arc",
    amount: P6B_TEST_MODE_AMOUNT,
    requestedAmount: P6B_TEST_MODE_AMOUNT, // Stale! Should be 50
    executionAmount: P6B_TEST_MODE_AMOUNT,
    testMode: false,
    recipient: LIVE_CONTRACTOR_RECIPIENT,
    network: ARC_TESTNET_NAME,
    approvalRequired: true,
    policySnapshot: policy,
  });

  return {
    approval,
    settlement: Object.freeze({
      ...settlement,
      testMode: undefined, // Exactly matches authoritative legacy record!
      status: "submitting" as const,
      transactionHash: undefined, // Missing!
    }),
  };
}

function makeMockArcClient(opts: {
  receipt?: unknown;
  tx?: unknown;
  chainId?: number;
  sendTransactionCallback?: () => void;
} = {}): PublicClient {
  return {
    getChainId: async () => opts.chainId ?? ARC_TESTNET_CHAIN_ID,
    getTransactionReceipt: async () => opts.receipt ?? null,
    getTransaction: async () => opts.tx ?? null,
    sendTransaction: async () => {
      opts.sendTransactionCallback?.();
      throw new Error("sendTransaction must never be called during recovery");
    },
  } as unknown as PublicClient;
}

function createReceiptLog(opts: {
  contract?: string;
  from?: string;
  to?: string;
  units?: bigint;
}) {
  const contract = opts.contract ?? ARC_TESTNET_USDC_ADDRESS;
  const from = (opts.from ?? LIVE_EXECUTION_WALLET).toLowerCase().replace("0x", "");
  const to = (opts.to ?? LIVE_CONTRACTOR_RECIPIENT).toLowerCase().replace("0x", "");
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
} = {}): ArcScanTxInfoResult {
  const hash = opts.hash ?? CONFIRMED_ARC_TX_HASH;
  const from = opts.from ?? LIVE_EXECUTION_WALLET;
  const to = opts.to ?? LIVE_CONTRACTOR_RECIPIENT;
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
    gasUsed: "48938",
    gasPrice: "25000000000",
    success: opts.success ?? true,
    logs: Object.freeze(logs),
  });
}

test.describe("P6B.5 Legacy P6B Test Settlement Recovery", () => {
  // 1. eligible legacy session can recover
  test("1. eligible legacy session can recover", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const primaryClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: primaryClient,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("confirmed");
    expect(result.reconciliationState).toBe("CONFIRMED");
    expect(result.settlement.status).toBe("confirmed");
  });

  // 2. task 50 USDC is preserved
  test("2. task 50 USDC is preserved", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const primaryClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: primaryClient,
      now: NOW,
    });

    expect(result.task.paymentAmount?.units).toBe(BigInt(50_000_000));
    expect(formatMoney(result.task.paymentAmount!)).toBe("50");
    expect(result.settlement.requestedAmount?.units).toBe(BigInt(50_000_000));
    expect(result.approval.requestedAmount?.units).toBe(BigInt(50_000_000));
  });

  // 3. execution becomes exactly 0.01
  test("3. execution becomes exactly 0.01", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const primaryClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: primaryClient,
      now: NOW,
    });

    expect(result.settlement.executionAmount?.units).toBe(BigInt(10_000));
    expect(result.approval.executionAmount?.units).toBe(BigInt(10_000));
    expect(result.settlement.amount.units).toBe(BigInt(10_000));
    expect(result.approval.amount.units).toBe(BigInt(10_000));
  });

  // 4. testMode becomes true
  test("4. testMode becomes true", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const primaryClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: primaryClient,
      now: NOW,
    });

    expect(result.approval.testMode).toBe(true);
    expect(result.settlement.testMode).toBe(true);
    expect(result.proof.testMode).toBe(true);
  });

  // 5. real hash is persisted
  test("5. real hash is persisted", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const primaryClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: primaryClient,
      now: NOW,
    });

    expect(result.settlement.transactionHash).toBe(CONFIRMED_ARC_TX_HASH);
    expect(result.proof.finalPayment?.transactionHash).toBe(CONFIRMED_ARC_TX_HASH);
  });

  // 6. onchain evidence is verified BEFORE migration commits
  test("6. onchain evidence is verified BEFORE migration commits", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const nullClient = makeMockArcClient();

    await expect(
      recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
        publicClient: nullClient,
        fallbackTxInfoFetcher: async () => null,
        now: NOW,
      }),
    ).rejects.toThrowError(/On-chain evidence could not be verified/);

    expect(settlement.status).toBe("submitting");
    expect(settlement.transactionHash).toBeUndefined();
  });

  // 7. wrong source fails
  test("7. wrong source fails", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const wrongSourceClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [
          createReceiptLog({
            from: "0x9999999999999999999999999999999999999999",
            units: BigInt(10_000),
          }),
        ],
      },
    });

    await expect(
      recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
        publicClient: wrongSourceClient,
        fallbackTxInfoFetcher: async () => null,
        now: NOW,
      }),
    ).rejects.toThrowError(/On-chain evidence could not be verified/);
  });

  // 8. wrong recipient fails
  test("8. wrong recipient fails", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const wrongRecipientClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [
          createReceiptLog({
            to: "0x8888888888888888888888888888888888888888",
            units: BigInt(10_000),
          }),
        ],
      },
    });

    await expect(
      recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
        publicClient: wrongRecipientClient,
        fallbackTxInfoFetcher: async () => null,
        now: NOW,
      }),
    ).rejects.toThrowError(/On-chain evidence could not be verified/);
  });

  // 9. wrong amount fails
  test("9. wrong amount fails", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const wrongAmountClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(20_000) })],
      },
    });

    await expect(
      recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
        publicClient: wrongAmountClient,
        fallbackTxInfoFetcher: async () => null,
        now: NOW,
      }),
    ).rejects.toThrowError(/On-chain evidence could not be verified/);
  });

  // 10. wrong token fails
  test("10. wrong token fails", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const wrongTokenClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [
          createReceiptLog({
            contract: "0x7777777777777777777777777777777777777777",
            units: BigInt(10_000),
          }),
        ],
      },
    });

    await expect(
      recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
        publicClient: wrongTokenClient,
        fallbackTxInfoFetcher: async () => null,
        now: NOW,
      }),
    ).rejects.toThrowError(/On-chain evidence could not be verified/);
  });

  // 11. wrong owner fails
  test("11. wrong owner fails", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    expect(() =>
      assertLegacyRecoveryEligibility({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: "did:privy:attacker-subject",
      }),
    ).toThrowError(/does not match task owner/);
  });

  // 12. unpaid service purchase fails
  test("12. unpaid service purchase fails", () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const unpaidPurchase = createServicePurchase(
      {
        id: `purchase-${task.id}-unpaid`,
        taskId: task.id,
        serviceId: WALLET_ACTIVITY_SERVICE_ID,
        quotedAmount: money("0.003", "USD"),
        paymentAmount: WALLET_ACTIVITY_PRICE,
        policySnapshot: policy,
        status: "quoted",
      },
      NOW,
    );

    expect(() =>
      assertLegacyRecoveryEligibility({
        task,
        policy,
        servicePurchases: [unpaidPurchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
      }),
    ).toThrowError(
      /Paid wallet check with verified Hedera payment identifier is required/,
    );
  });

  // 13. production recovery is disabled
  test("13. production recovery is disabled even if ENABLE_P6B_TEST_MODE is true", () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const oldEnv = process.env.NODE_ENV;
    const oldTestMode = process.env.ENABLE_P6B_TEST_MODE;
    const envStore = process.env as Record<string, string | undefined>;
    try {
      envStore.NODE_ENV = "production";
      envStore.ENABLE_P6B_TEST_MODE = "true";
      expect(() =>
        assertLegacyRecoveryEligibility({
          task,
          policy,
          servicePurchases: [purchase],
          settlement,
          approval,
          transactionHash: CONFIRMED_ARC_TX_HASH,
          executionWalletAddress: LIVE_EXECUTION_WALLET,
          ownerSubject: LIVE_OWNER_DID,
        }),
      ).toThrowError(/disabled in production/);
    } finally {
      envStore.NODE_ENV = oldEnv;
      envStore.ENABLE_P6B_TEST_MODE = oldTestMode;
    }
  });

  // 14. recovery performs zero eth_sendTransaction calls
  test("14. recovery performs zero eth_sendTransaction calls", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    let sendTransactionCallCount = 0;
    const mockClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
      sendTransactionCallback: () => {
        sendTransactionCallCount++;
      },
    });

    await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: mockClient,
      now: NOW,
    });

    expect(sendTransactionCallCount).toBe(0);
  });

  // 15. recovery performs zero new signatures
  test("15. recovery performs zero new signatures", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const mockClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: mockClient,
      now: NOW,
    });

    expect(result.approval.id).toBe(approval.id);
  });

  // 16. recovery creates no second approval
  test("16. recovery creates no second approval", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const mockClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: mockClient,
      now: NOW,
    });

    expect(result.approval.id).toBe(approval.id);
    expect(result.proof.approval?.id).toBe(approval.id);
  });

  // 17. original 50 USDC task remains NOT EXECUTED
  test("17. original 50 USDC task remains NOT EXECUTED", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const mockClient = makeMockArcClient({
      receipt: {
        status: "success",
        blockNumber: BigInt(61303876),
        logs: [createReceiptLog({ units: BigInt(10_000) })],
      },
    });

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: mockClient,
      now: NOW,
    });

    expect(result.task.status).toBe("awaiting_approval");
    expect(result.task.status).not.toBe("completed");
    expect(result.proof.originalPaymentDelivered).toBe(false);
  });

  // 18. proof becomes demo_verified only after successful reconciliation
  test("18. proof becomes demo_verified only after successful reconciliation", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const nullPrimaryClient = makeMockArcClient();

    const result = await recoverLegacyP6BSettlement({
      task,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      transactionHash: CONFIRMED_ARC_TX_HASH,
      executionWalletAddress: LIVE_EXECUTION_WALLET,
      ownerSubject: LIVE_OWNER_DID,
      publicClient: nullPrimaryClient,
      fallbackTxInfoFetcher: async () => createFallbackTxInfo(),
      now: NOW,
    });

    expect(result.proof.status).toBe("demo_verified");
    expect(result.proof.demoVerificationStatus).toBe("complete");
    expect(result.proof.finalPayment?.status).toBe("confirmed");
    expect(result.proof.finalPayment?.transactionHash).toBe(CONFIRMED_ARC_TX_HASH);
  });

  // 19. wrong chain fails recovery
  test("19. wrong chain fails recovery", async () => {
    const policy = makePolicy(LIVE_TASK_ID);
    const task = makeTask(LIVE_TASK_ID, policy);
    const purchase = makePaidPurchase(LIVE_TASK_ID, policy);
    const { approval, settlement } = makeStaleApprovalAndSettlement(task, policy);

    const wrongChainClient = makeMockArcClient({
      chainId: 1, // Mainnet instead of 5042002
    });

    await expect(
      recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases: [purchase],
        settlement,
        approval,
        transactionHash: CONFIRMED_ARC_TX_HASH,
        executionWalletAddress: LIVE_EXECUTION_WALLET,
        ownerSubject: LIVE_OWNER_DID,
        publicClient: wrongChainClient,
        now: NOW,
      }),
    ).rejects.toThrowError(/does not match Arc Testnet/);
  });
});
