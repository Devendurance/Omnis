import {
  assertTaskPolicyMatches,
  authorizeServiceSpend,
  calculateTaskBudgetState,
  evaluateServiceSpend,
  type AuthorizeServiceSpendInput,
  type ServiceSpendEvaluation,
  type ServiceSpendInput,
  type ServiceSpendAuthorizationResult,
  type TaskBudgetState,
} from "../domain/services/budget";
import {
  markServicePurchaseCancelled,
  markServicePurchaseFailed,
  markServicePurchasePaid,
  markServicePurchasePaying,
  transitionServicePurchase,
} from "../domain/services/state-machine";
import {
  createServiceDescriptor,
  type CreateServiceDescriptorInput,
} from "../domain/services/factory";
import { raiseDomainError } from "../domain/errors";
import {
  evaluatePolicy,
  POLICY_REASON_CODES,
  type PolicyReasonCode,
} from "../domain/policy/engine";
import { money, type Money } from "../domain/money";
import { transitionTask } from "../domain/tasks/state-machine";
import type {
  FinancialTask,
  ServiceDescriptor,
  ServicePurchase,
  TaskPolicy,
} from "../domain/types";

export const LOCAL_PREVIEW_SERVICE_NETWORK = "local-preview";

export type FinalPaymentEvaluation = Readonly<{
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  reasonCode: PolicyReasonCode;
  explanation: string;
  amount: Money;
  asset: string;
  recipient: string;
  network?: string;
  approvalRequired: boolean;
}>;

export type TaskRuntimeSnapshot = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
}>;

export {
  authorizeServiceSpend,
  calculateTaskBudgetState as getTaskBudgetState,
  evaluateServiceSpend,
  markServicePurchaseCancelled,
  markServicePurchaseFailed,
  markServicePurchasePaid,
  markServicePurchasePaying,
  transitionServicePurchase,
};
export type {
  AuthorizeServiceSpendInput,
  ServiceSpendAuthorizationResult,
  ServiceSpendEvaluation,
  ServiceSpendInput,
  TaskBudgetState,
};

export function beginTaskExecution(
  task: FinancialTask,
  policy: TaskPolicy,
  now?: string,
): FinancialTask {
  assertTaskPolicyMatches(task, policy);
  if (task.status === "running") return task;
  if (task.status !== "planned") {
    return raiseDomainError(
      "TASK_EXECUTION_START_NOT_ALLOWED",
      `task cannot begin execution from ${task.status}`,
    );
  }
  if (
    (task.type === "pay_with_check" || task.type === "delegate") &&
    !policy.maxServiceSpend
  ) {
    return raiseDomainError(
      "TASK_SERVICE_BUDGET_REQUIRED",
      "bounded service work requires a configured service budget",
    );
  }
  return transitionTask(task, "running", { now });
}

export function moveTaskToAwaitingApproval(
  task: FinancialTask,
  policy: TaskPolicy,
  servicePurchases: readonly ServicePurchase[],
  now?: string,
): FinancialTask {
  assertTaskPolicyMatches(task, policy);
  if (task.status === "awaiting_approval") return task;
  if (task.status !== "running") {
    return raiseDomainError(
      "TASK_APPROVAL_PHASE_NOT_ALLOWED",
      `task cannot await approval from ${task.status}`,
    );
  }
  if (task.type === "delegate") {
    return raiseDomainError(
      "TASK_FINAL_APPROVAL_NOT_APPLICABLE",
      "delegate tasks do not have a final payment approval phase",
    );
  }
  return transitionTask(task, "awaiting_approval", {
    ...(task.type === "pay_with_check"
      ? { serviceWork: { policy, purchases: servicePurchases } }
      : {}),
    now,
  });
}

export function completeDelegateTask(
  task: FinancialTask,
  policy: TaskPolicy,
  servicePurchases: readonly ServicePurchase[],
  now?: string,
): FinancialTask {
  assertTaskPolicyMatches(task, policy);
  if (task.status === "completed") return task;
  if (task.status !== "running" || task.type !== "delegate") {
    return raiseDomainError(
      "TASK_DELEGATE_COMPLETION_NOT_ALLOWED",
      "only a running delegate task can complete in P2",
    );
  }
  return transitionTask(task, "completed", {
    serviceWork: { policy, purchases: servicePurchases },
    now,
  });
}

export function evaluateFinalPayment(input: Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  network?: string;
}>): FinalPaymentEvaluation {
  assertTaskPolicyMatches(input.task, input.policy);
  if (input.task.type === "delegate") {
    return raiseDomainError(
      "DENY_FINAL_PAYMENT_NOT_APPLICABLE",
      "delegate tasks do not have a final payment",
    );
  }
  if (!input.task.paymentAmount || !input.task.recipient) {
    return raiseDomainError(
      "FINAL_PAYMENT_INPUT_INVALID",
      "a final payment requires an amount and recipient",
    );
  }
  if (!input.task.finalPaymentApprovalRequired) {
    return Object.freeze({
      decision: "DENY",
      reasonCode: POLICY_REASON_CODES.DENY_FINAL_PAYMENT_APPROVAL_RULE_INVALID,
      explanation: "payment tasks cannot disable the final human approval boundary",
      amount: input.task.paymentAmount,
      asset: input.task.paymentAmount.asset,
      recipient: input.task.recipient,
      ...(input.network ? { network: input.network } : {}),
      approvalRequired: false,
    });
  }
  const result = evaluatePolicy({
    action: "final_payment",
    policy: input.policy,
    requestedAmount: input.task.paymentAmount,
    asset: input.task.paymentAmount.asset,
    ...(input.network ? { network: input.network } : {}),
  });
  return Object.freeze({
    decision: result.decision,
    reasonCode: result.reasonCode,
    explanation: result.explanation,
    amount: input.task.paymentAmount,
    asset: input.task.paymentAmount.asset,
    recipient: input.task.recipient,
    ...(input.network ? { network: input.network } : {}),
    approvalRequired: result.decision === "REQUIRE_APPROVAL",
  });
}

export function createPreviewServiceDescriptor(
  policy: TaskPolicy,
  quotedPrice: Money = money("0.003", "USD"),
): ServiceDescriptor {
  const input: CreateServiceDescriptorInput = {
    id: "local-preview-service",
    name: "hypothetical service",
    capability: "wallet-risk",
    category: policy.allowedServiceCategories[0] ?? "wallet-risk",
    description: "A quote used for local budget evaluation only.",
    endpoint: "catalog://preview-service",
    price: quotedPrice,
    network:
      policy.allowedServiceNetworks?.[0] ??
      policy.allowedNetworks[0] ??
      LOCAL_PREVIEW_SERVICE_NETWORK,
    paymentProtocol: "x402",
    inputSchema: {},
    outputSchema: {},
    status: "available",
    environment: "development",
    catalogOnly: true,
  };
  return createServiceDescriptor(input);
}

export function evaluatePreviewServiceQuote(input: Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  quotedPrice?: Money;
}>): ServiceSpendEvaluation {
  const quotedPrice = input.quotedPrice ?? money("0.003", "USD");
  return evaluateServiceSpend({
    task: input.task,
    policy: input.policy,
    service: createPreviewServiceDescriptor(input.policy, quotedPrice),
    quotedPrice,
    existingPurchases: input.servicePurchases,
  });
}

export function authorizePreviewServiceQuote(input: Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  quotedPrice?: Money;
  purchaseId?: string;
}>): ServiceSpendAuthorizationResult {
  const quotedPrice = input.quotedPrice ?? money("0.003", "USD");
  const service = createPreviewServiceDescriptor(input.policy, quotedPrice);
  const authorization: AuthorizeServiceSpendInput = {
    task: input.task,
    policy: input.policy,
    service,
    quotedPrice,
    existingPurchases: input.servicePurchases,
    ...(input.purchaseId ? { purchaseId: input.purchaseId } : {}),
  };
  return authorizeServiceSpend(authorization);
}
