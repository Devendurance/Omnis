import { encodeFunctionData, type PublicClient } from "viem";
import {
  assertApprovalForSettlement,
  assertApprovalServiceEvidence,
  assertPolicySnapshotsEqual,
  buildApprovalServiceEvidence,
  createApprovalRecord,
} from "../../domain/approvals/factory";
import { raiseDomainError } from "../../domain/errors";
import {
  createSettlementExecution,
  transitionSettlement,
  type CreateSettlementExecutionInput,
} from "../../domain/settlement/state-machine";
import { transitionTask } from "../../domain/tasks/state-machine";
import { finalizeProof } from "../../domain/receipts/builder";
import { calculateTaskBudgetState } from "../../domain/services/budget";
import {
  formatMoney,
  hydrateMoney,
  money,
  moneyEquals,
  moneyZero,
  parseMoney,
  serializeMoney,
} from "../../domain/money";
import type {
  ApprovalRecord,
  ArcReconciliationState,
  FinancialTask,
  OmnisProof,
  ReconciliationProvenance,
  ServicePurchase,
  SettlementConfirmationEvidence,
  SettlementExecution,
  TaskPolicy,
} from "../../domain/types";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_USDC_DECIMALS,
  ARC_TESTNET_USDC_SYMBOL,
  ERC20_ABI,
} from "../arc/config";
import {
  fetchArcScanTxInfo,
  verifyArcScanTxEvidence,
  type ArcScanTxInfoResult,
} from "../arc/fallback";
import {
  getArcPublicClient,
  getArcUsdcBalance,
} from "../circle/adapter";
import type {
  FinalSettlementAuthorizedExecution,
  FinalSettlementPreflight,
  SerializedFinalSettlementAuthorizedExecution,
  SerializedFinalSettlementPreflight,
} from "./types";

export const P6B_TEST_MODE_AMOUNT = parseMoney(
  "0.01",
  ARC_TESTNET_USDC_SYMBOL,
  ARC_TESTNET_USDC_DECIMALS,
);

export type PrepareFinalSettlementInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  executionWalletAddress: `0x${string}`;
  ownerSubject: string;
  testMode?: boolean;
  publicClient?: PublicClient;
  now?: string;
}>;

export type ApproveFinalSettlementInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  settlement: SettlementExecution;
  executionWalletAddress: `0x${string}`;
  ownerSubject: string;
  testMode?: boolean;
  now?: string;
}>;
export type SubmitFinalSettlementInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  settlement: SettlementExecution;
  approval: ApprovalRecord;
  transactionHash: string;
  testMode?: boolean;
  now?: string;
}>;
export type ReconcileFinalSettlementInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  settlement: SettlementExecution;
  approval?: ApprovalRecord;
  testMode?: boolean;
  publicClient?: PublicClient;
  fallbackTxInfoFetcher?: (
    txHash: string,
  ) => Promise<ArcScanTxInfoResult | null>;
  now?: string;
}>;
export function isWalletCheckPaid(
  servicePurchases: readonly ServicePurchase[],
): boolean {
  return servicePurchases.some(
    (purchase) =>
      purchase.status === "paid" &&
      purchase.serviceId === "useomnis-wallet-activity-x402" &&
      purchase.serviceResult !== undefined,
  );
}

export function assertSettlementMatchesTaskTruth(
  settlement: SettlementExecution,
  task: FinancialTask,
  policy: TaskPolicy,
  testMode = false,
): void {
  if (settlement.taskId !== task.id) {
    raiseDomainError(
      "SETTLEMENT_TASK_MISMATCH",
      `settlement task id ${settlement.taskId} does not match task id ${task.id}`,
    );
  }
  const isTestMode = Boolean(settlement.testMode ?? testMode);
  const taskAmount = task.paymentAmount;
  if (!taskAmount) {
    raiseDomainError(
      "SETTLEMENT_AMOUNT_MISMATCH",
      "task payment amount is missing",
    );
  }

  if (isTestMode) {
    const requested = settlement.requestedAmount ?? taskAmount;
    if (!moneyEquals(requested, taskAmount)) {
      raiseDomainError(
        "SETTLEMENT_AMOUNT_MISMATCH",
        `settlement requested amount does not match authoritative task payment amount`,
      );
    }
    const execution = settlement.executionAmount ?? settlement.amount;
    if (!moneyEquals(execution, P6B_TEST_MODE_AMOUNT)) {
      raiseDomainError(
        "SETTLEMENT_AMOUNT_MISMATCH",
        `test mode settlement execution amount does not match authorized test amount ${formatMoney(P6B_TEST_MODE_AMOUNT)}`,
      );
    }
  } else {
    const requested = settlement.requestedAmount ?? settlement.amount;
    const execution = settlement.executionAmount ?? settlement.amount;
    if (
      !moneyEquals(requested, taskAmount) ||
      !moneyEquals(execution, taskAmount) ||
      !moneyEquals(settlement.amount, taskAmount)
    ) {
      raiseDomainError(
        "SETTLEMENT_AMOUNT_MISMATCH",
        `settlement amount does not match authoritative task payment amount`,
      );
    }
  }
  if (
    !task.recipient ||
    !/^0x[0-9a-fA-F]{40}$/.test(task.recipient.trim()) ||
    settlement.recipient.toLowerCase() !== task.recipient.toLowerCase()
  ) {
    raiseDomainError(
      "SETTLEMENT_RECIPIENT_MISMATCH",
      `settlement recipient ${settlement.recipient} does not match task recipient ${task.recipient}`,
    );
  }
  if (settlement.network !== ARC_TESTNET_NAME) {
    raiseDomainError(
      "SETTLEMENT_NETWORK_MISMATCH",
      `settlement network ${settlement.network} does not match ${ARC_TESTNET_NAME}`,
    );
  }
  if (settlement.provider !== "circle_arc") {
    raiseDomainError(
      "SETTLEMENT_PROVIDER_MISMATCH",
      `settlement provider ${settlement.provider} is not circle_arc`,
    );
  }
  if (!settlement.approvalRequired || !policy.finalPaymentApprovalRequired) {
    raiseDomainError(
      "SETTLEMENT_APPROVAL_POLICY_MISMATCH",
      "settlement approval required flag must match policy requirement",
    );
  }
  assertPolicySnapshotsEqual(settlement.policySnapshot, policy);
}

export async function runFinalSettlementPreflight(
  input: PrepareFinalSettlementInput,
): Promise<{
  preflight: FinalSettlementPreflight;
  settlement: SettlementExecution;
}> {
  const { task, policy, servicePurchases, executionWalletAddress, testMode } =
    input;
  const now = input.now ?? new Date().toISOString();
  const blockers: string[] = [];

  if (task.type !== "pay_with_check") {
    blockers.push("Final settlement requires a pay_with_check task");
  }

  if (task.status !== "awaiting_approval") {
    blockers.push(
      `Task status ${task.status} cannot prepare final payment approval`,
    );
  }

  const walletCheckPaid = isWalletCheckPaid(servicePurchases);
  if (!walletCheckPaid) {
    blockers.push("Wallet check must be confirmed and paid before final payment");
  }
  if (
    task.ownerWalletAddress &&
    executionWalletAddress.toLowerCase() !== task.ownerWalletAddress.toLowerCase()
  ) {
    blockers.push(
      `Execution wallet ${executionWalletAddress} does not match task primary execution wallet ${task.ownerWalletAddress}`,
    );
  }

  const recipient = (task.recipient ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    blockers.push("Invalid task recipient address");
  }

  if (!task.paymentAmount || task.paymentAmount.units <= BigInt(0)) {
    blockers.push("Task payment amount must be greater than zero");
  }

  const budget = calculateTaskBudgetState(task, policy, servicePurchases);
  const serviceAmountSpent = budget.confirmedSpend;
  const serviceBudgetRemaining = budget.remainingAvailable;
  const client = input.publicClient ?? getArcPublicClient();
  let arcChainReadiness = false;
  try {
    const chainId = await client.getChainId();
    arcChainReadiness = chainId === ARC_TESTNET_CHAIN_ID;
  } catch (err) {
    blockers.push(
      `Arc Testnet RPC unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let arcUsdcBalance = moneyZero(
    ARC_TESTNET_USDC_SYMBOL,
    ARC_TESTNET_USDC_DECIMALS,
  );
  try {
    arcUsdcBalance = await getArcUsdcBalance(executionWalletAddress, client);
  } catch (err) {
    blockers.push(
      `Failed to read Arc USDC balance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const amount = task.paymentAmount ?? money("50", "USDC");
  const effectivePaymentAmount = testMode ? P6B_TEST_MODE_AMOUNT : amount;
  const sufficientBalance = arcUsdcBalance.units >= effectivePaymentAmount.units;

  if (!sufficientBalance) {
    blockers.push(
      `Insufficient Arc USDC wallet balance: available ${arcUsdcBalance.units.toString()} atomic, requested ${effectivePaymentAmount.units.toString()} atomic`,
    );
  }

  let nativeGasBalanceWei = BigInt(0);
  let nativeGasRequiredWei = BigInt(0);
  let sufficientGas = false;
  try {
    const transferCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipient as `0x${string}`, effectivePaymentAmount.units],
    });
    const [gasEstimate, gasPrice, nativeBalance] = await Promise.all([
      client.estimateGas({
        account: executionWalletAddress,
        to: ARC_TESTNET_USDC_ADDRESS,
        data: transferCalldata,
      }),
      client.getGasPrice(),
      client.getBalance({ address: executionWalletAddress }),
    ]);
    nativeGasBalanceWei = nativeBalance;
    nativeGasRequiredWei = gasEstimate * gasPrice;
    sufficientGas = nativeBalance >= nativeGasRequiredWei;
    if (!sufficientGas) {
      blockers.push(
        `Insufficient Arc native USDC for gas: available ${nativeBalance.toString()} wei, estimated ${nativeGasRequiredWei.toString()} wei for the transfer`,
      );
    }
  } catch (err) {
    blockers.push(
      `Arc gas check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const readyForApproval =
    blockers.length === 0 &&
    walletCheckPaid &&
    arcChainReadiness &&
    sufficientBalance &&
    sufficientGas;
  const preflight: FinalSettlementPreflight = Object.freeze({
    executionWallet: executionWalletAddress,
    recipient,
    amount,
    arcChainId: ARC_TESTNET_CHAIN_ID,
    arcChainReadiness,
    arcUsdcBalance,
    sufficientBalance,
    nativeGasBalanceWei,
    nativeGasRequiredWei,
    sufficientGas,
    walletCheckCompleted: walletCheckPaid,
    serviceAmountSpent,
    serviceBudgetRemaining,
    testMode: Boolean(testMode),
    effectivePaymentAmount,
    signing: false,
    transaction: "not_submitted",
    readyForApproval,
    blockers: Object.freeze(blockers),
  });

  const settlementInput: CreateSettlementExecutionInput = {
    id: `settlement-${task.id}`,
    taskId: task.id,
    provider: "circle_arc",
    amount: effectivePaymentAmount,
    requestedAmount: amount,
    executionAmount: effectivePaymentAmount,
    testMode: Boolean(testMode),
    recipient,
    network: ARC_TESTNET_NAME,
    approvalRequired: true,
    policySnapshot: policy,
  };

  const settlement = createSettlementExecution(settlementInput, now);

  return { preflight, settlement };
}

export function serializeFinalSettlementPreflight(
  preflight: FinalSettlementPreflight,
): SerializedFinalSettlementPreflight {
  return Object.freeze({
    executionWallet: preflight.executionWallet,
    recipient: preflight.recipient,
    amount: serializeMoney(preflight.amount),
    arcChainId: preflight.arcChainId,
    arcChainReadiness: preflight.arcChainReadiness,
    arcUsdcBalance: serializeMoney(preflight.arcUsdcBalance),
    sufficientBalance: preflight.sufficientBalance,
    nativeGasBalanceWei: preflight.nativeGasBalanceWei.toString(),
    nativeGasRequiredWei: preflight.nativeGasRequiredWei.toString(),
    sufficientGas: preflight.sufficientGas,
    walletCheckCompleted: preflight.walletCheckCompleted,
    serviceAmountSpent: serializeMoney(preflight.serviceAmountSpent),
    serviceBudgetRemaining: serializeMoney(preflight.serviceBudgetRemaining),
    testMode: preflight.testMode,
    effectivePaymentAmount: serializeMoney(preflight.effectivePaymentAmount),
    signing: false,
    transaction: "not_submitted",
    readyForApproval: preflight.readyForApproval,
    blockers: Object.freeze([...preflight.blockers]),
  });
}

function parseWeiField(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Invalid preflight data: ${field} must be a wei string`);
}

export function hydrateFinalSettlementPreflight(
  raw: unknown,
): FinalSettlementPreflight {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid preflight data: expected an object");
  }
  const r = raw as Record<string, unknown>;
  const amount = hydrateMoney(r.amount, "preflight.amount");
  const arcUsdcBalance = hydrateMoney(r.arcUsdcBalance, "preflight.arcUsdcBalance");
  const serviceAmountSpent = hydrateMoney(r.serviceAmountSpent, "preflight.serviceAmountSpent");
  const serviceBudgetRemaining = hydrateMoney(r.serviceBudgetRemaining, "preflight.serviceBudgetRemaining");
  const effectivePaymentAmount = hydrateMoney(r.effectivePaymentAmount, "preflight.effectivePaymentAmount");

  return Object.freeze({
    executionWallet: String(r.executionWallet ?? ""),
    recipient: String(r.recipient ?? ""),
    amount,
    arcChainId: Number(r.arcChainId ?? ARC_TESTNET_CHAIN_ID),
    arcChainReadiness: Boolean(r.arcChainReadiness),
    arcUsdcBalance,
    sufficientBalance: Boolean(r.sufficientBalance),
    nativeGasBalanceWei: parseWeiField(r.nativeGasBalanceWei, "preflight.nativeGasBalanceWei"),
    nativeGasRequiredWei: parseWeiField(r.nativeGasRequiredWei, "preflight.nativeGasRequiredWei"),
    sufficientGas: Boolean(r.sufficientGas),
    walletCheckCompleted: Boolean(r.walletCheckCompleted),
    serviceAmountSpent,
    serviceBudgetRemaining,
    testMode: Boolean(r.testMode),
    effectivePaymentAmount,
    signing: false,
    transaction: "not_submitted",
    readyForApproval: Boolean(r.readyForApproval),
    blockers: Array.isArray(r.blockers)
      ? Object.freeze(r.blockers.map((b) => String(b)))
      : Object.freeze([]),
  });
}

export function approveFinalSettlement(
  input: ApproveFinalSettlementInput,
): {
  approval: ApprovalRecord;
  settlement: SettlementExecution;
  task: FinancialTask;
  authorizedExecution: FinalSettlementAuthorizedExecution;
} {
  const {
    task,
    policy,
    servicePurchases,
    settlement,
    executionWalletAddress,
    ownerSubject,
    testMode,
  } = input;
  const now = input.now ?? new Date().toISOString();

  if (task.status !== "awaiting_approval") {
    raiseDomainError(
      "TASK_STATE_NOT_AWAITING_APPROVAL",
      `Cannot approve settlement: task is in ${task.status} state, expected awaiting_approval`,
    );
  }

  if (settlement.status !== "prepared" && settlement.status !== "awaiting_approval") {
    raiseDomainError(
      "SETTLEMENT_STATUS_INVALID",
      `Cannot approve settlement: settlement is in ${settlement.status} state, expected prepared/awaiting_approval`,
    );
  }
  if (
    task.ownerWalletAddress &&
    executionWalletAddress.toLowerCase() !== task.ownerWalletAddress.toLowerCase()
  ) {
    raiseDomainError(
      "EXECUTION_WALLET_MISMATCH",
      `Execution wallet ${executionWalletAddress} does not match task primary execution wallet ${task.ownerWalletAddress}`,
    );
  }
  assertSettlementMatchesTaskTruth(
    settlement,
    task,
    policy,
    Boolean(testMode ?? settlement.testMode),
  );
  if (!isWalletCheckPaid(servicePurchases)) {
    raiseDomainError(
      "WALLET_CHECK_UNPAID",
      "Cannot approve settlement: required wallet check purchase is not paid",
    );
  }
  const serviceEvidence = buildApprovalServiceEvidence(servicePurchases);
  const approval = createApprovalRecord({
    id: `approval-${task.id}-${settlement.id}`,
    taskId: task.id,
    settlementExecutionId: settlement.id,
    approverId: ownerSubject,
    walletAddress: executionWalletAddress,
    amount: settlement.executionAmount ?? settlement.amount,
    requestedAmount:
      settlement.requestedAmount ?? task.paymentAmount ?? settlement.amount,
    executionAmount: settlement.executionAmount ?? settlement.amount,
    testMode: Boolean(testMode ?? settlement.testMode),
    asset: settlement.amount.asset,
    recipient: settlement.recipient,
    network: settlement.network,
    policySnapshot: policy,
    serviceEvidence,
    approvedAt: now,
  });

  assertApprovalForSettlement(approval, settlement);
  assertApprovalServiceEvidence(servicePurchases, approval);


  const submittingSettlement = transitionSettlement(
    settlement,
    "submitting",
    { approval, now },
  );

  const settlingTask = transitionTask(task, "settling", {
    approval,
    serviceWork: {
      policy,
      purchases: servicePurchases,
    },
    now,
  });

  const effectiveUnits = testMode
    ? P6B_TEST_MODE_AMOUNT.units.toString()
    : settlement.amount.units.toString();

  const authorizedExecution: FinalSettlementAuthorizedExecution = Object.freeze({
    sourceWallet: executionWalletAddress,
    recipient: settlement.recipient,
    amount: settlement.amount,
    requestedAmount:
      settlement.requestedAmount ?? task.paymentAmount ?? settlement.amount,
    executionAmount: settlement.executionAmount ?? settlement.amount,
    effectiveUnits,
    testMode: Boolean(testMode ?? settlement.testMode),
    sourceChain: "Arc Testnet",
    destinationChain: "Arc Testnet",
    chainId: ARC_TESTNET_CHAIN_ID,
    operationType: "erc20_transfer",
  });
  return {
    approval,
    settlement: submittingSettlement,
    task: settlingTask,
    authorizedExecution,
  };
}

export function serializeFinalSettlementAuthorizedExecution(
  authorized: FinalSettlementAuthorizedExecution,
): SerializedFinalSettlementAuthorizedExecution {
  return Object.freeze({
    sourceWallet: authorized.sourceWallet,
    recipient: authorized.recipient,
    amount: serializeMoney(authorized.amount),
    ...(authorized.requestedAmount
      ? { requestedAmount: serializeMoney(authorized.requestedAmount) }
      : {}),
    ...(authorized.executionAmount
      ? { executionAmount: serializeMoney(authorized.executionAmount) }
      : {}),
    effectiveUnits: authorized.effectiveUnits,
    testMode: authorized.testMode,
    sourceChain: authorized.sourceChain,
    destinationChain: authorized.destinationChain,
    chainId: authorized.chainId,
    operationType: authorized.operationType,
  });
}

export function hydrateFinalSettlementAuthorizedExecution(
  raw: unknown,
): FinalSettlementAuthorizedExecution {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid authorized execution data: expected an object");
  }
  const r = raw as Record<string, unknown>;
  const amount = hydrateMoney(r.amount, "authorizedExecution.amount");
  const requestedAmount =
    r.requestedAmount !== undefined
      ? hydrateMoney(r.requestedAmount, "authorizedExecution.requestedAmount")
      : amount;
  const executionAmount =
    r.executionAmount !== undefined
      ? hydrateMoney(r.executionAmount, "authorizedExecution.executionAmount")
      : amount;
  const effectiveUnits =
    typeof r.effectiveUnits === "string"
      ? r.effectiveUnits
      : amount.units.toString();

  return Object.freeze({
    sourceWallet: String(r.sourceWallet ?? ""),
    recipient: String(r.recipient ?? ""),
    amount,
    requestedAmount,
    executionAmount,
    effectiveUnits,
    testMode: Boolean(r.testMode),
    sourceChain: "Arc Testnet",
    destinationChain: "Arc Testnet",
    chainId: ARC_TESTNET_CHAIN_ID,
    operationType: "erc20_transfer",
  });
}

export function recordFinalSettlementSubmission(
  input: SubmitFinalSettlementInput,
): {
  settlement: SettlementExecution;
  task: FinancialTask;
} {
  const { task, policy, settlement, approval, transactionHash } = input;
  const now = input.now ?? new Date().toISOString();

  if (task.status !== "settling") {
    raiseDomainError(
      "TASK_NOT_SETTLING",
      `Cannot submit settlement: task status is ${task.status}, expected settling`,
    );
  }

  assertSettlementMatchesTaskTruth(
    settlement,
    task,
    policy,
    Boolean(settlement.testMode ?? input.testMode),
  );
  assertApprovalForSettlement(approval, settlement);
  assertApprovalServiceEvidence(input.servicePurchases, approval);

  if (!transactionHash || !transactionHash.startsWith("0x")) {
    throw new Error(
      "Valid 0x transaction hash is required for settlement submission",
    );
  }

  if (
    settlement.transactionHash &&
    settlement.transactionHash.toLowerCase() === transactionHash.toLowerCase()
  ) {
    return { settlement, task };
  }

  const submitted = transitionSettlement(settlement, "submitted", {
    transactionHash,
    reconciliationState: "HASH_RECORDED_CHAIN_UNOBSERVED",
    now,
  });

  const confirming = transitionSettlement(submitted, "confirming", {
    reconciliationState: "HASH_RECORDED_CHAIN_UNOBSERVED",
    now,
  });

  return { settlement: confirming, task };
}

export async function reconcileFinalSettlementOnchain(
  input: ReconcileFinalSettlementInput,
): Promise<{
  status: "pending" | "confirmed" | "reverted";
  reconciliationState: ArcReconciliationState;
  settlement: SettlementExecution;
  task: FinancialTask;
  proof?: OmnisProof;
  message?: string;
}> {
  const { task, policy, servicePurchases, settlement, approval } = input;
  const now = input.now ?? new Date().toISOString();
  const isTestMode = Boolean(settlement.testMode ?? input.testMode);

  assertSettlementMatchesTaskTruth(settlement, task, policy, isTestMode);
  if (!approval) {
    raiseDomainError(
      "SETTLEMENT_APPROVAL_REQUIRED",
      "An approval record is required to reconcile final settlement",
    );
  }
  assertApprovalForSettlement(approval, settlement);
  assertApprovalServiceEvidence(servicePurchases, approval);

  if (!settlement.transactionHash) {
    throw new Error("Cannot reconcile settlement without transactionHash");
  }

  const client = input.publicClient ?? getArcPublicClient();
  let receipt = null;
  try {
    receipt = await client.getTransactionReceipt({
      hash: settlement.transactionHash as `0x${string}`,
    });
  } catch {
    receipt = null;
  }

  if (!receipt) {
    let tx = null;
    try {
      tx = await client.getTransaction({
        hash: settlement.transactionHash as `0x${string}`,
      });
    } catch {
      tx = null;
    }

    if (tx) {
      const recState: ArcReconciliationState = "HASH_RECORDED_RECEIPT_PENDING";
      const pendingSettlement = transitionSettlement(
        settlement,
        "confirming",
        { reconciliationState: recState, now },
      );
      return {
        status: "pending",
        reconciliationState: recState,
        settlement: pendingSettlement,
        task,
        message:
          "Transaction observed on Arc Testnet, waiting for receipt confirmation.",
      };
    }
    const expectedExecutionUnits = isTestMode
      ? (settlement.executionAmount?.units ?? P6B_TEST_MODE_AMOUNT.units)
      : (settlement.executionAmount?.units ?? settlement.amount.units);

    const txInfoFetcher = input.fallbackTxInfoFetcher ?? fetchArcScanTxInfo;
    const fallbackTx = await txInfoFetcher(settlement.transactionHash);


    if (fallbackTx) {
      const verifiedFallback = verifyArcScanTxEvidence({
        txInfo: fallbackTx,
        expectedHash: settlement.transactionHash,
        expectedSourceWallet: approval.walletAddress,
        expectedRecipient: settlement.recipient,
        expectedUnits: expectedExecutionUnits,
        now,
      });

      const fallbackEvidence: SettlementConfirmationEvidence = Object.freeze({
        source: "reconciliation",
        transactionHash: verifiedFallback.canonicalHash,
        outcome: "confirmed",
        observedAt: now,
        receiptReference: verifiedFallback.blockNumber,
        provenance: verifiedFallback.provenance,
      });

      const confirmedSettlement = transitionSettlement(
        settlement,
        "confirmed",
        {
          confirmation: fallbackEvidence,
          reconciliationState: "CONFIRMED",
          transactionHash: verifiedFallback.canonicalHash,
          now,
        },
      );

      let finalTask: FinancialTask;
      if (isTestMode) {
        finalTask =
          task.status === "settling"
            ? transitionTask(task, "awaiting_approval", {
                serviceWork: { policy, purchases: servicePurchases },
                now,
              })
            : task;
      } else {
        finalTask = transitionTask(task, "completed", {
          settlement: confirmedSettlement,
          approval,
          now,
        });
      }

      const proof = finalizeProof({
        task: finalTask,
        policy,
        servicePurchases,
        settlement: confirmedSettlement,
        approval,
        recordedAt: now,
      });

      return {
        status: "confirmed",
        reconciliationState: "CONFIRMED",
        settlement: confirmedSettlement,
        task: finalTask,
        proof,
        message: isTestMode
          ? "Test settlement confirmed via ArcScan fallback evidence. Original contractor payment NOT EXECUTED."
          : "Payment confirmed via ArcScan fallback evidence.",
      };
    }

    const recState: ArcReconciliationState = "HASH_RECORDED_CHAIN_UNOBSERVED";
    const unobservedSettlement = transitionSettlement(
      settlement,
      "confirming",
      { reconciliationState: recState, now },
    );
    return {
      status: "pending",
      reconciliationState: recState,
      settlement: unobservedSettlement,
      task,
      message:
        "Transaction identifier recorded, but Arc Testnet has not observed the transaction yet.",
    };
  }

  if (receipt.status === "success") {
    const transferTopic =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const expectedFromTopic = `0x000000000000000000000000${approval.walletAddress.toLowerCase().replace("0x", "")}`;
    const expectedToTopic = `0x000000000000000000000000${settlement.recipient.toLowerCase().replace("0x", "")}`;
    const expectedExecutionUnits = isTestMode
      ? (settlement.executionAmount?.units ?? P6B_TEST_MODE_AMOUNT.units)
      : (settlement.executionAmount?.units ?? settlement.amount.units);

    let validTransferFound = false;
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    for (const log of logs) {
      if (
        log.address.toLowerCase() !== ARC_TESTNET_USDC_ADDRESS.toLowerCase()
      ) {
        continue;
      }
      const topics = log.topics ?? [];
      if (topics[0]?.toLowerCase() !== transferTopic.toLowerCase()) continue;
      if (topics[1]?.toLowerCase() !== expectedFromTopic.toLowerCase()) {
        continue;
      }
      if (topics[2]?.toLowerCase() !== expectedToTopic.toLowerCase()) continue;
      const val = typeof log.data === "string" ? BigInt(log.data) : BigInt(0);
      if (val === expectedExecutionUnits) {
        validTransferFound = true;
        break;
      }
    }

    if (!validTransferFound) {
      raiseDomainError(
        "UNVERIFIED_SETTLEMENT_RECEIPT",
        `Onchain receipt succeeded but did not contain the expected Arc USDC Transfer event from ${approval.walletAddress} to ${settlement.recipient} for ${expectedExecutionUnits.toString()} atomic units`,
      );
    }

    const provenance: ReconciliationProvenance = Object.freeze({
      sourceType: "primary_rpc",
      sourceName: "Arc Testnet Public RPC (https://rpc.testnet.arc.network/)",
      primaryRpcObserved: true,
      fallbackObserved: false,
      verifiedAt: now,
      blockNumber: receipt.blockNumber.toString(),
      transactionHash: settlement.transactionHash,
    });

    const evidence = Object.freeze({
      source: "reconciliation" as const,
      transactionHash: settlement.transactionHash,
      outcome: "confirmed" as const,
      observedAt: now,
      receiptReference: receipt.blockNumber.toString(),
      provenance,
    });

    const confirmedSettlement = transitionSettlement(settlement, "confirmed", {
      confirmation: evidence,
      reconciliationState: "CONFIRMED",
      now,
    });

    let finalTask: FinancialTask;
    if (isTestMode) {
      finalTask =
        task.status === "settling"
          ? transitionTask(task, "awaiting_approval", {
              serviceWork: { policy, purchases: servicePurchases },
              now,
            })
          : task;
    } else {
      finalTask = transitionTask(task, "completed", {
        settlement: confirmedSettlement,
        approval,
        now,
      });
    }

    const proof = finalizeProof({
      task: finalTask,
      policy,
      servicePurchases,
      settlement: confirmedSettlement,
      approval,
      recordedAt: now,
    });

    return {
      status: "confirmed",
      reconciliationState: "CONFIRMED",
      settlement: confirmedSettlement,
      task: finalTask,
      proof,
      message: isTestMode
        ? "Test settlement confirmed on Arc Testnet. Original contractor payment NOT EXECUTED."
        : "Payment confirmed on Arc Testnet.",
    };
  }

  if (input.fallbackTxInfoFetcher) {
    const fallbackCheck = await input.fallbackTxInfoFetcher(
      settlement.transactionHash,
    );
    if (fallbackCheck?.success) {
      return raiseDomainError(
        "RECONCILIATION_CONFLICT",
        "Material conflict between primary RPC and fallback evidence: primary reported reverted while fallback reported success",
      );
    }
  }
  const revertEvidence = Object.freeze({
    source: "reconciliation" as const,
    transactionHash: settlement.transactionHash,
    outcome: "reverted" as const,
    observedAt: now,
  });

  const revertedSettlement = transitionSettlement(settlement, "reverted", {
    confirmation: revertEvidence,
    reconciliationState: "REVERTED",
    now,
  });

  return {
    status: "reverted",
    reconciliationState: "REVERTED",
    settlement: revertedSettlement,
    task,
    message: "Transaction execution reverted on Arc Testnet.",
  };
}

export type RecoverLegacyP6BSettlementInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  settlement: SettlementExecution;
  approval: ApprovalRecord;
  proof?: OmnisProof;
  transactionHash: string;
  executionWalletAddress: string;
  ownerSubject: string;
  publicClient?: PublicClient;
  fallbackTxInfoFetcher?: (
    txHash: string,
  ) => Promise<ArcScanTxInfoResult | null>;
  now?: string;
}>;
export type RecoverLegacyP6BResult = Readonly<{
  ok: boolean;
  status: "confirmed";
  reconciliationState: "CONFIRMED";
  settlement: SettlementExecution;
  approval: ApprovalRecord;
  task: FinancialTask;
  proof: OmnisProof;
  message: string;
}>;

export function assertLegacyRecoveryEligibility(
  input: RecoverLegacyP6BSettlementInput,
): void {
  if (process.env.NODE_ENV === "production") {
    raiseDomainError(
      "RECOVERY_DISABLED_IN_PRODUCTION",
      "Legacy P6B recovery is disabled in production environments.",
    );
  }

  const taskOwner = input.task.ownerSubject;
  if (
    !taskOwner ||
    input.ownerSubject.toLowerCase() !== taskOwner.toLowerCase()
  ) {
    raiseDomainError(
      "RECOVERY_OWNER_MISMATCH",
      `Authenticated owner ${input.ownerSubject} does not match task owner ${taskOwner || "missing"}`,
    );
  }

  const taskWallet = input.task.ownerWalletAddress;
  if (
    !taskWallet ||
    input.executionWalletAddress.toLowerCase() !== taskWallet.toLowerCase() ||
    input.executionWalletAddress.toLowerCase() !==
      input.approval.walletAddress.toLowerCase()
  ) {
    raiseDomainError(
      "RECOVERY_WALLET_MISMATCH",
      `Execution wallet ${input.executionWalletAddress} does not match task execution wallet ${taskWallet}`,
    );
  }

  if (
    !input.task.paymentAmount ||
    input.task.paymentAmount.units !== BigInt(50_000_000) ||
    input.task.paymentAmount.asset !== "USDC"
  ) {
    raiseDomainError(
      "RECOVERY_TASK_AMOUNT_INVALID",
      "Recovery requires authoritative task payment amount to be exactly 50 USDC.",
    );
  }

  if (!input.task.recipient || !input.task.recipient.startsWith("0x")) {
    raiseDomainError(
      "RECOVERY_RECIPIENT_MISSING",
      "Task recipient address is missing or invalid.",
    );
  }

  const paidWalletCheck = input.servicePurchases.find(
    (p) =>
      p.serviceId === "useomnis-wallet-activity-x402" && p.status === "paid",
  );
  if (
    !paidWalletCheck ||
    typeof paidWalletCheck.paymentIdentifier !== "string" ||
    !paidWalletCheck.paymentIdentifier.trim()
  ) {
    raiseDomainError(
      "RECOVERY_SERVICE_UNPAID",
      "Paid wallet check with verified Hedera payment identifier is required for recovery.",
    );
  }

  if (!input.settlement) {
    raiseDomainError(
      "RECOVERY_SETTLEMENT_INELIGIBLE",
      "Settlement record is missing.",
    );
  }

  if (
    input.settlement.status !== "submitting" ||
    Boolean(input.settlement.transactionHash)
  ) {
    raiseDomainError(
      "RECOVERY_SETTLEMENT_INELIGIBLE",
      `Settlement status ${input.settlement.status} is not eligible for legacy recovery.`,
    );
  }

  if (!input.approval) {
    raiseDomainError(
      "RECOVERY_APPROVAL_MISSING",
      "Existing approval record is required for recovery.",
    );
  }

  if (input.proof && input.proof.originalPaymentDelivered === true) {
    raiseDomainError(
      "RECOVERY_PROOF_CONFLICT",
      "Cannot recover a task that already has delivered payment proof.",
    );
  }

  const HASH_64_HEX_REGEX = /^0x[0-9a-fA-F]{64}$/;
  if (
    !input.transactionHash ||
    !HASH_64_HEX_REGEX.test(input.transactionHash)
  ) {
    raiseDomainError(
      "RECOVERY_TRANSACTION_HASH_INVALID",
      "Valid 66-character 0x hexadecimal transaction hash is required for recovery.",
    );
  }
}

export async function recoverLegacyP6BSettlement(
  input: RecoverLegacyP6BSettlementInput,
): Promise<RecoverLegacyP6BResult> {
  const now = input.now ?? new Date().toISOString();
  assertLegacyRecoveryEligibility(input);
  const client = input.publicClient ?? getArcPublicClient();
  try {
    const chainId = await client.getChainId();
    if (chainId !== ARC_TESTNET_CHAIN_ID) {
      return raiseDomainError(
        "RECOVERY_CHAIN_MISMATCH",
        `Connected chain ID ${chainId} does not match Arc Testnet ${ARC_TESTNET_CHAIN_ID}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.name === "DomainError") throw err;
    return raiseDomainError(
      "RECOVERY_CHAIN_MISMATCH",
      `Failed to verify Arc Testnet chain ID ${ARC_TESTNET_CHAIN_ID}`,
    );
  }
  const expectedExecutionUnits = P6B_TEST_MODE_AMOUNT.units; // 10,000 atomic units
  let evidenceVerified = false;
  // 1. Primary RPC verification
  try {
    const receipt = await client.getTransactionReceipt({
      hash: input.transactionHash as `0x${string}`,
    });
    if (receipt && receipt.status === "success" && receipt.blockNumber) {
      const transferTopic =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const expectedFromTopic = `0x000000000000000000000000${input.executionWalletAddress.toLowerCase().replace("0x", "")}`;
      const expectedToTopic = `0x000000000000000000000000${input.task.recipient!.toLowerCase().replace("0x", "")}`;

      const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
      for (const log of logs) {
        if (
          log.address.toLowerCase() !== ARC_TESTNET_USDC_ADDRESS.toLowerCase()
        ) {
          continue;
        }
        const topics = log.topics ?? [];
        if (topics[0]?.toLowerCase() !== transferTopic.toLowerCase()) continue;
        if (topics[1]?.toLowerCase() !== expectedFromTopic.toLowerCase()) {
          continue;
        }
        if (topics[2]?.toLowerCase() !== expectedToTopic.toLowerCase()) {
          continue;
        }
        const val = typeof log.data === "string" ? BigInt(log.data) : BigInt(0);
        if (val === expectedExecutionUnits) {
          evidenceVerified = true;
          break;
        }
      }
    }
  } catch {
    evidenceVerified = false;
  }

  // 2. Fallback verification if primary was unobserved
  if (!evidenceVerified) {
    const txInfoFetcher = input.fallbackTxInfoFetcher ?? fetchArcScanTxInfo;
    const fallbackTx = await txInfoFetcher(input.transactionHash);


    if (fallbackTx) {
      const verified = verifyArcScanTxEvidence({
        txInfo: fallbackTx,
        expectedHash: input.transactionHash,
        expectedSourceWallet: input.executionWalletAddress,
        expectedRecipient: input.task.recipient!,
        expectedUnits: expectedExecutionUnits,
        now,
      });
      if (verified.verified) {
        evidenceVerified = true;
      }
    }
  }

  if (!evidenceVerified) {
    return raiseDomainError(
      "RECOVERY_ONCHAIN_EVIDENCE_UNVERIFIED",
      `On-chain evidence could not be verified for transaction ${input.transactionHash}. Migration aborted.`,
    );
  }

  // Repair approval
  const repairedApproval: ApprovalRecord = Object.freeze({
    ...input.approval,
    requestedAmount: input.task.paymentAmount!, // 50 USDC
    executionAmount: P6B_TEST_MODE_AMOUNT, // 0.01 USDC
    amount: P6B_TEST_MODE_AMOUNT, // 0.01 USDC
    testMode: true,
  });

  // Repair settlement
  const repairedSettlement: SettlementExecution = Object.freeze({
    ...input.settlement,
    requestedAmount: input.task.paymentAmount!, // 50 USDC
    executionAmount: P6B_TEST_MODE_AMOUNT, // 0.01 USDC
    amount: P6B_TEST_MODE_AMOUNT, // 0.01 USDC
    testMode: true,
    transactionHash: input.transactionHash,
    status: "confirming" as const,
    reconciliationState: "HASH_RECORDED_CHAIN_UNOBSERVED" as const,
    updatedAt: now,
  });

  // Reconcile through P6B.4 pipeline
  const reconcileResult = await reconcileFinalSettlementOnchain({
    task: input.task,
    policy: input.policy,
    servicePurchases: input.servicePurchases,
    settlement: repairedSettlement,
    approval: repairedApproval,
    testMode: true,
    publicClient: input.publicClient,
    fallbackTxInfoFetcher: input.fallbackTxInfoFetcher,
    now,
  });

  if (reconcileResult.status !== "confirmed" || !reconcileResult.proof) {
    return raiseDomainError(
      "RECOVERY_RECONCILIATION_FAILED",
      "Reconciliation did not result in confirmed settlement outcome.",
    );
  }

  return {
    ok: true,
    status: "confirmed",
    reconciliationState: "CONFIRMED",
    settlement: reconcileResult.settlement,
    approval: repairedApproval,
    task: reconcileResult.task,
    proof: reconcileResult.proof,
    message:
      "Legacy P6B test settlement recovered and confirmed on Arc Testnet.",
  };
}
