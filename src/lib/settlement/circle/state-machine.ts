import type { PublicClient, Hash } from "viem";
import type {
  CircleSettlementEvidence,
  CircleSettlementExecution,
  CircleSettlementExecutionStatus,
  CircleSettlementFailureReason,
  SettlementConfirmationParams,
} from "./types";
import { ARC_TESTNET_EXPLORER_URL } from "../arc/config";
import { getArcPublicClient } from "./adapter";

export const CIRCLE_SETTLEMENT_TRANSITIONS: Readonly<
  Record<
    CircleSettlementExecutionStatus,
    readonly CircleSettlementExecutionStatus[]
  >
> = {
  prepared: ["awaiting_approval", "submitting", "failed"],
  awaiting_approval: ["submitting", "failed"],
  submitting: ["submitted", "failed"],
  submitted: ["confirming", "confirmation_delayed", "failed"],
  confirming: ["confirmed", "confirmation_delayed", "reverted", "failed"],
  confirmation_delayed: ["confirming", "confirmed", "reverted", "failed"],
  confirmed: [],
  reverted: [],
  failed: [],
};

export function canTransitionCircleSettlement(
  from: CircleSettlementExecutionStatus,
  to: CircleSettlementExecutionStatus,
): boolean {
  return CIRCLE_SETTLEMENT_TRANSITIONS[from].includes(to);
}

export function isCircleSettlementTerminal(
  status: CircleSettlementExecutionStatus,
): boolean {
  return status === "confirmed" || status === "reverted" || status === "failed";
}

export type CreateExecutionInput = Readonly<{
  id: string;
  taskId?: string;
  params: SettlementConfirmationParams;
  status?: CircleSettlementExecutionStatus;
}>;

export function createCircleSettlementExecution(
  input: CreateExecutionInput,
  now = new Date().toISOString(),
): CircleSettlementExecution {
  return {
    id: input.id,
    taskId: input.taskId,
    operationType: input.params.operationType,
    params: input.params,
    status: input.status ?? "prepared",
    createdAt: now,
    updatedAt: now,
  };
}

export type TransitionContext = Readonly<{
  transactionHash?: string;
  failureReason?: CircleSettlementFailureReason;
  errorMessage?: string;
  evidence?: CircleSettlementEvidence;
  now?: string;
}>;

export function transitionCircleSettlement(
  execution: CircleSettlementExecution,
  nextStatus: CircleSettlementExecutionStatus,
  context: TransitionContext = {},
): CircleSettlementExecution {
  if (!canTransitionCircleSettlement(execution.status, nextStatus)) {
    throw new Error(
      `Illegal settlement transition from ${execution.status} to ${nextStatus}`,
    );
  }

  const now = context.now ?? new Date().toISOString();

  // Guard: if transitioning to submitted or confirming, transactionHash must be present or already set
  const txHash = context.transactionHash ?? execution.transactionHash;
  if ((nextStatus === "submitted" || nextStatus === "confirming") && !txHash) {
    throw new Error(
      `Cannot transition to ${nextStatus} without a transaction hash`,
    );
  }

  // Guard: if transitioning to confirmed, evidence must be present
  if (nextStatus === "confirmed") {
    if (!context.evidence && !execution.evidence) {
      throw new Error(
        "Cannot transition to confirmed without settlement evidence",
      );
    }
  }

  return {
    ...execution,
    status: nextStatus,
    transactionHash: txHash,
    failureReason: context.failureReason ?? execution.failureReason,
    errorMessage: context.errorMessage ?? execution.errorMessage,
    evidence: context.evidence ?? execution.evidence,
    submittedAt:
      nextStatus === "submitted"
        ? now
        : execution.submittedAt,
    confirmedAt:
      nextStatus === "confirmed" || nextStatus === "reverted"
        ? now
        : execution.confirmedAt,
    updatedAt: now,
  };
}

export type ReconcileOutcome = Readonly<{
  reconciled: boolean;
  status: CircleSettlementExecutionStatus;
  execution: CircleSettlementExecution;
  note: string;
}>;

/**
 * Read-only reconciliation against Arc Testnet RPC.
 * NEVER re-submits transactions. Checks on-chain receipt when txHash is known.
 */
export async function reconcileCircleSettlementOnchain(
  execution: CircleSettlementExecution,
  publicClient?: PublicClient,
  now = new Date().toISOString(),
): Promise<ReconcileOutcome> {
  // If already in a terminal state, nothing to reconcile
  if (isCircleSettlementTerminal(execution.status)) {
    return {
      reconciled: false,
      status: execution.status,
      execution,
      note: `Settlement is already in terminal state: ${execution.status}`,
    };
  }

  if (!execution.transactionHash) {
    return {
      reconciled: false,
      status: execution.status,
      execution,
      note: "No transaction hash recorded; cannot reconcile onchain",
    };
  }

  const client = getArcPublicClient(publicClient);

  try {
    const receipt = await client.getTransactionReceipt({
      hash: execution.transactionHash as Hash,
    });

    if (!receipt) {
      // Transaction still pending onchain
      const updated = transitionCircleSettlement(
        execution,
        "confirmation_delayed",
        {
          failureReason: "confirmation_delayed",
          errorMessage: "Transaction submitted but receipt not yet available",
          now,
        },
      );
      return {
        reconciled: true,
        status: "confirmation_delayed",
        execution: updated,
        note: "Transaction receipt is still pending on Arc Testnet",
      };
    }

    if (receipt.status === "success") {
      const evidence: CircleSettlementEvidence = {
        executionWallet: execution.params.sourceWallet,
        recipient: execution.params.recipient,
        amount: execution.params.amount,
        asset: "USDC",
        sourceChain: "Arc_Testnet",
        destinationChain: execution.params.destinationChain,
        circleOperation: execution.operationType,
        transactionHash: execution.transactionHash,
        explorerUrl: `${ARC_TESTNET_EXPLORER_URL}/tx/${execution.transactionHash}`,
        confirmedStatus: "confirmed",
        blockNumber: Number(receipt.blockNumber),
        timestamp: now,
        reconciliationSource: "onchain_receipt",
      };

      const updated = transitionCircleSettlement(execution, "confirmed", {
        evidence,
        now,
      });

      return {
        reconciled: true,
        status: "confirmed",
        execution: updated,
        note: `Transaction confirmed in block ${receipt.blockNumber}`,
      };
    } else {
      // Receipt status === 'reverted'
      const updated = transitionCircleSettlement(execution, "reverted", {
        failureReason: "reverted",
        errorMessage: "Transaction reverted on Arc Testnet",
        now,
      });

      return {
        reconciled: true,
        status: "reverted",
        execution: updated,
        note: "Transaction reverted on Arc Testnet",
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      reconciled: false,
      status: execution.status,
      execution,
      note: `Reconciliation query error: ${msg}`,
    };
  }
}
