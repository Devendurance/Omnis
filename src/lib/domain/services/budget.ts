import { assertPolicySnapshotsEqual } from "../approvals/factory";
import { raiseDomainError } from "../errors";
import {
  addMoney,
  assertMoney,
  compareMoney,
  moneyGreaterThan,
  moneyZero,
  subtractMoney,
  type Money,
} from "../money";
import {
  POLICY_REASON_CODES,
  type PolicyEvaluation,
  type PolicyReasonCode,
} from "../policy/engine";
import type {
  FinancialTask,
  ServiceDescriptor,
  ServicePurchase,
  TaskPolicy,
} from "../types";
import { createServicePurchase } from "./factory";
import { transitionServicePurchase } from "./state-machine";
import {
  evaluateServicePurchase,
  validateServicePurchaseRecord,
} from "./validation";

export type TaskBudgetState = Readonly<{
  taskId: string;
  configuredServiceBudget?: Money;
  confirmedSpend: Money;
  reservedSpend: Money;
  remainingAvailable: Money;
}>;

export type ServiceSpendEvaluation = Readonly<{
  decision: "ALLOW" | "DENY";
  reasonCode: PolicyReasonCode;
  explanation: string;
  requestedAmount: Money;
  confirmedSpend: Money;
  reservedSpend: Money;
  remainingBefore: Money;
  remainingAfter: Money;
}>;

export type ServiceSpendAuthorizationResult = Readonly<
  ServiceSpendEvaluation & {
    purchaseAuthorizationId?: string;
    purchase?: ServicePurchase;
  }
>;

export type ServiceSpendInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  service: ServiceDescriptor;
  quotedPrice: Money;
  existingPurchases: readonly ServicePurchase[];
}>;

export type AuthorizeServiceSpendInput = ServiceSpendInput &
  Readonly<{
    purchaseId?: string;
  }>;

function sameOptionalMoney(left: Money | undefined, right: Money | undefined): boolean {
  if (!left || !right) return left === right;
  assertMoney(left);
  assertMoney(right);
  return left.asset === right.asset && compareMoney(left, right) === 0;
}

export function assertTaskPolicyMatches(
  task: FinancialTask,
  policy: TaskPolicy,
): void {
  if (task.id !== policy.taskId) {
    return raiseDomainError(
      "P2_POLICY_TASK_MISMATCH",
      "task policy must belong to the task",
    );
  }
  if (
    !sameOptionalMoney(task.serviceBudget, policy.maxServiceSpend) ||
    !sameOptionalMoney(task.perServiceCap, policy.maxPerService) ||
    task.finalPaymentApprovalRequired !== policy.finalPaymentApprovalRequired
  ) {
    return raiseDomainError(
      "P2_POLICY_TASK_MISMATCH",
      "task financial boundaries must match the active policy",
    );
  }
}

function budgetBasis(
  task: FinancialTask,
  policy: TaskPolicy,
): Money | undefined {
  assertTaskPolicyMatches(task, policy);
  return policy.maxServiceSpend ?? task.serviceBudget;
}

function assertUniquePurchaseIds(
  purchases: readonly ServicePurchase[],
): void {
  const ids = new Set<string>();
  for (const purchase of purchases) {
    if (ids.has(purchase.id)) {
      return raiseDomainError(
        "DUPLICATE_SERVICE_PURCHASE_ID",
        "a service purchase ledger cannot contain the same purchase twice",
      );
    }
    ids.add(purchase.id);
  }
}

export function validateServicePurchaseLedger(
  task: FinancialTask,
  policy: TaskPolicy,
  purchases: readonly ServicePurchase[],
): void {
  assertTaskPolicyMatches(task, policy);
  assertUniquePurchaseIds(purchases);
  for (const purchase of purchases) {
    validateServicePurchaseRecord(purchase);
    if (purchase.taskId !== task.id) {
      return raiseDomainError(
        "SERVICE_PURCHASE_TASK_MISMATCH",
        "service purchase does not belong to the task ledger",
      );
    }
    assertPolicySnapshotsEqual(purchase.policySnapshot, policy);
  }
}

function zeroForBudget(
  basis: Money | undefined,
  purchases: readonly ServicePurchase[],
): Money {
  if (basis) return moneyZero(basis.asset, basis.decimals);
  const firstPurchase = purchases[0];
  return firstPurchase
    ? moneyZero(firstPurchase.quotedAmount.asset, firstPurchase.quotedAmount.decimals)
    : moneyZero("USD");
}

export function calculateTaskBudgetState(
  task: FinancialTask,
  policy: TaskPolicy,
  purchases: readonly ServicePurchase[] = [],
): TaskBudgetState {
  validateServicePurchaseLedger(task, policy, purchases);
  const basis = budgetBasis(task, policy);
  const zero = zeroForBudget(basis, purchases);
  let confirmedSpend = zero;
  let reservedSpend = zero;

  for (const purchase of purchases) {
    if (purchase.status === "paid") {
      if (!purchase.paidAmount) {
        return raiseDomainError(
          "SERVICE_PAYMENT_AMOUNT_REQUIRED",
          "a paid service purchase must include a paid amount",
        );
      }
      confirmedSpend = addMoney(confirmedSpend, purchase.paidAmount);
    } else if (
      purchase.status === "approved" ||
      purchase.status === "paying"
    ) {
      reservedSpend = addMoney(reservedSpend, purchase.quotedAmount);
    }
  }

  const consumed = addMoney(confirmedSpend, reservedSpend);
  const remainingAvailable = basis
    ? compareMoney(consumed, basis) > 0
      ? moneyZero(basis.asset, basis.decimals)
      : subtractMoney(basis, consumed)
    : zero;

  return Object.freeze({
    taskId: task.id,
    ...(basis ? { configuredServiceBudget: basis } : {}),
    confirmedSpend,
    reservedSpend,
    remainingAvailable,
  });
}

function denied(
  result: PolicyEvaluation,
  input: ServiceSpendInput,
  state: TaskBudgetState,
): ServiceSpendEvaluation {
  return Object.freeze({
    decision: "DENY",
    reasonCode: result.reasonCode,
    explanation: result.explanation,
    requestedAmount: input.quotedPrice,
    confirmedSpend: state.confirmedSpend,
    reservedSpend: state.reservedSpend,
    remainingBefore: state.remainingAvailable,
    remainingAfter: state.remainingAvailable,
  });
}

function taskStateDenied(
  input: ServiceSpendInput,
  state: TaskBudgetState,
): ServiceSpendEvaluation {
  return Object.freeze({
    decision: "DENY",
    reasonCode: POLICY_REASON_CODES.DENY_TASK_SERVICE_WORK_NOT_ALLOWED,
    explanation: "service work is only allowed while the task is planned or running",
    requestedAmount: input.quotedPrice,
    confirmedSpend: state.confirmedSpend,
    reservedSpend: state.reservedSpend,
    remainingBefore: state.remainingAvailable,
    remainingAfter: state.remainingAvailable,
  });
}

function invalidQuoteDenied(
  input: ServiceSpendInput,
  state: TaskBudgetState,
): ServiceSpendEvaluation {
  return Object.freeze({
    decision: "DENY",
    reasonCode: POLICY_REASON_CODES.DENY_INVALID_SERVICE_QUOTE,
    explanation: "a service quote must be greater than zero",
    requestedAmount: input.quotedPrice,
    confirmedSpend: state.confirmedSpend,
    reservedSpend: state.reservedSpend,
    remainingBefore: state.remainingAvailable,
    remainingAfter: state.remainingAvailable,
  });
}

function evaluationPurchase(input: ServiceSpendInput): ServicePurchase {
  return createServicePurchase({
    id: `evaluation-${input.task.id}-${input.service.id}-${input.quotedPrice.units.toString()}`,
    taskId: input.task.id,
    serviceId: input.service.id,
    quotedAmount: input.quotedPrice,
    policySnapshot: input.policy,
    status: "quoted",
    createdAt: input.task.updatedAt,
    updatedAt: input.task.updatedAt,
  }, input.task.updatedAt);
}

function evaluateServiceSpendInternal(
  input: ServiceSpendInput,
  requireRunning: boolean,
): ServiceSpendEvaluation {
  assertMoney(input.quotedPrice);
  assertMoney(input.service.price);
  const state = calculateTaskBudgetState(
    input.task,
    input.policy,
    input.existingPurchases,
  );

  if (
    (requireRunning && input.task.status !== "running") ||
    (!requireRunning &&
      input.task.status !== "planned" &&
      input.task.status !== "running")
  ) {
    return taskStateDenied(input, state);
  }
  if (input.quotedPrice.units === BigInt(0)) {
    return invalidQuoteDenied(input, state);
  }

  const alreadySpent = addMoney(state.confirmedSpend, state.reservedSpend);
  const policyResult = evaluateServicePurchase({
    policy: input.policy,
    purchase: evaluationPurchase(input),
    service: input.service,
    alreadySpent,
  });
  if (policyResult.decision !== "ALLOW") {
    return denied(policyResult, input, state);
  }

  return Object.freeze({
    decision: "ALLOW",
    reasonCode: policyResult.reasonCode,
    explanation: policyResult.explanation,
    requestedAmount: input.quotedPrice,
    confirmedSpend: state.confirmedSpend,
    reservedSpend: state.reservedSpend,
    remainingBefore: state.remainingAvailable,
    remainingAfter: subtractMoney(state.remainingAvailable, input.quotedPrice),
  });
}

export function evaluateServiceSpend(
  input: ServiceSpendInput,
): ServiceSpendEvaluation {
  return evaluateServiceSpendInternal(input, false);
}

function nextPurchaseId(
  input: AuthorizeServiceSpendInput,
): string {
  const base = `purchase-${input.task.id}-${input.service.id}-${input.quotedPrice.units.toString()}`;
  const ids = new Set(input.existingPurchases.map((purchase) => purchase.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function authorizeServiceSpend(
  input: AuthorizeServiceSpendInput,
): ServiceSpendAuthorizationResult {
  const requestedPurchaseId = input.purchaseId?.trim();
  if (requestedPurchaseId) {
    const existing = input.existingPurchases.find(
      (purchase) => purchase.id === requestedPurchaseId,
    );
    if (existing) {
      const state = calculateTaskBudgetState(
        input.task,
        input.policy,
        input.existingPurchases,
      );
      if (input.task.status !== "running") {
        return taskStateDenied(input, state);
      }
      assertMoney(input.quotedPrice);
      assertMoney(input.service.price);
      if (input.quotedPrice.units === BigInt(0)) {
        return invalidQuoteDenied(input, state);
      }
      if (existing.serviceId !== input.service.id) {
        return raiseDomainError(
          "SERVICE_PURCHASE_ID_CONFLICT",
          "the authorization id belongs to a different service",
        );
      }
      if (
        existing.quotedAmount.asset !== input.quotedPrice.asset ||
        compareMoney(existing.quotedAmount, input.quotedPrice) !== 0
      ) {
        return raiseDomainError(
          "SERVICE_PURCHASE_ID_CONFLICT",
          "the authorization id belongs to a different quoted amount",
        );
      }
      assertPolicySnapshotsEqual(existing.policySnapshot, input.policy);
      if (existing.status === "approved" || existing.status === "paying") {
        return Object.freeze({
          decision: "ALLOW",
          reasonCode: POLICY_REASON_CODES.ALLOW_SERVICE_SPEND_ALREADY_AUTHORIZED,
          explanation: "the service spend is already authorized and reserved",
          requestedAmount: input.quotedPrice,
          confirmedSpend: state.confirmedSpend,
          reservedSpend: state.reservedSpend,
          remainingBefore: state.remainingAvailable,
          remainingAfter: state.remainingAvailable,
          purchaseAuthorizationId: existing.id,
          purchase: existing,
        });
      }
      if (existing.status === "paid") {
        return Object.freeze({
          decision: "DENY",
          reasonCode: POLICY_REASON_CODES.DENY_SERVICE_PURCHASE_ALREADY_FINALIZED,
          explanation: "a paid service purchase cannot be authorized again",
          requestedAmount: input.quotedPrice,
          confirmedSpend: state.confirmedSpend,
          reservedSpend: state.reservedSpend,
          remainingBefore: state.remainingAvailable,
          remainingAfter: state.remainingAvailable,
        });
      }
      return raiseDomainError(
        "SERVICE_PURCHASE_ID_CONFLICT",
        "a failed or cancelled service purchase id cannot be reused",
      );
    }
  }

  const evaluation = evaluateServiceSpendInternal(input, true);
  if (evaluation.decision !== "ALLOW") return evaluation;

  const state = calculateTaskBudgetState(
    input.task,
    input.policy,
    input.existingPurchases,
  );
  const purchaseId = requestedPurchaseId || nextPurchaseId(input);
  const quoted = createServicePurchase({
    id: purchaseId,
    taskId: input.task.id,
    serviceId: input.service.id,
    quotedAmount: input.quotedPrice,
    policySnapshot: input.policy,
    status: "quoted",
    createdAt: input.task.updatedAt,
    updatedAt: input.task.updatedAt,
  }, input.task.updatedAt);
  const purchase = transitionServicePurchase(quoted, "approved", {
    now: input.task.updatedAt,
  });
  return Object.freeze({
    ...evaluation,
    reservedSpend: addMoney(state.reservedSpend, input.quotedPrice),
    purchaseAuthorizationId: purchase.id,
    purchase,
  });
}

export function assertServiceWorkComplete(
  task: FinancialTask,
  policy: TaskPolicy,
  purchases: readonly ServicePurchase[],
): void {
  validateServicePurchaseLedger(task, policy, purchases);
  const hasPaidPurchase = purchases.some((purchase) => purchase.status === "paid");
  const hasPendingPurchase = purchases.some(
    (purchase) =>
      purchase.status === "quoted" ||
      purchase.status === "approved" ||
      purchase.status === "paying",
  );
  if (!hasPaidPurchase || hasPendingPurchase) {
    return raiseDomainError(
      "TASK_SERVICE_WORK_INCOMPLETE",
      "all required service purchases must be paid before the task can advance",
    );
  }
}

export function hasServiceBudgetAvailable(state: TaskBudgetState): boolean {
  return Boolean(
    state.configuredServiceBudget &&
      !moneyGreaterThan(state.confirmedSpend, state.configuredServiceBudget),
  );
}
