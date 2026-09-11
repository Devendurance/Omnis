import type { PublicClient } from "viem";
import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  formatMoney,
  money,
  transitionTask,
  type FinancialTask,
  type ServicePurchase,
  type SettlementExecution,
  type TaskPolicy,
} from "../src/lib/domain";
import { parseFinancialIntent } from "../src/lib/intent";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  approveFinalSettlement,
  reconcileFinalSettlementOnchain,
  recordFinalSettlementSubmission,
  runFinalSettlementPreflight,
} from "../src/lib/settlement/final/service";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  ARC_TESTNET_USDC_ADDRESS,
} from "../src/lib/settlement/arc/config";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import { TASK_SESSION_VERSION } from "../src/lib/tasks/session";
import type { TaskSession } from "../src/lib/tasks/session";

const NOW = "2026-09-11T12:00:00.000Z";
const USER_ALICE_DID = "did:privy:alice-p8d";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const CONTRACTOR_WALLET = "0x2222222222222222222222222222222222222222" as const;
const OTHER_WALLET = "0x3333333333333333333333333333333333333333" as const;
const EXACT_UNITS = BigInt(100_000);
const SERVICE_BUDGET_UNITS = BigInt(50_000);
const SERVICE_SPEND_UNITS = BigInt(3_000);
const CONFIRMED_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
      originalIntent: `Pay this contractor ${CONTRACTOR_WALLET} 0.10 USDC, but check the wallet first. Spend no more than $0.05 checking.`,
      recipient: CONTRACTOR_WALLET,
      paymentAmount: money("0.10", "USDC"),
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

function makeBalanceClient(balance: bigint, nativeBalance?: bigint): PublicClient {
  return {
    getChainId: async () => ARC_TESTNET_CHAIN_ID,
    readContract: async () => balance,
    estimateGas: async () => BigInt(60_000),
    getGasPrice: async () => BigInt(1_000_000_000),
    getBalance: async () =>
      nativeBalance ?? BigInt(10_000_000_000_000_000),
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
  } as unknown as PublicClient;
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
  return {
    address: contract,
    topics: [
      transferTopic,
      `0x000000000000000000000000${from}`,
      `0x000000000000000000000000${to}`,
    ],
    data: `0x${(opts.units ?? EXACT_UNITS).toString(16)}`,
  };
}

function makeReceiptClient(log: Record<string, unknown>): PublicClient {
  return {
    getChainId: async () => ARC_TESTNET_CHAIN_ID,
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: BigInt(700),
      logs: [log],
    }),
    getTransaction: async () => null,
  } as unknown as PublicClient;
}

async function runFullFlowToConfirming(taskId: string) {
  const policy = makePolicy(taskId);
  const task = makeTask(taskId, policy);
  const purchase = makePaidPurchase(task.id, policy);
  const awaiting = makeAwaitingTask(task, policy, purchase);
  const { settlement } = await runFinalSettlementPreflight({
    task: awaiting,
    policy,
    servicePurchases: [purchase],
    executionWalletAddress: USER_ALICE_WALLET,
    ownerSubject: USER_ALICE_DID,
    publicClient: makeBalanceClient(BigInt(1_000_000)),
  });
  const approved = approveFinalSettlement({
    task: awaiting,
    policy,
    servicePurchases: [purchase],
    settlement,
    executionWalletAddress: USER_ALICE_WALLET,
    ownerSubject: USER_ALICE_DID,
  });
  const { settlement: confirming } = recordFinalSettlementSubmission({
    task: approved.task,
    policy,
    servicePurchases: [purchase],
    settlement: approved.settlement,
    approval: approved.approval,
    transactionHash: CONFIRMED_HASH,
  });
  return { policy, purchase, awaiting, ...approved, confirming };
}

test.describe("P8D Exact Small-Value Mandate Completion", () => {
  test("1. canonical 0.10 and 0.05 prompt parses without clarification", () => {
    const variants = [
      `Pay this contractor ${CONTRACTOR_WALLET} 0.10 USDC, but check the wallet first. Spend no more than $0.05 checking.`,
      `Pay ${CONTRACTOR_WALLET} 0.10 USDC after checking the wallet. Max $0.05 for the check.`,
      `Check ${CONTRACTOR_WALLET} for at most five cents, then pay 0.10 USDC.`,
      `Spend up to $0.05 checking ${CONTRACTOR_WALLET} before sending 0.10 USDC.`,
    ];
    for (const text of variants) {
      const res = parseFinancialIntent(text);
      expect(res.status).toBe("ready");
      expect(res.intentType).toBe("pay_with_check");
      expect(res.fields.paymentAmount?.units).toBe(EXACT_UNITS);
      expect(res.fields.paymentAsset).toBe("USDC");
      expect(res.fields.serviceBudget?.units).toBe(SERVICE_BUDGET_UNITS);
      expect(res.fields.recipient).toBe(CONTRACTOR_WALLET);
      expect(res.missing).toEqual([]);
      expect(res.fields.finalPaymentApprovalRequired).toBe(true);
    }
  });

  test("2. final task amount is 100000 atomic USDC", () => {
    const task = makeTask("task-p8d-amount");
    expect(task.paymentAmount?.units).toBe(EXACT_UNITS);
    expect(task.paymentAmount?.asset).toBe("USDC");
    expect(formatMoney(task.paymentAmount!)).toBe("0.1");
  });

  test("3. service budget remains 50000 six-decimal USD units", () => {
    const task = makeTask("task-p8d-budget");
    expect(task.serviceBudget?.units).toBe(SERVICE_BUDGET_UNITS);
    expect(task.serviceBudget?.asset).toBe("USD");
    expect(task.serviceBudget?.decimals).toBe(6);
  });

  test("4. service spend remains separate from final payment", async () => {
    const policy = makePolicy("task-p8d-separate");
    const task = makeTask("task-p8d-separate", policy);
    const purchase = makePaidPurchase(task.id, policy);
    expect(purchase.paidAmount?.units).toBe(SERVICE_SPEND_UNITS);
    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: makeAwaitingTask(task, policy, purchase),
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(settlement.amount.units).toBe(EXACT_UNITS);
    expect(preflight.serviceAmountSpent.units).toBe(SERVICE_SPEND_UNITS);
    expect(preflight.serviceBudgetRemaining.units).toBe(
      SERVICE_BUDGET_UNITS - SERVICE_SPEND_UNITS,
    );
    expect(preflight.serviceBudgetRemaining.units).toBe(BigInt(47_000));
  });

  test("5. wallet check must be paid before final settlement", async () => {
    const policy = makePolicy("task-p8d-unpaid");
    const task = makeTask("task-p8d-unpaid", policy);
    const awaiting = makeAwaitingTask(
      task,
      policy,
      makePaidPurchase(task.id, policy),
    );
    const { preflight } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(preflight.readyForApproval).toBe(false);
    expect(preflight.blockers).toContain(
      "Wallet check must be confirmed and paid before final payment",
    );

    const running = transitionTask(transitionTask(task, "planned"), "running");
    const runningFlight = await runFinalSettlementPreflight({
      task: running,
      policy,
      servicePurchases: [makePaidPurchase(task.id, policy)],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(runningFlight.preflight.readyForApproval).toBe(false);
    expect(
      runningFlight.preflight.blockers.some((entry) =>
        entry.includes("cannot prepare final payment approval"),
      ),
    ).toBe(true);

    const badRecipient = { ...awaiting, recipient: "0x1234" };
    const badFlight = await runFinalSettlementPreflight({
      task: badRecipient,
      policy,
      servicePurchases: [makePaidPurchase(task.id, policy)],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(badFlight.preflight.readyForApproval).toBe(false);
    expect(badFlight.preflight.blockers).toContain(
      "Invalid task recipient address",
    );

    const resultless = { ...makePaidPurchase(task.id, policy) };
    const { serviceResult: _dropped, ...withoutResult } = resultless;
    void _dropped;
    const resultlessFlight = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [withoutResult as ServicePurchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(resultlessFlight.preflight.readyForApproval).toBe(false);
    expect(resultlessFlight.preflight.blockers).toContain(
      "Wallet check must be confirmed and paid before final payment",
    );
  });

  test("6. approval binds exact 0.10 amount", async () => {
    const policy = makePolicy("task-p8d-bind");
    const task = makeTask("task-p8d-bind", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaiting = makeAwaitingTask(task, policy, purchase);
    const { settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    const { approval, authorizedExecution } = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });
    expect(approval.amount.units).toBe(EXACT_UNITS);
    expect(approval.requestedAmount?.units).toBe(EXACT_UNITS);
    expect(approval.executionAmount?.units).toBe(EXACT_UNITS);
    expect(approval.asset).toBe("USDC");
    expect(approval.recipient).toBe(CONTRACTOR_WALLET);
    expect(approval.network).toBe(ARC_TESTNET_NAME);
    expect(approval.walletAddress).toBe(USER_ALICE_WALLET);
    expect(approval.policySnapshot.taskId).toBe(task.id);
    expect(approval.testMode).toBe(false);
    expect(authorizedExecution.testMode).toBe(false);
    expect(approval.serviceEvidence?.paidPurchaseIds).toEqual([purchase.id]);
    expect(approval.serviceEvidence?.paidTotal.units).toBe(SERVICE_SPEND_UNITS);
  });

  test("6b. approval refuses unpaid wallet check and swapped ledger", async () => {
    const policy = makePolicy("task-p8d-evidence");
    const task = makeTask("task-p8d-evidence", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaiting = makeAwaitingTask(task, policy, purchase);
    const { settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(() =>
      approveFinalSettlement({
        task: awaiting,
        policy,
        servicePurchases: [],
        settlement,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
      }),
    ).toThrow(/required wallet check purchase is not paid/);

    const flow = await runFullFlowToConfirming("task-p8d-swapped");
    const strangerPolicy = makePolicy("other-task");
    const stranger = makePaidPurchase("other-task", strangerPolicy);
    await expect(
      reconcileFinalSettlementOnchain({
        task: flow.task,
        policy: flow.policy,
        servicePurchases: [stranger],
        settlement: flow.confirming,
        approval: flow.approval,
        publicClient: makeReceiptClient(createReceiptLog({})),
        now: NOW,
      }),
    ).rejects.toThrow(/bound paid service purchase/);
  });

  test("7. changed amount fails", async () => {
    const policy = makePolicy("task-p8d-amount-fail");
    const task = makeTask("task-p8d-amount-fail", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaiting = makeAwaitingTask(task, policy, purchase);
    const { settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    const tampered: SettlementExecution = {
      ...settlement,
      amount: money("0.11", "USDC"),
    };
    expect(() =>
      approveFinalSettlement({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement: tampered,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
      }),
    ).toThrow(/settlement amount does not match authoritative task payment amount/);
  });

  test("8. changed recipient fails", async () => {
    const policy = makePolicy("task-p8d-recipient-fail");
    const task = makeTask("task-p8d-recipient-fail", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaiting = makeAwaitingTask(task, policy, purchase);
    const { settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    const tampered: SettlementExecution = {
      ...settlement,
      recipient: OTHER_WALLET,
    };
    expect(() =>
      approveFinalSettlement({
        task: awaiting,
        policy,
        servicePurchases: [purchase],
        settlement: tampered,
        executionWalletAddress: USER_ALICE_WALLET,
        ownerSubject: USER_ALICE_DID,
      }),
    ).toThrow(/does not match task recipient/);
  });

  test("9. no final transaction before human approval", async () => {
    const policy = makePolicy("task-p8d-no-tx");
    const task = makeTask("task-p8d-no-tx", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: makeAwaitingTask(task, policy, purchase),
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000)),
    });
    expect(preflight.signing).toBe(false);
    expect(preflight.transaction).toBe("not_submitted");
    expect(settlement.status).toBe("prepared");
    expect(settlement.transactionHash).toBeUndefined();
    expect(preflight.testMode).toBe(false);
    expect(preflight.sufficientGas).toBe(true);
    expect(preflight.nativeGasRequiredWei).toBe(BigInt(60_000) * BigInt(1_000_000_000));
    expect(preflight.readyForApproval).toBe(true);
  });

  test("9b. native gas shortfall blocks approval", async () => {
    const policy = makePolicy("task-p8d-gas");
    const task = makeTask("task-p8d-gas", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaiting = makeAwaitingTask(task, policy, purchase);
    const broke = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: makeBalanceClient(BigInt(1_000_000), BigInt(0)),
    });
    expect(broke.preflight.sufficientGas).toBe(false);
    expect(broke.preflight.readyForApproval).toBe(false);
    expect(
      broke.preflight.blockers.some((entry) =>
        entry.includes("Insufficient Arc native USDC for gas"),
      ),
    ).toBe(true);

    const failingClient = {
      getChainId: async () => ARC_TESTNET_CHAIN_ID,
      readContract: async () => BigInt(1_000_000),
      estimateGas: async () => {
        throw new Error("eth_estimateGas unavailable");
      },
      getGasPrice: async () => BigInt(1_000_000_000),
      getBalance: async () => BigInt(1_000_000_000_000_000),
    } as unknown as PublicClient;
    const failed = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: failingClient,
    });
    expect(failed.preflight.readyForApproval).toBe(false);
    expect(
      failed.preflight.blockers.some((entry) =>
        entry.includes("Arc gas check failed"),
      ),
    ).toBe(true);
  });

  test("10. authorized execution uses 100000 atomic units", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-authorized");
    expect(flow.authorizedExecution.effectiveUnits).toBe("100000");
    expect(flow.authorizedExecution.amount.units).toBe(EXACT_UNITS);
    expect(flow.authorizedExecution.executionAmount?.units).toBe(EXACT_UNITS);
    expect(flow.authorizedExecution.requestedAmount?.units).toBe(EXACT_UNITS);
    expect(flow.authorizedExecution.recipient).toBe(CONTRACTOR_WALLET);
    expect(flow.authorizedExecution.sourceWallet).toBe(USER_ALICE_WALLET);
    expect(flow.authorizedExecution.chainId).toBe(ARC_TESTNET_CHAIN_ID);
  });

  test("11. receipt with 100000 confirms", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-confirm");
    const result = await reconcileFinalSettlementOnchain({
      task: flow.task,
      policy: flow.policy,
      servicePurchases: [flow.purchase],
      settlement: flow.confirming,
      approval: flow.approval,
      publicClient: makeReceiptClient(createReceiptLog({})),
      now: NOW,
    });
    expect(result.status).toBe("confirmed");
    expect(result.settlement.status).toBe("confirmed");
    expect(result.task.status).toBe("completed");
    expect(result.proof).toBeDefined();
  });

  test("12. 99999 rejects", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-low");
    await expect(
      reconcileFinalSettlementOnchain({
        task: flow.task,
        policy: flow.policy,
        servicePurchases: [flow.purchase],
        settlement: flow.confirming,
        approval: flow.approval,
        publicClient: makeReceiptClient(
          createReceiptLog({ units: BigInt(99_999) }),
        ),
        now: NOW,
      }),
    ).rejects.toThrow(/did not contain the expected Arc USDC Transfer event/);
  });

  test("13. 100001 rejects", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-high");
    await expect(
      reconcileFinalSettlementOnchain({
        task: flow.task,
        policy: flow.policy,
        servicePurchases: [flow.purchase],
        settlement: flow.confirming,
        approval: flow.approval,
        publicClient: makeReceiptClient(
          createReceiptLog({ units: BigInt(100_001) }),
        ),
        now: NOW,
      }),
    ).rejects.toThrow(/did not contain the expected Arc USDC Transfer event/);
  });

  test("14. wrong recipient rejects", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-wrong-to");
    await expect(
      reconcileFinalSettlementOnchain({
        task: flow.task,
        policy: flow.policy,
        servicePurchases: [flow.purchase],
        settlement: flow.confirming,
        approval: flow.approval,
        publicClient: makeReceiptClient(createReceiptLog({ to: OTHER_WALLET })),
        now: NOW,
      }),
    ).rejects.toThrow(/did not contain the expected Arc USDC Transfer event/);
  });

  test("15. wrong token rejects", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-wrong-token");
    await expect(
      reconcileFinalSettlementOnchain({
        task: flow.task,
        policy: flow.policy,
        servicePurchases: [flow.purchase],
        settlement: flow.confirming,
        approval: flow.approval,
        publicClient: makeReceiptClient(
          createReceiptLog({ contract: OTHER_WALLET }),
        ),
        now: NOW,
      }),
    ).rejects.toThrow(/did not contain the expected Arc USDC Transfer event/);
  });

  test("16. duplicate and reload never resubmit", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-dup");
    const again = recordFinalSettlementSubmission({
      task: flow.task,
      policy: flow.policy,
      servicePurchases: [flow.purchase],
      settlement: flow.confirming,
      approval: flow.approval,
      transactionHash: CONFIRMED_HASH,
    });
    expect(again.settlement.transactionHash).toBe(CONFIRMED_HASH);
    expect(again.settlement.status).toBe("confirming");

    expect(() =>
      recordFinalSettlementSubmission({
        task: flow.task,
        policy: flow.policy,
        servicePurchases: [flow.purchase],
        settlement: flow.confirming,
        approval: flow.approval,
        transactionHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toThrow(/cannot transition settlement from confirming to submitted/);

    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: USER_ALICE_DID,
      ownerWalletAddress: USER_ALICE_WALLET,
      messages: [],
      task: flow.task,
      policy: flow.policy,
      servicePurchases: [flow.purchase],
      settlement: flow.confirming,
      approval: flow.approval,
    };
    const hydrated = hydrateDraftSession(serializeDraftSession(session), undefined, {
      expectedOwnerSubject: USER_ALICE_DID,
    });
    expect(hydrated?.settlement?.transactionHash).toBe(CONFIRMED_HASH);
    expect(hydrated?.settlement?.status).toBe("confirming");
    expect(hydrated?.approval?.serviceEvidence?.paidPurchaseIds).toContain(
      flow.purchase.id,
    );
    expect(hydrated?.approval?.serviceEvidence?.paidTotal.units).toBe(
      SERVICE_SPEND_UNITS,
    );
  });

  test("17. exact confirmed settlement completes task exactly once", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-complete-once");
    const result = await reconcileFinalSettlementOnchain({
      task: flow.task,
      policy: flow.policy,
      servicePurchases: [flow.purchase],
      settlement: flow.confirming,
      approval: flow.approval,
      publicClient: makeReceiptClient(createReceiptLog({})),
      now: NOW,
    });
    expect(result.task.status).toBe("completed");
    expect(() =>
      transitionTask(result.task, "settling", { now: NOW }),
    ).toThrow(/cannot transition task from completed to settling/);
  });

  test("18. proof says original payment EXECUTED", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-executed");
    const result = await reconcileFinalSettlementOnchain({
      task: flow.task,
      policy: flow.policy,
      servicePurchases: [flow.purchase],
      settlement: flow.confirming,
      approval: flow.approval,
      publicClient: makeReceiptClient(createReceiptLog({})),
      now: NOW,
    });
    expect(result.proof?.status).toBe("completed");
    expect(result.proof?.originalPaymentDelivered).toBe(true);
    expect(result.proof?.testMode).toBe(false);
    expect(result.proof?.finalPayment?.status).toBe("confirmed");
  });

  test("19. no test-mode copy appears in normal completion", async () => {
    const flow = await runFullFlowToConfirming("task-p8d-no-test-copy");
    const result = await reconcileFinalSettlementOnchain({
      task: flow.task,
      policy: flow.policy,
      servicePurchases: [flow.purchase],
      settlement: flow.confirming,
      approval: flow.approval,
      publicClient: makeReceiptClient(createReceiptLog({})),
      now: NOW,
    });
    expect(flow.confirming.testMode).toBe(false);
    expect(flow.approval.testMode).toBe(false);
    expect(result.settlement.testMode).toBe(false);
    const message = result.message ?? "";
    expect(message).not.toMatch(/TEST MODE/i);
    expect(message).not.toMatch(/NOT EXECUTED/);
    expect(message).not.toMatch(/demo/i);
  });

  test("20. automated tests perform zero live payments", async () => {
    let writeCalls = 0;
    const countingClient = new Proxy(
      {
        getChainId: async () => ARC_TESTNET_CHAIN_ID,
        readContract: async () => BigInt(1_000_000),
        estimateGas: async () => BigInt(60_000),
        getGasPrice: async () => BigInt(1_000_000_000),
        getBalance: async () => BigInt(1_000_000_000_000_000),
        getTransactionReceipt: async () => ({
          status: "success",
          blockNumber: BigInt(701),
          logs: [createReceiptLog({})],
        }),
        getTransaction: async () => null,
      } as unknown as PublicClient,
      {
        get(target, property, receiver) {
          if (
            property === "then" ||
            [
              "getChainId",
              "readContract",
              "estimateGas",
              "getGasPrice",
              "getBalance",
              "getTransactionReceipt",
              "getTransaction",
            ].includes(String(property))
          ) {
            return Reflect.get(target, property, receiver);
          }
          writeCalls += 1;
          throw new Error(
            `live writes are forbidden in tests: ${String(property)}`,
          );
        },
      },
    );
    const policy = makePolicy("task-p8d-zero-live");
    const task = makeTask("task-p8d-zero-live", policy);
    const purchase = makePaidPurchase(task.id, policy);
    const awaiting = makeAwaitingTask(task, policy, purchase);
    const { preflight, settlement } = await runFinalSettlementPreflight({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
      publicClient: countingClient,
    });
    expect(preflight.signing).toBe(false);
    const approved = approveFinalSettlement({
      task: awaiting,
      policy,
      servicePurchases: [purchase],
      settlement,
      executionWalletAddress: USER_ALICE_WALLET,
      ownerSubject: USER_ALICE_DID,
    });
    const { settlement: confirming } = recordFinalSettlementSubmission({
      task: approved.task,
      policy,
      servicePurchases: [purchase],
      settlement: approved.settlement,
      approval: approved.approval,
      transactionHash: CONFIRMED_HASH,
    });
    const result = await reconcileFinalSettlementOnchain({
      task: approved.task,
      policy,
      servicePurchases: [purchase],
      settlement: confirming,
      approval: approved.approval,
      publicClient: countingClient,
      now: NOW,
    });
    expect(result.status).toBe("confirmed");
    expect(writeCalls).toBe(0);
  });
});
