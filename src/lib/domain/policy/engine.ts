import { raiseDomainError } from "../errors";
import {
  assertMoney,
  compareMoney,
  formatMoney,
  normalizeAsset,
  subtractMoney,
  moneyZero,
  type Money,
} from "../money";
import {
  POLICY_DECISIONS,
  type PolicyDecision,
  type TaskPolicy,
} from "../types";

export const POLICY_REASON_CODES = {
  ALLOW_WITHIN_SERVICE_BUDGET: "ALLOW_WITHIN_SERVICE_BUDGET",
  ALLOW_SERVICE_SPEND_ALREADY_AUTHORIZED:
    "ALLOW_SERVICE_SPEND_ALREADY_AUTHORIZED",
  ALLOW_FINAL_PAYMENT_WITHIN_POLICY: "ALLOW_FINAL_PAYMENT_WITHIN_POLICY",
  DENY_TOTAL_BUDGET_EXCEEDED: "DENY_TOTAL_BUDGET_EXCEEDED",
  DENY_TOTAL_BUDGET_UNCONFIGURED: "DENY_TOTAL_BUDGET_UNCONFIGURED",
  DENY_PER_SERVICE_CAP_EXCEEDED: "DENY_PER_SERVICE_CAP_EXCEEDED",
  DENY_SERVICE_CATEGORY_NOT_ALLOWED: "DENY_SERVICE_CATEGORY_NOT_ALLOWED",
  DENY_ASSET_NOT_ALLOWED: "DENY_ASSET_NOT_ALLOWED",
  DENY_NETWORK_NOT_ALLOWED: "DENY_NETWORK_NOT_ALLOWED",
  DENY_NETWORK_REQUIRED: "DENY_NETWORK_REQUIRED",
  DENY_SERVICE_ASSET_MISMATCH: "DENY_SERVICE_ASSET_MISMATCH",
  DENY_SERVICE_PRICE_EXCEEDED_DESCRIPTOR:
    "DENY_SERVICE_PRICE_EXCEEDED_DESCRIPTOR",
  DENY_SERVICE_UNAVAILABLE: "DENY_SERVICE_UNAVAILABLE",
  DENY_SERVICE_AMOUNT_INCREASED: "DENY_SERVICE_AMOUNT_INCREASED",
  DENY_INVALID_SERVICE_QUOTE: "DENY_INVALID_SERVICE_QUOTE",
  DENY_TASK_SERVICE_WORK_NOT_ALLOWED: "DENY_TASK_SERVICE_WORK_NOT_ALLOWED",
  DENY_SERVICE_PURCHASE_ALREADY_FINALIZED:
    "DENY_SERVICE_PURCHASE_ALREADY_FINALIZED",
  DENY_FINAL_PAYMENT_NOT_APPLICABLE: "DENY_FINAL_PAYMENT_NOT_APPLICABLE",
  DENY_FINAL_PAYMENT_APPROVAL_RULE_INVALID:
    "DENY_FINAL_PAYMENT_APPROVAL_RULE_INVALID",
  REQUIRE_FINAL_PAYMENT_APPROVAL: "REQUIRE_FINAL_PAYMENT_APPROVAL",
} as const;
export type PolicyReasonCode =
  (typeof POLICY_REASON_CODES)[keyof typeof POLICY_REASON_CODES];

export type PolicyEvaluation = Readonly<{
  decision: PolicyDecision;
  reasonCode: PolicyReasonCode;
  explanation: string;
  /** Remaining service budget after an allowed request, otherwise before it. */
  remainingBudget?: Money;
}>;

export type ServicePurchasePolicyInput = Readonly<{
  action: "service_purchase";
  policy: TaskPolicy;
  alreadySpent: Money;
  requestedServicePrice: Money;
  serviceCategory: string;
  asset: string;
  network: string;
}>;

export type FinalPaymentPolicyInput = Readonly<{
  action: "final_payment";
  policy: TaskPolicy;
  requestedAmount: Money;
  asset: string;
  network?: string;
}>;

export type PolicyEvaluationInput =
  | ServicePurchasePolicyInput
  | FinalPaymentPolicyInput;

export type CreateTaskPolicyInput = TaskPolicy;

function normalizedList(values: readonly string[], normalize: (value: string) => string, field: string): readonly string[] {
  if (!Array.isArray(values)) {
    return raiseDomainError("INVALID_POLICY", `${field} must be an array`);
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      return raiseDomainError("INVALID_POLICY", `${field} contains an empty value`);
    }
    return normalize(value);
  });
  return Object.freeze([...new Set(normalized)]);
}

function normalizeNetwork(network: string): string {
  if (typeof network !== "string" || !network.trim()) {
    return raiseDomainError("INVALID_NETWORK", "network is required");
  }
  return network.trim().toLowerCase();
}

function normalizeCategory(category: string): string {
  if (typeof category !== "string" || !category.trim()) {
    return raiseDomainError("INVALID_SERVICE_CATEGORY", "service category is required");
  }
  return category.trim().toLowerCase();
}

export function createTaskPolicy(input: CreateTaskPolicyInput): TaskPolicy {
  if (typeof input.taskId !== "string" || !input.taskId.trim()) {
    return raiseDomainError("INVALID_POLICY", "policy task id is required");
  }
  if (input.maxServiceSpend) assertMoney(input.maxServiceSpend);
  if (input.maxPerService) assertMoney(input.maxPerService);
  if (typeof input.finalPaymentApprovalRequired !== "boolean") {
    return raiseDomainError(
      "INVALID_POLICY",
      "final payment approval requirement must be explicit",
    );
  }
  const allowedServiceNetworks =
    input.allowedServiceNetworks === undefined
      ? undefined
      : normalizedList(
          input.allowedServiceNetworks,
          normalizeNetwork,
          "allowed service networks",
        );
  return Object.freeze({
    ...input,
    taskId: input.taskId.trim(),
    maxServiceSpend: input.maxServiceSpend,
    maxPerService: input.maxPerService,
    allowedServiceCategories: normalizedList(
      input.allowedServiceCategories,
      normalizeCategory,
      "allowed service categories",
    ),
    ...(allowedServiceNetworks
      ? { allowedServiceNetworks }
      : {}),
    allowedAssets: normalizedList(input.allowedAssets, normalizeAsset, "allowed assets"),
    allowedNetworks: normalizedList(
      input.allowedNetworks,
      normalizeNetwork,
      "allowed networks",
    ),
  });
}

function denied(
  reasonCode: PolicyReasonCode,
  explanation: string,
  remainingBudget?: Money,
): PolicyEvaluation {
  return Object.freeze({
    decision: POLICY_DECISIONS[2],
    reasonCode,
    explanation,
    ...(remainingBudget ? { remainingBudget } : {}),
  });
}

function requireAssetAllowed(
  policy: TaskPolicy,
  asset: string,
): PolicyEvaluation | string {
  const normalized = normalizeAsset(asset);
  if (!policy.allowedAssets.includes(normalized)) {
    return denied(
      POLICY_REASON_CODES.DENY_ASSET_NOT_ALLOWED,
      `${normalized} is not an allowed payment asset for this task`,
    );
  }
  return normalized;
}

function allowedServiceNetworks(policy: TaskPolicy): readonly string[] {
  return policy.allowedServiceNetworks ?? policy.allowedNetworks;
}

function requireNetworkAllowed(
  network: string,
  allowedNetworks: readonly string[],
): PolicyEvaluation | string {
  const normalized = normalizeNetwork(network);
  if (!allowedNetworks.includes(normalized)) {
    return denied(
      POLICY_REASON_CODES.DENY_NETWORK_NOT_ALLOWED,
      `${normalized} is not an allowed network for this task`,
    );
  }
  return normalized;
}

function evaluateServicePurchase(
  input: ServicePurchasePolicyInput,
): PolicyEvaluation {
  const { policy, alreadySpent, requestedServicePrice } = input;
  assertMoney(alreadySpent);
  assertMoney(requestedServicePrice);
  const allowedAsset = requireAssetAllowed(policy, input.asset);
  if (typeof allowedAsset !== "string") return allowedAsset;
  const allowedNetwork = requireNetworkAllowed(
    input.network,
    allowedServiceNetworks(policy),
  );
  if (typeof allowedNetwork !== "string") return allowedNetwork;
  if (allowedAsset !== requestedServicePrice.asset) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
      `requested service asset ${requestedServicePrice.asset} does not match ${allowedAsset}`,
    );
  }
  if (requestedServicePrice.asset !== alreadySpent.asset) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
      `requested service asset ${requestedServicePrice.asset} does not match already spent ${alreadySpent.asset}`,
    );
  }

  const category = normalizeCategory(input.serviceCategory);
  if (!policy.allowedServiceCategories.includes(category)) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_CATEGORY_NOT_ALLOWED,
      `${category} is not an allowed service category`,
    );
  }
  if (!policy.maxServiceSpend) {
    return denied(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_UNCONFIGURED,
      "a total service budget must be configured before a service can be purchased",
    );
  }
  assertMoney(policy.maxServiceSpend);
  if (policy.maxServiceSpend.asset !== requestedServicePrice.asset) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
      `service budget asset ${policy.maxServiceSpend.asset} does not match requested service asset ${requestedServicePrice.asset}`,
    );
  }

  const remainingBefore =
    compareMoney(alreadySpent, policy.maxServiceSpend) > 0
      ? moneyZero(policy.maxServiceSpend.asset, policy.maxServiceSpend.decimals)
      : subtractMoney(policy.maxServiceSpend, alreadySpent);
  if (compareMoney(alreadySpent, policy.maxServiceSpend) > 0) {
    return denied(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_EXCEEDED,
      "already spent service budget exceeds the task service budget",
      remainingBefore,
    );
  }
  if (policy.maxPerService) {
    assertMoney(policy.maxPerService);
    if (policy.maxPerService.asset !== requestedServicePrice.asset) {
      return denied(
        POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
        `per-service cap asset ${policy.maxPerService.asset} does not match requested service asset ${requestedServicePrice.asset}`,
        remainingBefore,
      );
    }
    if (compareMoney(requestedServicePrice, policy.maxPerService) > 0) {
      return denied(
        POLICY_REASON_CODES.DENY_PER_SERVICE_CAP_EXCEEDED,
        "requested service price exceeds the per-service cap",
        remainingBefore,
      );
    }
  }
  if (compareMoney(requestedServicePrice, remainingBefore) > 0) {
    return denied(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_EXCEEDED,
      "requested service price exceeds the remaining task service budget",
      remainingBefore,
    );
  }

  const remainingAfter = subtractMoney(remainingBefore, requestedServicePrice);
  return Object.freeze({
    decision: POLICY_DECISIONS[0],
    reasonCode: POLICY_REASON_CODES.ALLOW_WITHIN_SERVICE_BUDGET,
    explanation: `service purchase is allowed on ${allowedNetwork} within the remaining service budget and per-service cap`,
    remainingBudget: remainingAfter,
  });
}

function evaluateFinalPayment(input: FinalPaymentPolicyInput): PolicyEvaluation {
  const { policy, requestedAmount } = input;
  assertMoney(requestedAmount);
  const allowedAsset = requireAssetAllowed(policy, input.asset);
  if (typeof allowedAsset !== "string") return allowedAsset;
  if (allowedAsset !== requestedAmount.asset) {
    return denied(
      POLICY_REASON_CODES.DENY_SERVICE_ASSET_MISMATCH,
      `requested payment asset ${requestedAmount.asset} does not match ${allowedAsset}`,
    );
  }
  if (!input.network) {
    if (policy.finalPaymentApprovalRequired) {
      return Object.freeze({
        decision: POLICY_DECISIONS[1],
        reasonCode: POLICY_REASON_CODES.REQUIRE_FINAL_PAYMENT_APPROVAL,
        explanation: `the ${formatAmount(requestedAmount)} final payment requires explicit human approval before a settlement network is selected`,
      });
    }
    return denied(
      POLICY_REASON_CODES.DENY_NETWORK_REQUIRED,
      "a settlement network is required before an unapproved final payment can proceed",
    );
  }
  const allowedNetwork = requireNetworkAllowed(
    input.network,
    policy.allowedNetworks,
  );
  if (typeof allowedNetwork !== "string") return allowedNetwork;
  if (policy.finalPaymentApprovalRequired) {
    return Object.freeze({
      decision: POLICY_DECISIONS[1],
      reasonCode: POLICY_REASON_CODES.REQUIRE_FINAL_PAYMENT_APPROVAL,
      explanation: `the ${formatAmount(requestedAmount)} final payment on ${allowedNetwork} requires explicit human approval`,
    });
  }
  return Object.freeze({
    decision: POLICY_DECISIONS[0],
    reasonCode: POLICY_REASON_CODES.ALLOW_FINAL_PAYMENT_WITHIN_POLICY,
    explanation: `final payment is allowed on ${allowedNetwork} without an additional approval boundary`,
  });
}

function formatAmount(value: Money): string {
  return `${formatMoney(value)} ${value.asset}`;
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  if (input.action === "service_purchase") return evaluateServicePurchase(input);
  if (input.action === "final_payment") return evaluateFinalPayment(input);
  return raiseDomainError("INVALID_POLICY_ACTION", "unsupported policy action");
}

export function assertPolicyAllows(result: PolicyEvaluation): void {
  if (result.decision !== POLICY_DECISIONS[0]) {
    raiseDomainError(result.reasonCode, result.explanation);
  }
}
