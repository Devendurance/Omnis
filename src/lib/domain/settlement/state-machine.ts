import { assertApprovalForSettlement } from "../approvals/factory";
import { raiseDomainError } from "../errors";
import { assertMoney } from "../money";
import {
  SETTLEMENT_STATUSES,
  type ApprovalRecord,
  type ArcReconciliationState,
  type SettlementConfirmationEvidence,
  type SettlementExecution,
  type SettlementStatus,
} from "../types";

const SETTLEMENT_TRANSITIONS: Readonly<
  Record<SettlementStatus, readonly SettlementStatus[]>
> = {
  prepared: ["awaiting_approval", "submitting", "failed"],
  awaiting_approval: ["submitting", "failed"],
  submitting: ["submitted", "failed"],
  submitted: ["confirming"],
  confirming: [
    "confirming",
    "confirmed",
    "confirmation_delayed",
    "reverted",
    "failed",
  ],
  confirmation_delayed: [
    "confirming",
    "confirmation_delayed",
    "confirmed",
    "reverted",
  ],
  confirmed: [],
  reverted: [],
  failed: [],
};

export type CreateSettlementExecutionInput = Omit<
  SettlementExecution,
  "status" | "createdAt" | "updatedAt"
>;

export type SettlementTransitionContext = Readonly<{
  approval?: ApprovalRecord;
  transactionHash?: string;
  confirmation?: SettlementConfirmationEvidence;
  reconciliationState?: ArcReconciliationState;
  errorCode?: string;
  now?: string;
}>;

export type SettlementRecoveryPlan = Readonly<{
  mode: "read_only_reconcile";
  transactionHash: string;
  canResubmit: false;
}>;

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return raiseDomainError("INVALID_SETTLEMENT", `${field} is required`);
  }
  return value.trim();
}

export function createSettlementExecution(
  input: CreateSettlementExecutionInput,
  now = new Date().toISOString(),
): SettlementExecution {
  const id = requireText(input.id, "settlement execution id");
  const taskId = requireText(input.taskId, "settlement task id");
  const provider = requireText(input.provider, "settlement provider");
  const recipient = requireText(input.recipient, "settlement recipient");
  const network = requireText(input.network, "settlement network");
  const timestamp = requireText(now, "settlement timestamp");
  assertMoney(input.amount);
  const requestedAmount = input.requestedAmount ?? input.amount;
  const executionAmount = input.executionAmount ?? input.amount;
  assertMoney(requestedAmount);
  assertMoney(executionAmount);
  if (
    !input.policySnapshot ||
    input.policySnapshot.taskId !== taskId
  ) {
    return raiseDomainError(
      "SETTLEMENT_POLICY_MISMATCH",
      "settlement policy snapshot must belong to the task",
    );
  }
  if (
    typeof input.approvalRequired !== "boolean" ||
    input.policySnapshot.finalPaymentApprovalRequired !== input.approvalRequired
  ) {
    return raiseDomainError(
      "SETTLEMENT_APPROVAL_POLICY_MISMATCH",
      "settlement approval requirement must match the policy snapshot",
    );
  }
  return Object.freeze({
    ...input,
    id,
    taskId,
    provider,
    recipient,
    network,
    requestedAmount,
    executionAmount,
    testMode: Boolean(input.testMode),
    status: "prepared",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function canTransitionSettlement(
  from: SettlementStatus,
  to: SettlementStatus,
): boolean {
  return SETTLEMENT_TRANSITIONS[from].includes(to);
}

export function isSettlementTerminal(status: SettlementStatus): boolean {
  return status === "confirmed" || status === "reverted" || status === "failed";
}

function requireTimestamp(value: string | undefined): string {
  if (value === undefined) return "";
  if (!value.trim()) {
    return raiseDomainError(
      "INVALID_SETTLEMENT_TIMESTAMP",
      "settlement transition timestamp is empty",
    );
  }
  return value;
}

function requireTransactionHash(
  execution: SettlementExecution,
  transactionHash: string | undefined,
): string {
  if (execution.transactionHash) {
    return raiseDomainError(
      "SETTLEMENT_RESUBMISSION_FORBIDDEN",
      "a settlement with a transaction identifier cannot be submitted again",
    );
  }
  if (typeof transactionHash !== "string" || !transactionHash.trim()) {
    return raiseDomainError(
      "SETTLEMENT_TRANSACTION_IDENTIFIER_REQUIRED",
      "submission must persist a transaction identifier",
    );
  }
  return transactionHash.trim();
}

function requireTrustedConfirmation(
  execution: SettlementExecution,
  evidence: SettlementConfirmationEvidence | undefined,
  outcome: "confirmed" | "reverted",
): SettlementConfirmationEvidence {
  if (
    !evidence ||
    evidence.source !== "reconciliation" ||
    evidence.outcome !== outcome ||
    typeof evidence.transactionHash !== "string" ||
    !evidence.transactionHash.trim() ||
    typeof evidence.observedAt !== "string" ||
    !evidence.observedAt.trim()
  ) {
    return raiseDomainError(
      "UNTRUSTED_SETTLEMENT_CONFIRMATION",
      "only reconciliation evidence can finalize settlement truth",
    );
  }
  if (!execution.transactionHash) {
    return raiseDomainError(
      "SETTLEMENT_TRANSACTION_IDENTIFIER_REQUIRED",
      "confirmation requires a persisted transaction identifier",
    );
  }
  if (evidence.transactionHash !== execution.transactionHash) {
    return raiseDomainError(
      "SETTLEMENT_TRANSACTION_MISMATCH",
      "reconciliation evidence does not match the persisted transaction",
    );
  }
  return evidence;
}

function transitionResult(
  execution: SettlementExecution,
  status: SettlementStatus,
  context: SettlementTransitionContext,
  changes: Readonly<Record<string, unknown>> = {},
): SettlementExecution {
  const updatedAt = requireTimestamp(context.now) || execution.updatedAt;
  const reconciliationState =
    context.reconciliationState ?? execution.reconciliationState;
  return Object.freeze({
    ...execution,
    ...changes,
    ...(reconciliationState ? { reconciliationState } : {}),
    status,
    updatedAt,
  });
}

export function transitionSettlement(
  execution: SettlementExecution,
  nextStatus: SettlementStatus,
  context: SettlementTransitionContext = {},
): SettlementExecution {
  if (!SETTLEMENT_STATUSES.includes(nextStatus)) {
    return raiseDomainError(
      "INVALID_SETTLEMENT_STATUS",
      `unsupported settlement status: ${nextStatus}`,
    );
  }
  if (!canTransitionSettlement(execution.status, nextStatus)) {
    return raiseDomainError(
      "SETTLEMENT_TRANSITION_NOT_ALLOWED",
      `cannot transition settlement from ${execution.status} to ${nextStatus}`,
      { from: execution.status, to: nextStatus },
    );
  }

  if (nextStatus === "submitting") {
    if (execution.transactionHash) {
      return raiseDomainError(
        "SETTLEMENT_RESUBMISSION_FORBIDDEN",
        "a settlement with a transaction identifier cannot be submitted again",
      );
    }
    if (execution.approvalRequired) {
      if (!context.approval) {
        return raiseDomainError(
          "SETTLEMENT_APPROVAL_REQUIRED",
          "an approval record is required before settlement submission",
        );
      }
      assertApprovalForSettlement(context.approval, execution);
    }
  }

  if (nextStatus === "submitted") {
    const transactionHash = requireTransactionHash(
      execution,
      context.transactionHash,
    );
    return transitionResult(execution, nextStatus, context, {
      transactionHash,
    });
  }

  if (nextStatus === "confirming" && !execution.transactionHash) {
    return raiseDomainError(
      "SETTLEMENT_TRANSACTION_IDENTIFIER_REQUIRED",
      "confirmation requires a persisted transaction identifier",
    );
  }

  if (nextStatus === "confirmed" || nextStatus === "reverted") {
    const evidence = requireTrustedConfirmation(
      execution,
      context.confirmation,
      nextStatus,
    );
    return transitionResult(execution, nextStatus, context, {
      confirmationEvidence: evidence,
      errorCode: undefined,
    });
  }

  if (nextStatus === "confirmation_delayed") {
    return transitionResult(execution, nextStatus, context, {
      errorCode: context.errorCode?.trim() || "CONFIRMATION_DELAYED",
    });
  }

  if (nextStatus === "failed") {
    return transitionResult(execution, nextStatus, context, {
      errorCode: context.errorCode?.trim() || "SETTLEMENT_FAILED",
    });
  }

  return transitionResult(execution, nextStatus, context);
}

export function settlementTransitions(): Readonly<
  Record<SettlementStatus, readonly SettlementStatus[]>
> {
  return SETTLEMENT_TRANSITIONS;
}

export function getSettlementRecoveryPlan(
  execution: SettlementExecution,
): SettlementRecoveryPlan {
  if (execution.status !== "confirmation_delayed" || !execution.transactionHash) {
    return raiseDomainError(
      "SETTLEMENT_RECOVERY_NOT_AVAILABLE",
      "read-only reconciliation is available only for delayed confirmation with an identifier",
    );
  }
  return Object.freeze({
    mode: "read_only_reconcile",
    transactionHash: execution.transactionHash,
    canResubmit: false,
  });
}
