import {
  assertApprovalForSettlement,
  assertPolicySnapshotsEqual,
} from "../approvals/factory";
import { raiseDomainError } from "../errors";
import {
  assertMoney,
  moneyZero,
  serializeMoney,
  type Money,
} from "../money";
import {
  sumPaidServicePurchases,
  validateServicePurchaseRecord,
} from "../services/validation";
import type {
  ApprovalRecord,
  FinancialTask,
  OmnisProof,
  ProofStatus,
  ServicePurchase,
  SettlementExecution,
  TaskPolicy,
} from "../types";
import { proofIdentityKey } from "./idempotency";

export type ProofFinalizationInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  settlement?: SettlementExecution;
  approval?: ApprovalRecord;
  intent?: unknown;
  agentSummary?: string;
  recordedAt?: string;
}>;

function stableSerialize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function" || typeof value === "symbol") {
    return `${typeof value}:unsupported`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  }
  if (typeof value !== "object") return `${typeof value}:unsupported`;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const record = value as Record<string, unknown>;
  const serialized = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
    .join(",");
  seen.delete(value);
  return `{${serialized}}`;
}

function defaultIntent(task: FinancialTask): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: task.type,
    recipient: task.recipient,
    paymentAmount: task.paymentAmount
      ? serializeMoney(task.paymentAmount)
      : undefined,
    purpose: task.purpose,
  });
}

function requireRecordedAt(input: ProofFinalizationInput): string {
  const recordedAt = input.recordedAt ?? input.settlement?.updatedAt ?? input.task.updatedAt;
  if (typeof recordedAt !== "string" || !recordedAt.trim()) {
    return raiseDomainError("INVALID_PROOF", "proof timestamp is required");
  }
  return recordedAt;
}

function requireTrustedConfirmedSettlement(
  settlement: SettlementExecution,
): void {
  if (!settlement.transactionHash) {
    return raiseDomainError(
      "PROOF_REQUIRES_CONFIRMED_SETTLEMENT",
      "confirmed proof requires a settlement transaction identifier",
    );
  }
  const evidence = settlement.confirmationEvidence;
  if (
    !evidence ||
    evidence.source !== "reconciliation" ||
    evidence.outcome !== "confirmed" ||
    evidence.transactionHash !== settlement.transactionHash ||
    typeof evidence.observedAt !== "string" ||
    !evidence.observedAt.trim()
  ) {
    return raiseDomainError(
      "PROOF_REQUIRES_TRUSTED_SETTLEMENT_EVIDENCE",
      "proof cannot treat agent text as confirmation of settlement",
    );
  }
}

function requireProofOutcome(
  task: FinancialTask,
  settlement: SettlementExecution | undefined,
): void {
  if (
    settlement &&
    !["confirmed", "reverted", "failed"].includes(settlement.status)
  ) {
    return raiseDomainError(
      "PROOF_SETTLEMENT_NOT_TERMINAL",
      "proof can only record a terminal settlement outcome",
    );
  }
  if (settlement?.status === "confirmed") {
    requireTrustedConfirmedSettlement(settlement);
  }
  if (settlement?.testMode) {
    if (settlement.status !== "confirmed") {
      return raiseDomainError(
        "PROOF_REQUIRES_CONFIRMED_SETTLEMENT",
        "demo verification proof requires a confirmed test settlement",
      );
    }
    return;
  }
  if (task.status === "completed") {
    if (!settlement || settlement.status !== "confirmed") {
      return raiseDomainError(
        "PROOF_REQUIRES_CONFIRMED_SETTLEMENT",
        "completed proof requires a confirmed settlement with a transaction identifier",
      );
    }
    return;
  }
  if (settlement?.status === "confirmed") {
    return raiseDomainError(
      "PROOF_TASK_SETTLEMENT_STATUS_MISMATCH",
      "a confirmed settlement cannot belong to a non-completed task proof",
    );
  }
}
function serviceSpendZero(
  task: FinancialTask,
  policy: TaskPolicy,
  purchases: readonly ServicePurchase[],
): Money {
  const basis = policy.maxServiceSpend ?? task.serviceBudget ?? purchases[0]?.quotedAmount;
  if (!basis) return moneyZero("USD");
  assertMoney(basis);
  return moneyZero(basis.asset, basis.decimals);
}

function requirePolicyForTask(task: FinancialTask, policy: TaskPolicy): void {
  if (policy.taskId !== task.id) {
    return raiseDomainError(
      "PROOF_POLICY_MISMATCH",
      "proof policy snapshot must belong to the task",
    );
  }
}

function requireSettlementOwnership(
  task: FinancialTask,
  settlement: SettlementExecution | undefined,
): void {
  if (settlement && settlement.taskId !== task.id) {
    return raiseDomainError(
      "PROOF_SETTLEMENT_MISMATCH",
      "proof settlement must belong to the task",
    );
  }
}

function buildProof(input: ProofFinalizationInput): OmnisProof {
  const { task, policy, servicePurchases, settlement, approval } = input;
  const isTestMode = Boolean(settlement?.testMode);
  if (
    !isTestMode &&
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled"
  ) {
    return raiseDomainError(
      "PROOF_TASK_NOT_TERMINAL",
      "proof can only be finalized for a terminal task",
    );
  }
  const status: ProofStatus = isTestMode
    ? "demo_verified"
    : (task.status as "completed" | "failed" | "cancelled");
  requirePolicyForTask(task, policy);
  requireSettlementOwnership(task, settlement);
  requireProofOutcome(task, settlement);
  if (settlement) assertPolicySnapshotsEqual(settlement.policySnapshot, policy);
  if (settlement && approval) assertApprovalForSettlement(approval, settlement);
  if (settlement?.approvalRequired && !approval) {
    return raiseDomainError(
      "PROOF_APPROVAL_REQUIRED",
      "proof for an approved settlement must include its approval record",
    );
  }

  const spendZero = serviceSpendZero(task, policy, servicePurchases);
  for (const purchase of servicePurchases) validateServicePurchaseRecord(purchase);
  const totalServiceSpend = sumPaidServicePurchases(servicePurchases, spendZero);
  const identity = proofIdentityKey(task.id, settlement?.id ?? "no-settlement");
  const recordedAt = requireRecordedAt(input);
  return Object.freeze({
    id: identity,
    idempotencyKey: identity,
    taskId: task.id,
    ownerId: task.ownerId,
    createdAt: recordedAt,
    intent: input.intent ?? defaultIntent(task),
    task,
    policy,
    servicePurchases: Object.freeze([...servicePurchases]),
    totalServiceSpend,
    ...(approval ? { approval } : {}),
    ...(settlement ? { finalPayment: settlement } : {}),
    status,
    testMode: isTestMode,
    demoVerificationStatus: isTestMode ? "complete" : undefined,
    originalPaymentDelivered: isTestMode ? false : task.status === "completed",
    ...(settlement?.confirmationEvidence?.provenance
      ? {
          reconciliationProvenance:
            settlement.confirmationEvidence.provenance,
        }
      : {}),
    ...(input.agentSummary ? { agentSummary: input.agentSummary } : {}),
  });
}
export function finalizeProof(
  input: ProofFinalizationInput,
  existingProof?: OmnisProof,
): OmnisProof {
  const candidate = buildProof(input);
  if (!existingProof) return candidate;
  if (existingProof.idempotencyKey !== candidate.idempotencyKey) {
    return raiseDomainError(
      "PROOF_IDEMPOTENCY_KEY_MISMATCH",
      "existing proof belongs to a different task execution",
    );
  }
  if (stableSerialize(existingProof) !== stableSerialize(candidate)) {
    return raiseDomainError(
      "PROOF_IDEMPOTENCY_CONFLICT",
      "proof finalization input changed for an existing identity",
    );
  }
  return existingProof;
}

export function finalizeProofIdempotently(
  input: ProofFinalizationInput,
  existingProof?: OmnisProof,
): OmnisProof {
  return finalizeProof(input, existingProof);
}
