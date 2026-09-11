import { raiseDomainError } from "../errors";
import {
  assertMoney,
  moneyEquals,
  normalizeAsset,
  type Money,
} from "../money";
import type {
  ApprovalRecord,
  FinancialTask,
  SettlementExecution,
  TaskPolicy,
} from "../types";

export type CreateApprovalRecordInput = Omit<ApprovalRecord, "decision">;

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return raiseDomainError("INVALID_APPROVAL", `${field} is required`);
  }
  return value.trim();
}

export function createApprovalRecord(
  input: CreateApprovalRecordInput,
): ApprovalRecord {
  const id = requireText(input.id, "approval id");
  const taskId = requireText(input.taskId, "approval task id");
  const executionId = requireText(
    input.settlementExecutionId,
    "settlement execution id",
  );
  const approverId = requireText(input.approverId, "approver id");
  const walletAddress = requireText(input.walletAddress, "wallet address");
  const recipient = requireText(input.recipient, "recipient");
  const network = requireText(input.network, "network");
  const approvedAt = requireText(input.approvedAt, "approval timestamp");
  assertMoney(input.amount);
  const requestedAmount = input.requestedAmount ?? input.amount;
  const executionAmount = input.executionAmount ?? input.amount;
  assertMoney(requestedAmount);
  assertMoney(executionAmount);
  if (normalizeAsset(input.asset) !== input.amount.asset) {
    return raiseDomainError(
      "APPROVAL_ASSET_MISMATCH",
      "approval asset must match the approved amount asset",
    );
  }
  if (input.policySnapshot.taskId !== taskId) {
    return raiseDomainError(
      "APPROVAL_POLICY_MISMATCH",
      "approval policy snapshot must belong to the approved task",
    );
  }
  return Object.freeze({
    ...input,
    id,
    taskId,
    settlementExecutionId: executionId,
    approverId,
    walletAddress,
    recipient,
    network,
    requestedAmount,
    executionAmount,
    testMode: Boolean(input.testMode),
    asset: normalizeAsset(input.asset),
    decision: "approved",
    approvedAt,
  });
}

export function assertApprovalForTask(
  approval: ApprovalRecord,
  taskId: FinancialTask["id"],
): void {
  if (approval.decision !== "approved" || approval.taskId !== taskId) {
    raiseDomainError(
      "APPROVAL_MISMATCH",
      "approval record does not authorize this task",
    );
  }
}

export function assertApprovalForSettlement(
  approval: ApprovalRecord,
  execution: SettlementExecution,
): void {
  if (approval.decision !== "approved") {
    raiseDomainError(
      "APPROVAL_MISMATCH",
      "only an approved record can authorize settlement",
    );
  }
  assertApprovalForTask(approval, execution.taskId);
  if (approval.settlementExecutionId !== execution.id) {
    raiseDomainError(
      "APPROVAL_MISMATCH",
      "approval record does not authorize this settlement execution",
    );
  }
  assertMoney(approval.amount);
  if (!moneyEquals(approval.amount, execution.amount)) {
    raiseDomainError(
      "APPROVAL_AMOUNT_MISMATCH",
      "approval amount does not match the settlement amount",
    );
  }
  const approvalRequested = approval.requestedAmount ?? approval.amount;
  const executionRequested = execution.requestedAmount ?? execution.amount;
  if (!moneyEquals(approvalRequested, executionRequested)) {
    raiseDomainError(
      "APPROVAL_AMOUNT_MISMATCH",
      "approval requested amount does not match the settlement requested amount",
    );
  }
  const approvalExecution = approval.executionAmount ?? approval.amount;
  const executionAmount = execution.executionAmount ?? execution.amount;
  if (!moneyEquals(approvalExecution, executionAmount)) {
    raiseDomainError(
      "APPROVAL_AMOUNT_MISMATCH",
      "approval execution amount does not match the settlement execution amount",
    );
  }
  if (Boolean(approval.testMode) !== Boolean(execution.testMode)) {
    raiseDomainError(
      "APPROVAL_MODE_MISMATCH",
      "approval test mode does not match the settlement test mode",
    );
  }
  if (normalizeAsset(approval.asset) !== execution.amount.asset) {
    raiseDomainError(
      "APPROVAL_ASSET_MISMATCH",
      "approval asset does not match the settlement asset",
    );
  }
  if (approval.recipient !== execution.recipient) {
    raiseDomainError(
      "APPROVAL_RECIPIENT_MISMATCH",
      "approval recipient does not match the settlement recipient",
    );
  }
  if (approval.network !== execution.network) {
    raiseDomainError(
      "APPROVAL_NETWORK_MISMATCH",
      "approval network does not match the settlement network",
    );
  }
  assertApprovalPolicySnapshot(approval, execution.policySnapshot);
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
function effectiveServiceNetworks(policy: TaskPolicy): readonly string[] {
  return policy.allowedServiceNetworks ?? policy.allowedNetworks;
}


function sameOptionalMoney(left: Money | undefined, right: Money | undefined): boolean {
  if (!left || !right) return left === right;
  assertMoney(left);
  assertMoney(right);
  return left.asset === right.asset && moneyEquals(left, right);
}

export function assertPolicySnapshotsEqual(
  left: TaskPolicy,
  right: TaskPolicy,
): void {
  if (
    left.taskId !== right.taskId ||
    left.finalPaymentApprovalRequired !== right.finalPaymentApprovalRequired ||
    !sameOptionalMoney(left.maxServiceSpend, right.maxServiceSpend) ||
    !sameOptionalMoney(left.maxPerService, right.maxPerService) ||
    !sameStringList(
      left.allowedServiceCategories,
      right.allowedServiceCategories,
    ) ||
    !sameStringList(
      effectiveServiceNetworks(left),
      effectiveServiceNetworks(right),
    ) ||
    !sameStringList(left.allowedAssets, right.allowedAssets) ||
    !sameStringList(left.allowedNetworks, right.allowedNetworks)
  ) {
    raiseDomainError(
      "APPROVAL_POLICY_MISMATCH",
      "policy snapshots do not match",
    );
  }
}

export function assertApprovalPolicySnapshot(
  approval: ApprovalRecord,
  policy: TaskPolicy,
): void {
  assertPolicySnapshotsEqual(approval.policySnapshot, policy);
}

export function approvalAmount(approval: ApprovalRecord): Money {
  assertMoney(approval.amount);
  return approval.amount;
}
