import { assertPolicySnapshotsEqual } from "../approvals/factory";
import { raiseDomainError } from "../errors";
import {
  addMoney,
  assertMoney,
  compareMoney,
  moneyGreaterThan,
  type Money,
} from "../money";
import type {
  ServiceDescriptor,
  ServicePurchase,
  TaskPolicy,
} from "../types";
import {
  createTaskPolicy,
  evaluatePolicy,
  POLICY_REASON_CODES,
  type PolicyEvaluation,
} from "../policy/engine";

function denied(
  reasonCode: PolicyEvaluation["reasonCode"],
  explanation: string,
): PolicyEvaluation {
  return Object.freeze({
    decision: "DENY",
    reasonCode,
    explanation,
  });
}

export type ServicePurchaseAuthorizationInput = Readonly<{
  policy: TaskPolicy;
  purchase: ServicePurchase;
  service: ServiceDescriptor;
  alreadySpent: Money;
}>;

export function evaluateServicePurchase(
  input: ServicePurchaseAuthorizationInput,
): PolicyEvaluation {
  const { purchase, service } = input;
  if (purchase.taskId !== input.policy.taskId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_TASK_MISMATCH",
      "service purchase does not belong to the policy task",
    );
  }
  assertPolicySnapshotsEqual(purchase.policySnapshot, input.policy);
  if (service.status !== "available") {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_UNAVAILABLE,
      "the selected service is unavailable",
    );
  }
  if (purchase.serviceId !== service.id) {
    return raiseDomainError(
      "SERVICE_PURCHASE_SERVICE_MISMATCH",
      "service purchase does not match the selected service",
    );
  }
  assertMoney(purchase.quotedAmount);
  if (purchase.quotedAmount.asset !== service.price.asset) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
      "service quote asset does not match the service descriptor price asset",
    );
  }
  if (compareMoney(purchase.quotedAmount, service.price) > 0) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_PRICE_EXCEEDED_DESCRIPTOR,
      "service quote exceeds the descriptor price and requires re-authorization",
    );
  }
  if (purchase.paidAmount) {
    assertMoney(purchase.paidAmount);
    if (purchase.paidAmount.asset !== purchase.quotedAmount.asset) {
      return denied(
        POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
        "paid service amount does not match the quoted asset",
      );
    }
    if (moneyGreaterThan(purchase.paidAmount, purchase.quotedAmount)) {
      return denied(
        POLICY_REASON_CODES.DENY_SERVICE_AMOUNT_INCREASED,
        "paid service amount exceeds the quoted amount",
      );
    }
  }
  return evaluatePolicy({
    action: "service_purchase",
    policy: input.policy,
    alreadySpent: input.alreadySpent,
    requestedServicePrice: purchase.quotedAmount,
    serviceCategory: service.category,
    asset: purchase.quotedAmount.asset,
    network: service.network,
  });
}

export function assertServicePurchaseAllowed(
  input: ServicePurchaseAuthorizationInput,
): PolicyEvaluation {
  const result = evaluateServicePurchase(input);
  if (result.decision !== "ALLOW") {
    return raiseDomainError(result.reasonCode, result.explanation);
  }
  return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateServiceResult(purchase: ServicePurchase): void {
  const result = purchase.serviceResult;
  if (result === undefined) return;
  if (
    !isRecord(result.observations) ||
    !Array.isArray(result.heuristicFlags) ||
    result.heuristicFlags.some((flag) => !isRecord(flag))
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RESULT",
      "service result must separate observations and heuristic flags",
    );
  }
  if (
    result.disclaimer !== undefined &&
    (typeof result.disclaimer !== "string" || !result.disclaimer.trim())
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RESULT",
      "service result disclaimer must be non-empty",
    );
  }
  if (
    result.requestId !== undefined &&
    (typeof result.requestId !== "string" || !result.requestId.trim())
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RESULT",
      "service result request id must be non-empty",
    );
  }
  if (
    result.requestId &&
    purchase.requestId &&
    result.requestId !== purchase.requestId
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RESULT",
      "service result request id must match the purchase request id",
    );
  }
}

function validateRecoveryState(purchase: ServicePurchase): void {
  const recovery = purchase.recoveryState;
  if (recovery === undefined) return;
  if (
    purchase.status !== "paying" ||
    recovery.mode !== "read_only_reconcile" ||
    typeof recovery.stage !== "string" ||
    !recovery.stage.trim() ||
    typeof recovery.requestId !== "string" ||
    !recovery.requestId.trim() ||
    recovery.retryable !== false ||
    ![true, false, "unknown"].includes(recovery.settlementSent) ||
    ![true, false, "unknown"].includes(recovery.paymentSettled) ||
    typeof recovery.message !== "string" ||
    !recovery.message.trim()
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service payment recovery state is invalid",
    );
  }
  if (purchase.requestId && recovery.requestId !== purchase.requestId) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery request id must match the purchase request id",
    );
  }
  if (
    recovery.paymentIdentifier &&
    purchase.paymentIdentifier &&
    recovery.paymentIdentifier !== purchase.paymentIdentifier
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery payment identifier must match the purchase evidence",
    );
  }
  if (
    recovery.settlementNetwork !== undefined &&
    (typeof recovery.settlementNetwork !== "string" ||
      !recovery.settlementNetwork.trim())
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery network must be non-empty",
    );
  }
}

function validateServicePaymentMetadata(purchase: ServicePurchase): void {
  if (purchase.paymentAmount) assertMoney(purchase.paymentAmount);
  if (
    purchase.requestId !== undefined &&
    (typeof purchase.requestId !== "string" || !purchase.requestId.trim())
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_REQUEST_ID_INVALID",
      "service purchase request id must be non-empty",
    );
  }
  if (
    purchase.settlementNetwork !== undefined &&
    (typeof purchase.settlementNetwork !== "string" ||
      !purchase.settlementNetwork.trim())
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_NETWORK_INVALID",
      "service purchase settlement network must be non-empty",
    );
  }
  if (
    purchase.serviceResult !== undefined &&
    purchase.status !== "paid"
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_RESULT_DATA_INVALID",
      "service results are only valid for paid purchases",
    );
  }
  validateServiceResult(purchase);
  validateRecoveryState(purchase);
}

export function validateServicePurchaseRecord(purchase: ServicePurchase): void {
  assertMoney(purchase.quotedAmount);
  if (!purchase.policySnapshot || purchase.policySnapshot.taskId !== purchase.taskId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_POLICY_MISMATCH",
      "service purchase policy snapshot must belong to the task",
    );
  }
  const normalizedPolicy = createTaskPolicy(purchase.policySnapshot);
  assertPolicySnapshotsEqual(purchase.policySnapshot, normalizedPolicy);
  validateServicePaymentMetadata(purchase);
  if (
    purchase.status !== "paid" &&
    (purchase.paidAmount || purchase.paymentIdentifier) &&
    !(purchase.status === "paying" && purchase.recoveryState)
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_PAYMENT_DATA_INVALID",
      "only paid or recoverable paying purchases may carry payment evidence",
    );
  }
  if (purchase.status === "paid") {
    if (!purchase.paidAmount || !purchase.paymentIdentifier?.trim()) {
      return raiseDomainError(
        "SERVICE_PAYMENT_IDENTIFIER_REQUIRED",
        "a paid service purchase requires amount and payment identifier",
      );
    }
    assertMoney(purchase.paidAmount);
    if (purchase.paidAmount.asset !== purchase.quotedAmount.asset) {
      return raiseDomainError(
        "SERVICE_PURCHASE_ASSET_MISMATCH",
        "paid amount asset must match the quoted amount asset",
      );
    }
    if (compareMoney(purchase.paidAmount, purchase.quotedAmount) > 0) {
      return raiseDomainError(
        "SERVICE_PURCHASE_AMOUNT_INCREASED",
        "paid amount cannot exceed the quoted amount",
      );
    }
  }
}

export function sumPaidServicePurchases(
  purchases: readonly ServicePurchase[],
  zero: Money,
): Money {
  assertMoney(zero);
  const ids = new Set<string>();
  let total = zero;
  for (const purchase of purchases) {
    if (ids.has(purchase.id)) {
      return raiseDomainError(
        "DUPLICATE_SERVICE_PURCHASE_ID",
        "a service purchase cannot be counted twice",
      );
    }
    ids.add(purchase.id);
    validateServicePurchaseRecord(purchase);
    if (purchase.status !== "paid") continue;
    if (!purchase.paidAmount) {
      return raiseDomainError(
        "SERVICE_PAYMENT_AMOUNT_REQUIRED",
        "a paid service purchase must include a paid amount",
      );
    }
    if (total.asset !== purchase.paidAmount.asset) {
      return raiseDomainError(
        "SERVICE_PURCHASE_ASSET_MISMATCH",
        "paid service purchases must use one budget asset",
      );
    }
    total = addMoney(total, purchase.paidAmount);
  }
  return total;
}
export type ServicePurchaseRecoveryPlan = Readonly<{
  mode: "read_only_reconcile";
  paymentIdentifier: string;
  canRepurchase: false;
}>;

export function getServicePurchaseRecoveryPlan(
  purchase: ServicePurchase,
): ServicePurchaseRecoveryPlan {
  if (
    typeof purchase.paymentIdentifier !== "string" ||
    !purchase.paymentIdentifier.trim()
  ) {
    return raiseDomainError(
      "SERVICE_RECOVERY_NOT_AVAILABLE",
      "read-only service reconciliation requires a persisted payment identifier",
    );
  }
  return Object.freeze({
    mode: "read_only_reconcile",
    paymentIdentifier: purchase.paymentIdentifier,
    canRepurchase: false,
  });
}
