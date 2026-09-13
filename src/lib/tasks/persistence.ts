import {
  assertTaskPolicyMatches,
  calculateTaskBudgetState,
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createSettlementExecution,
  createTaskPolicy,
  finalizeProof,
  moneyEquals,
  normalizeAsset,
  hydrateMoney,
  serializeMoney,
  transitionTask,
  validateServicePurchaseLedger,
  validateServicePurchaseRecord,
  SERVICE_PURCHASE_STATUSES,
  SETTLEMENT_STATUSES,
  type ApprovalRecord,
  type ApprovalServiceEvidence,
  type ArcReconciliationState,
  type FinancialTask,
  type FinancialTaskStatus,
  type FinancialTaskType,
  type Money,
  type OmnisProof,
  type PersistedServiceResult,
  type ProofStatus,
  type ReconciliationProvenance,
  type SerializedMoney,
  type ServicePurchase,
  type ServicePurchaseRecoveryState,
  type SettlementConfirmationEvidence,
  type SettlementExecution,
  type SettlementStatus,
  type TaskPolicy,
} from "../domain";
import {
  INTENT_MISSING_FIELDS,
  type FinancialIntentFields,
} from "../intent/types";
import {
  INITIAL_TASK_SESSION_VERSION,
  EARLIER_TASK_SESSION_VERSION,
  LEGACY_TASK_SESSION_VERSION,
  TASK_SESSION_VERSION,
  type ChatMessage,
  type ChatMessageKind,
  type ChatMessageRole,
  type TaskBudgetSnapshot,
  type TaskDiscoveryState,
  type TaskSession,
} from "./session";
import {
  isSupportedServiceCapability,
  resolveRequiredCapability,
} from "../services/capabilities";
import { serviceRegistry, type ServiceRegistry } from "../services/registry";
import type { TaskPlanView } from "./presentation";
import type { StoredServiceRecommendation } from "../recommendation/verifier";

export const DRAFT_SESSION_STORAGE_KEY = "useomnis:p1:draft-session";
export const USER_SESSION_STORAGE_PREFIX = "useomnis:session:";

export function getTaskSessionStorageKey(ownerSubject?: string): string {
  const clean = ownerSubject?.trim();
  if (!clean) return DRAFT_SESSION_STORAGE_KEY;
  return `${USER_SESSION_STORAGE_PREFIX}${clean}`;
}
const MAX_MESSAGES = 100;
const MAX_PURCHASES = 100;
const MAX_MESSAGE_LENGTH = 8_000;
const PERSISTED_TASK_STATUSES: readonly FinancialTaskStatus[] = [
  "draft",
  "planned",
  "running",
  "awaiting_approval",
  "settling",
  "completed",
  "failed",
  "cancelled",
];
const FINANCIAL_TASK_TYPES: readonly FinancialTaskType[] = [
  "pay",
  "pay_with_check",
  "delegate",
];
const TASK_PLAN_STATUSES: readonly FinancialTaskStatus[] = ["draft", "planned"];
const MESSAGE_ROLES: readonly ChatMessageRole[] = ["user", "omnis"];
const MESSAGE_KINDS: readonly ChatMessageKind[] = [
  "message",
  "clarification",
  "plan",
];

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PersistedTask = Omit<
  FinancialTask,
  "paymentAmount" | "serviceBudget" | "perServiceCap"
> & {
  paymentAmount?: SerializedMoney;
  serviceBudget?: SerializedMoney;
  perServiceCap?: SerializedMoney;
  ownerSubject?: string;
  ownerWalletAddress?: string;
};

export type PersistedPolicy = Omit<
  TaskPolicy,
  "maxServiceSpend" | "maxPerService"
> & {
  maxServiceSpend?: SerializedMoney;
  maxPerService?: SerializedMoney;
};

export type PersistedServicePurchase = Omit<
  ServicePurchase,
  | "quotedAmount"
  | "paymentAmount"
  | "paidAmount"
  | "policySnapshot"
  | "serviceResult"
  | "recoveryState"
> & {
  quotedAmount: SerializedMoney;
  paymentAmount?: SerializedMoney;
  paidAmount?: SerializedMoney;
  serviceResult?: PersistedServiceResult;
  recoveryState?: ServicePurchaseRecoveryState;
  policySnapshot: PersistedPolicy;
};

export type PersistedBudget = Omit<
  TaskBudgetSnapshot,
  | "configuredServiceBudget"
  | "confirmedSpend"
  | "reservedSpend"
  | "remainingAvailable"
> & {
  configuredServiceBudget?: SerializedMoney;
  confirmedSpend: SerializedMoney;
  reservedSpend: SerializedMoney;
  remainingAvailable: SerializedMoney;
};

type PersistedPendingIntent = Readonly<{
  type?: FinancialIntentFields["type"];
  recipient?: string;
  paymentAmount?: SerializedMoney;
  paymentAmountText?: string;
  paymentAsset?: string;
  purpose?: string;
  serviceBudget?: SerializedMoney;
  perServiceCap?: SerializedMoney;
  finalPaymentApprovalRequired?: boolean;
  unsupportedAsset?: string;
}>;
export type PersistedRecommendation = StoredServiceRecommendation;
type PersistedDiscovery = TaskDiscoveryState;

export type PersistedApproval = Readonly<{
  id: string;
  taskId: string;
  settlementExecutionId: string;
  approverId: string;
  walletAddress: string;
  amount: SerializedMoney;
  requestedAmount?: SerializedMoney;
  executionAmount?: SerializedMoney;
  testMode?: boolean;
  asset: string;
  recipient: string;
  network: string;
  policySnapshot: PersistedPolicy;
  decision: "approved";
  approvedAt: string;
  serviceEvidence?: Readonly<{
    paidPurchaseIds: readonly string[];
    paidTotal: SerializedMoney;
  }>;
}>;

export type PersistedSettlement = Readonly<{
  id: string;
  taskId: string;
  provider: string;
  amount: SerializedMoney;
  requestedAmount?: SerializedMoney;
  executionAmount?: SerializedMoney;
  testMode?: boolean;
  recipient: string;
  network: string;
  approvalRequired: boolean;
  policySnapshot: PersistedPolicy;
  status: SettlementStatus;
  transactionHash?: string;
  reconciliationState?: ArcReconciliationState;
  errorCode?: string;
  confirmationEvidence?: SettlementConfirmationEvidence;
  createdAt: string;
  updatedAt: string;
}>;

export type PersistedProof = Readonly<{
  id: string;
  idempotencyKey: string;
  taskId: string;
  ownerId: string;
  createdAt: string;
  intent: unknown;
  task: PersistedTask;
  policy: PersistedPolicy;
  servicePurchases: readonly PersistedServicePurchase[];
  totalServiceSpend: SerializedMoney;
  approval?: PersistedApproval;
  finalPayment?: PersistedSettlement;
  status: ProofStatus;
  testMode?: boolean;
  demoVerificationStatus?: "complete" | "not_executed" | "failed";
  originalPaymentDelivered?: boolean;
  reconciliationProvenance?: ReconciliationProvenance;
  agentSummary?: string;
}>;

type PersistedSession = Readonly<{
  version: typeof TASK_SESSION_VERSION;
  ownerSubject?: string;
  ownerWalletAddress?: string;
  messages: readonly ChatMessage[];
  pendingIntent?: PersistedPendingIntent;
  task?: PersistedTask;
  policy?: PersistedPolicy;
  servicePurchases?: readonly PersistedServicePurchase[];
  budget?: PersistedBudget;
  discovery?: PersistedDiscovery;
  recommendation?: PersistedRecommendation;
  approval?: PersistedApproval;
  settlement?: PersistedSettlement;
  proof?: PersistedProof;
}>;

type RawTask = {
  id?: unknown;
  ownerId?: unknown;
  ownerSubject?: unknown;
  ownerWalletAddress?: unknown;
  type?: unknown;
  status?: unknown;
  originalIntent?: unknown;
  recipient?: unknown;
  paymentAmount?: unknown;
  purpose?: unknown;
  serviceBudget?: unknown;
  perServiceCap?: unknown;
  finalPaymentApprovalRequired?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type RawPolicy = {
  taskId?: unknown;
  maxServiceSpend?: unknown;
  maxPerService?: unknown;
  allowedServiceCategories?: unknown;
  allowedServiceNetworks?: unknown;
  allowedAssets?: unknown;
  allowedNetworks?: unknown;
  finalPaymentApprovalRequired?: unknown;
};
type RawServicePurchase = {
  id?: unknown;
  taskId?: unknown;
  serviceId?: unknown;
  quotedAmount?: unknown;
  paymentAmount?: unknown;
  paidAmount?: unknown;
  requestId?: unknown;
  paymentIdentifier?: unknown;
  settlementNetwork?: unknown;
  serviceResult?: unknown;
  recoveryState?: unknown;
  policySnapshot?: unknown;
  status?: unknown;
  resultDigest?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};
type RawPlan = {
  taskId?: unknown;
  status?: unknown;
  type?: unknown;
  title?: unknown;
  purpose?: unknown;
  recipient?: unknown;
  payment?: unknown;
  serviceBudget?: unknown;
  perServiceCap?: unknown;
  serviceRequirement?: unknown;
  approvalBoundary?: unknown;
  nextAction?: unknown;
  missing?: unknown;
};

type RawMessage = {
  id?: unknown;
  role?: unknown;
  kind?: unknown;
  content?: unknown;
  plan?: unknown;
  createdAt?: unknown;
};

type RawPendingIntent = {
  type?: unknown;
  recipient?: unknown;
  paymentAmount?: unknown;
  paymentAmountText?: unknown;
  paymentAsset?: unknown;
  purpose?: unknown;
  serviceBudget?: unknown;
  perServiceCap?: unknown;
  finalPaymentApprovalRequired?: unknown;
  unsupportedAsset?: unknown;
};

type RawApproval = {
  id?: unknown;
  taskId?: unknown;
  settlementExecutionId?: unknown;
  approverId?: unknown;
  walletAddress?: unknown;
  amount?: unknown;
  requestedAmount?: unknown;
  executionAmount?: unknown;
  testMode?: unknown;
  asset?: unknown;
  recipient?: unknown;
  network?: unknown;
  policySnapshot?: unknown;
  decision?: unknown;
  approvedAt?: unknown;
  serviceEvidence?: unknown;
};

type RawSettlement = {
  id?: unknown;
  taskId?: unknown;
  provider?: unknown;
  amount?: unknown;
  requestedAmount?: unknown;
  executionAmount?: unknown;
  testMode?: unknown;
  recipient?: unknown;
  network?: unknown;
  approvalRequired?: unknown;
  policySnapshot?: unknown;
  status?: unknown;
  transactionHash?: unknown;
  reconciliationState?: unknown;
  errorCode?: unknown;
  confirmationEvidence?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type RawProof = {
  id?: unknown;
  idempotencyKey?: unknown;
  taskId?: unknown;
  ownerId?: unknown;
  createdAt?: unknown;
  intent?: unknown;
  task?: unknown;
  policy?: unknown;
  servicePurchases?: unknown;
  totalServiceSpend?: unknown;
  approval?: unknown;
  finalPayment?: unknown;
  status?: unknown;
  testMode?: unknown;
  demoVerificationStatus?: unknown;
  originalPaymentDelivered?: unknown;
  reconciliationProvenance?: unknown;
  agentSummary?: unknown;
};

type RawSession = {
  version?: unknown;
  ownerSubject?: unknown;
  ownerWalletAddress?: unknown;
  messages?: unknown;
  pendingIntent?: unknown;
  task?: unknown;
  policy?: unknown;
  servicePurchases?: unknown;
  budget?: unknown;
  discovery?: unknown;
  recommendation?: unknown;
  approval?: unknown;
  settlement?: unknown;
  proof?: unknown;
};
type RawDiscovery = {
  requiredCapability?: unknown;
  selectedServiceId?: unknown;
  discoveredAt?: unknown;
  registryVersion?: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} is required`);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${field} is invalid`);
  }
  return value as T;
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => requiredString(entry, field));
}

// hydrateMoney is imported from @/lib/domain

function optionalMoney(value: unknown, field: string): Money | undefined {
  if (value === undefined) return undefined;
  return hydrateMoney(value, field);
}
const MAX_SERVICE_RESULT_BYTES = 64_000;

function recordValue(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function hydrateServiceResult(
  value: unknown,
  field = "service result",
): PersistedServiceResult {
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > MAX_SERVICE_RESULT_BYTES) {
    throw new Error(`${field} is too large or not JSON-safe`);
  }
  const candidate = recordValue(value, field);
  const observations = recordValue(
    candidate.observations,
    `${field}.observations`,
  );
  if (!Array.isArray(candidate.heuristicFlags)) {
    throw new Error(`${field}.heuristicFlags must be an array`);
  }
  const heuristicFlags = candidate.heuristicFlags.map((flag) =>
    Object.freeze({ ...recordValue(flag, `${field}.heuristicFlags`) }),
  );
  return Object.freeze({
    observations: Object.freeze({ ...observations }),
    heuristicFlags: Object.freeze(heuristicFlags),
    ...(candidate.disclaimer === undefined
      ? {}
      : {
          disclaimer: requiredString(
            candidate.disclaimer,
            `${field}.disclaimer`,
          ),
        }),
    ...(candidate.requestId === undefined
      ? {}
      : {
          requestId: requiredString(candidate.requestId, `${field}.requestId`),
        }),
  });
}

function hydrateRecoveryState(
  value: unknown,
  field = "service recovery",
): ServicePurchaseRecoveryState {
  const candidate = recordValue(value, field);
  if (candidate.mode !== "read_only_reconcile") {
    throw new Error(`${field}.mode is invalid`);
  }
  if (
    ![true, false, "unknown"].includes(candidate.settlementSent as never) ||
    ![true, false, "unknown"].includes(candidate.paymentSettled as never) ||
    candidate.retryable !== false
  ) {
    throw new Error(`${field} settlement state is invalid`);
  }
  return Object.freeze({
    mode: "read_only_reconcile",
    stage: requiredString(candidate.stage, `${field}.stage`),
    requestId: requiredString(candidate.requestId, `${field}.requestId`),
    ...(candidate.paymentIdentifier === undefined
      ? {}
      : {
          paymentIdentifier: requiredString(
            candidate.paymentIdentifier,
            `${field}.paymentIdentifier`,
          ),
        }),
    ...(candidate.settlementNetwork === undefined
      ? {}
      : {
          settlementNetwork: requiredString(
            candidate.settlementNetwork,
            `${field}.settlementNetwork`,
          ),
        }),
    settlementSent: candidate.settlementSent as boolean | "unknown",
    paymentSettled: candidate.paymentSettled as boolean | "unknown",
    retryable: false,
    message: requiredString(candidate.message, `${field}.message`),
  });
}

function hydratePendingIntent(value: unknown): FinancialIntentFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted pending intent is invalid");
  }
  const candidate = value as RawPendingIntent;
  const type =
    candidate.type === undefined
      ? undefined
      : enumValue(candidate.type, FINANCIAL_TASK_TYPES, "pending intent type");
  const recipient = optionalString(
    candidate.recipient,
    "pending intent recipient",
  );
  const paymentAmount = optionalMoney(
    candidate.paymentAmount,
    "pending intent payment amount",
  );
  const paymentAmountText = optionalString(
    candidate.paymentAmountText,
    "pending intent payment amount text",
  );
  const paymentAssetValue = optionalString(
    candidate.paymentAsset,
    "pending intent payment asset",
  );
  const paymentAsset = paymentAssetValue
    ? normalizeAsset(paymentAssetValue)
    : undefined;
  const purpose = optionalString(candidate.purpose, "pending intent purpose");
  const serviceBudget = optionalMoney(
    candidate.serviceBudget,
    "pending intent service budget",
  );
  const perServiceCap = optionalMoney(
    candidate.perServiceCap,
    "pending intent per-service cap",
  );
  const finalPaymentApprovalRequired =
    candidate.finalPaymentApprovalRequired === undefined
      ? undefined
      : requiredBoolean(
          candidate.finalPaymentApprovalRequired,
          "pending intent finalPaymentApprovalRequired",
        );
  const unsupportedAssetValue = optionalString(
    candidate.unsupportedAsset,
    "pending intent unsupported asset",
  );
  const unsupportedAsset = unsupportedAssetValue
    ? normalizeAsset(unsupportedAssetValue)
    : undefined;

  if (paymentAmount && paymentAmount.asset !== "USDC") {
    throw new Error("pending intent payments must use USDC");
  }
  if (serviceBudget && serviceBudget.asset !== "USD") {
    throw new Error("pending intent service budgets must use USD");
  }
  if (perServiceCap && perServiceCap.asset !== "USD") {
    throw new Error("pending intent service caps must use USD");
  }
  if (paymentAmount && paymentAsset && paymentAmount.asset !== paymentAsset) {
    throw new Error("pending intent payment asset does not match its amount");
  }
  if (
    serviceBudget &&
    perServiceCap &&
    serviceBudget.asset !== perServiceCap.asset
  ) {
    throw new Error(
      "pending intent service cap asset does not match its budget",
    );
  }
  if (
    type &&
    finalPaymentApprovalRequired !== undefined &&
    finalPaymentApprovalRequired !== (type !== "delegate")
  ) {
    throw new Error("pending intent approval rule is invalid");
  }

  return Object.freeze({
    ...(type ? { type } : {}),
    ...(recipient ? { recipient } : {}),
    ...(paymentAmount ? { paymentAmount } : {}),
    ...(paymentAmountText !== undefined ? { paymentAmountText } : {}),
    ...(paymentAsset ? { paymentAsset } : {}),
    ...(purpose ? { purpose } : {}),
    ...(serviceBudget ? { serviceBudget } : {}),
    ...(perServiceCap ? { perServiceCap } : {}),
    ...(finalPaymentApprovalRequired !== undefined
      ? { finalPaymentApprovalRequired }
      : {}),
    ...(unsupportedAsset ? { unsupportedAsset } : {}),
  });
}
function hydrateDiscovery(
  value: unknown,
  task: FinancialTask | undefined,
  registry: ServiceRegistry,
): TaskDiscoveryState | undefined {
  if (value === undefined || !task) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted discovery is invalid");
  }
  const candidate = value as RawDiscovery;
  const requiredCapability = requiredString(
    candidate.requiredCapability,
    "discovery requiredCapability",
  ).toLowerCase();
  if (!isSupportedServiceCapability(requiredCapability)) {
    throw new Error("discovery capability is unsupported");
  }
  if (resolveRequiredCapability(task) !== requiredCapability) {
    return undefined;
  }
  const discoveredAt = requiredString(
    candidate.discoveredAt,
    "discovery discoveredAt",
  );
  const registryVersion = requiredString(
    candidate.registryVersion,
    "discovery registryVersion",
  );
  const selectedServiceId = optionalString(
    candidate.selectedServiceId,
    "discovery selectedServiceId",
  );
  const selectedService =
    selectedServiceId &&
    registryVersion === registry.version &&
    registry.getService(selectedServiceId)?.status === "available"
      ? registry.getService(selectedServiceId)
      : undefined;
  return Object.freeze({
    requiredCapability,
    discoveredAt,
    registryVersion: registry.version,
    ...(selectedService ? { selectedServiceId: selectedService.id } : {}),
  });
}

// Stored recommendations hydrate tolerantly: an invalid entry drops the
// recommendation but never the session. Stale entries are rejected at use
// time by isRecommendationStale, and historical display never executes.
function hydrateRecommendation(value: unknown): StoredServiceRecommendation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof candidate[key] === "string" && (candidate[key] as string).trim()
      ? (candidate[key] as string)
      : undefined;
  const taskId = text("taskId");
  const taskUpdatedAt = text("taskUpdatedAt");
  const requiredCapability = text("requiredCapability");
  const serviceBudgetLabel = text("serviceBudgetLabel");
  const policyTaskId = text("policyTaskId");
  const policyFingerprint = text("policyFingerprint");
  const registryVersion = text("registryVersion");
  const rationale = text("rationale");
  const provider = text("provider");
  const model = text("model");
  const createdAt = text("createdAt");
  if (
    !taskId ||
    !taskUpdatedAt ||
    !requiredCapability ||
    !serviceBudgetLabel ||
    !policyTaskId ||
    !policyFingerprint ||
    !registryVersion ||
    !rationale ||
    !provider ||
    !model ||
    !createdAt
  ) {
    return undefined;
  }
  const candidateFingerprint =
    candidate.candidateFingerprint === null
      ? null
      : text("candidateFingerprint");
  if (candidateFingerprint === undefined) return undefined;
  const recommendedServiceId =
    candidate.recommendedServiceId === null
      ? null
      : text("recommendedServiceId");
  if (recommendedServiceId === undefined) return undefined;
  const recipient =
    candidate.recipient === undefined ? undefined : text("recipient");
  if (candidate.recipient !== undefined && recipient === undefined) return undefined;
  if (typeof candidate.verified !== "boolean" || typeof candidate.fallback !== "boolean") {
    return undefined;
  }
  if (!Array.isArray(candidate.comparisons)) return undefined;
  const comparisons: Array<Readonly<{ serviceId: string; assessment: string }>> = [];
  for (const entry of candidate.comparisons) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.serviceId !== "string" || !record.serviceId.trim()) {
      return undefined;
    }
    if (typeof record.assessment !== "string" || !record.assessment.trim()) {
      return undefined;
    }
    comparisons.push(
      Object.freeze({ serviceId: record.serviceId, assessment: record.assessment }),
    );
  }
  return Object.freeze({
    taskId,
    taskUpdatedAt,
    requiredCapability,
    ...(recipient ? { recipient } : {}),
    serviceBudgetLabel,
    policyTaskId,
    policyFingerprint,
    registryVersion,
    recommendedServiceId,
    candidateFingerprint,
    rationale,
    comparisons: Object.freeze(comparisons),
    provider,
    model,
    verified: candidate.verified,
    fallback: candidate.fallback,
    createdAt,
  });
}

export function serializeTask(task: FinancialTask): PersistedTask {
  return {
    id: task.id,
    ownerId: task.ownerId,
    ...(task.ownerSubject ? { ownerSubject: task.ownerSubject } : {}),
    ...(task.ownerWalletAddress
      ? { ownerWalletAddress: task.ownerWalletAddress }
      : {}),
    type: task.type,
    status: task.status,
    ...(task.originalIntent ? { originalIntent: task.originalIntent } : {}),
    ...(task.recipient ? { recipient: task.recipient } : {}),
    ...(task.paymentAmount
      ? { paymentAmount: serializeMoney(task.paymentAmount) }
      : {}),
    ...(task.purpose ? { purpose: task.purpose } : {}),
    ...(task.serviceBudget
      ? { serviceBudget: serializeMoney(task.serviceBudget) }
      : {}),
    ...(task.perServiceCap
      ? { perServiceCap: serializeMoney(task.perServiceCap) }
      : {}),
    finalPaymentApprovalRequired: task.finalPaymentApprovalRequired,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function serializePolicy(policy: TaskPolicy): PersistedPolicy {
  return {
    taskId: policy.taskId,
    ...(policy.maxServiceSpend
      ? { maxServiceSpend: serializeMoney(policy.maxServiceSpend) }
      : {}),
    ...(policy.maxPerService
      ? { maxPerService: serializeMoney(policy.maxPerService) }
      : {}),
    allowedServiceCategories: [...policy.allowedServiceCategories],
    ...(policy.allowedServiceNetworks
      ? { allowedServiceNetworks: [...policy.allowedServiceNetworks] }
      : {}),
    allowedAssets: [...policy.allowedAssets],
    allowedNetworks: [...policy.allowedNetworks],
    finalPaymentApprovalRequired: policy.finalPaymentApprovalRequired,
  };
}

function serializeBudget(budget: TaskBudgetSnapshot): PersistedBudget {
  return {
    taskId: budget.taskId,
    ...(budget.configuredServiceBudget
      ? {
          configuredServiceBudget: serializeMoney(
            budget.configuredServiceBudget,
          ),
        }
      : {}),
    confirmedSpend: serializeMoney(budget.confirmedSpend),
    reservedSpend: serializeMoney(budget.reservedSpend),
    remainingAvailable: serializeMoney(budget.remainingAvailable),
  };
}

function serializeServiceResult(
  result: PersistedServiceResult,
): PersistedServiceResult {
  const encoded = JSON.stringify(result);
  if (!encoded || encoded.length > MAX_SERVICE_RESULT_BYTES) {
    throw new Error("service result is too large or not JSON-safe");
  }
  return hydrateServiceResult(JSON.parse(encoded));
}

function serializeRecoveryState(
  recovery: ServicePurchaseRecoveryState,
): ServicePurchaseRecoveryState {
  return {
    mode: "read_only_reconcile",
    stage: recovery.stage,
    requestId: recovery.requestId,
    ...(recovery.paymentIdentifier
      ? { paymentIdentifier: recovery.paymentIdentifier }
      : {}),
    ...(recovery.settlementNetwork
      ? { settlementNetwork: recovery.settlementNetwork }
      : {}),
    settlementSent: recovery.settlementSent,
    paymentSettled: recovery.paymentSettled,
    retryable: false,
    message: recovery.message,
  };
}

function serializeServicePurchase(
  purchase: ServicePurchase,
): PersistedServicePurchase {
  return {
    id: purchase.id,
    taskId: purchase.taskId,
    serviceId: purchase.serviceId,
    quotedAmount: serializeMoney(purchase.quotedAmount),
    ...(purchase.paymentAmount
      ? { paymentAmount: serializeMoney(purchase.paymentAmount) }
      : {}),
    ...(purchase.paidAmount
      ? { paidAmount: serializeMoney(purchase.paidAmount) }
      : {}),
    ...(purchase.requestId ? { requestId: purchase.requestId } : {}),
    ...(purchase.paymentIdentifier
      ? { paymentIdentifier: purchase.paymentIdentifier }
      : {}),
    ...(purchase.settlementNetwork
      ? { settlementNetwork: purchase.settlementNetwork }
      : {}),
    ...(purchase.serviceResult
      ? { serviceResult: serializeServiceResult(purchase.serviceResult) }
      : {}),
    ...(purchase.recoveryState
      ? { recoveryState: serializeRecoveryState(purchase.recoveryState) }
      : {}),
    policySnapshot: serializePolicy(purchase.policySnapshot),
    status: purchase.status,
    ...(purchase.resultDigest ? { resultDigest: purchase.resultDigest } : {}),
    createdAt: purchase.createdAt,
    updatedAt: purchase.updatedAt,
  };
}

function serializePendingIntent(
  intent: FinancialIntentFields,
): PersistedPendingIntent {
  return {
    ...(intent.type ? { type: intent.type } : {}),
    ...(intent.recipient ? { recipient: intent.recipient } : {}),
    ...(intent.paymentAmount
      ? { paymentAmount: serializeMoney(intent.paymentAmount) }
      : {}),
    ...(intent.paymentAmountText !== undefined
      ? { paymentAmountText: intent.paymentAmountText }
      : {}),
    ...(intent.paymentAsset !== undefined
      ? { paymentAsset: intent.paymentAsset }
      : {}),
    ...(intent.purpose ? { purpose: intent.purpose } : {}),
    ...(intent.serviceBudget
      ? { serviceBudget: serializeMoney(intent.serviceBudget) }
      : {}),
    ...(intent.perServiceCap
      ? { perServiceCap: serializeMoney(intent.perServiceCap) }
      : {}),
    ...(intent.finalPaymentApprovalRequired !== undefined
      ? { finalPaymentApprovalRequired: intent.finalPaymentApprovalRequired }
      : {}),
    ...(intent.unsupportedAsset !== undefined
      ? { unsupportedAsset: intent.unsupportedAsset }
      : {}),
  };
}
function serializeDiscovery(
  discovery: TaskDiscoveryState,
  registry: ServiceRegistry,
): PersistedDiscovery {
  const requiredCapability = requiredString(
    discovery.requiredCapability,
    "discovery requiredCapability",
  ).toLowerCase();
  if (!isSupportedServiceCapability(requiredCapability)) {
    throw new Error("discovery capability is unsupported");
  }
  const selectedServiceId = optionalString(
    discovery.selectedServiceId,
    "discovery selectedServiceId",
  );
  const selectedService =
    selectedServiceId &&
    registry.getService(selectedServiceId)?.status === "available"
      ? registry.getService(selectedServiceId)
      : undefined;
  return Object.freeze({
    requiredCapability,
    discoveredAt: requiredString(
      discovery.discoveredAt,
      "discovery discoveredAt",
    ),
    registryVersion: registry.version,
    ...(selectedService ? { selectedServiceId: selectedService.id } : {}),
  });
}

// Stored recommendations are already plain JSON-safe data. Serialization
// validates the shape fail-closed so a corrupt in-memory entry cannot reach
// storage; hydration stays tolerant so old or invalid entries never break
// session loads.
function serializeRecommendation(
  recommendation: StoredServiceRecommendation,
): PersistedRecommendation {
  const hydrated = hydrateRecommendation(JSON.parse(JSON.stringify(recommendation)));
  if (!hydrated) throw new Error("session recommendation is invalid");
  return hydrated;
}

function serializePlan(plan: TaskPlanView): TaskPlanView {
  return {
    taskId: plan.taskId,
    status: plan.status,
    type: plan.type,
    title: plan.title,
    ...(plan.purpose ? { purpose: plan.purpose } : {}),
    ...(plan.recipient ? { recipient: plan.recipient } : {}),
    ...(plan.payment ? { payment: { ...plan.payment } } : {}),
    ...(plan.serviceBudget ? { serviceBudget: { ...plan.serviceBudget } } : {}),
    ...(plan.perServiceCap ? { perServiceCap: { ...plan.perServiceCap } } : {}),
    serviceRequirement: plan.serviceRequirement,
    nextAction: plan.nextAction,
    approvalBoundary: plan.approvalBoundary,
    missing: [...plan.missing],
  };
}

function serializeMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    kind: message.kind,
    content: message.content,
    ...(message.plan ? { plan: serializePlan(message.plan) } : {}),
    createdAt: message.createdAt,
  };
}

export function hydrateTask(
  value: unknown,
  policy: TaskPolicy | undefined,
  servicePurchases: readonly ServicePurchase[],
  approval?: ApprovalRecord,
  settlement?: SettlementExecution,
): FinancialTask {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted task is invalid");
  }
  const candidate = value as RawTask;
  const status = enumValue(
    candidate.status,
    PERSISTED_TASK_STATUSES,
    "task status",
  );
  const type = enumValue(candidate.type, FINANCIAL_TASK_TYPES, "task type");
  const paymentAmount = optionalMoney(
    candidate.paymentAmount,
    "payment amount",
  );
  const serviceBudget = optionalMoney(
    candidate.serviceBudget,
    "service budget",
  );
  const perServiceCap = optionalMoney(
    candidate.perServiceCap,
    "per-service cap",
  );
  if (paymentAmount && paymentAmount.asset !== "USDC") {
    throw new Error("persisted payments must use USDC");
  }
  if (serviceBudget && serviceBudget.asset !== "USD") {
    throw new Error("persisted service budgets must use USD");
  }
  if (perServiceCap && perServiceCap.asset !== "USD") {
    throw new Error("persisted service caps must use USD");
  }
  if (
    serviceBudget &&
    perServiceCap &&
    serviceBudget.asset !== perServiceCap.asset
  ) {
    throw new Error("persisted service cap asset does not match its budget");
  }
  const createdAt = requiredString(candidate.createdAt, "task createdAt");
  const updatedAt = requiredString(candidate.updatedAt, "task updatedAt");
  const draft = createFinancialTask(
    {
      id: requiredString(candidate.id, "task id"),
      ownerId: requiredString(candidate.ownerId, "task ownerId"),
      ...(candidate.ownerSubject
        ? {
            ownerSubject: requiredString(
              candidate.ownerSubject,
              "task ownerSubject",
            ),
          }
        : {}),
      ...(candidate.ownerWalletAddress
        ? {
            ownerWalletAddress: requiredString(
              candidate.ownerWalletAddress,
              "task ownerWalletAddress",
            ),
          }
        : {}),
      type,
      originalIntent: optionalString(
        candidate.originalIntent,
        "task originalIntent",
      ),
      recipient: optionalString(candidate.recipient, "task recipient"),
      paymentAmount,
      purpose: optionalString(candidate.purpose, "task purpose"),
      serviceBudget,
      perServiceCap,
      finalPaymentApprovalRequired: requiredBoolean(
        candidate.finalPaymentApprovalRequired,
        "task finalPaymentApprovalRequired",
      ),
    },
    createdAt,
  );
  if (status === "draft") {
    return Object.freeze({ ...draft, createdAt, updatedAt });
  }
  const planned = transitionTask(draft, "planned", { now: updatedAt });
  if (status === "planned") return planned;
  const running = transitionTask(planned, "running", { now: updatedAt });
  if (status === "running") return running;
  if (status === "awaiting_approval") {
    if (type === "pay_with_check") {
      if (!policy) throw new Error("persisted task policy is required");
      return transitionTask(running, "awaiting_approval", {
        serviceWork: { policy, purchases: servicePurchases },
        now: updatedAt,
      });
    }
    return transitionTask(running, "awaiting_approval", { now: updatedAt });
  }
  if (status === "settling") {
    const awaiting =
      type === "pay_with_check" && policy
        ? transitionTask(running, "awaiting_approval", {
            serviceWork: { policy, purchases: servicePurchases },
            now: updatedAt,
          })
        : transitionTask(running, "awaiting_approval", { now: updatedAt });
    return transitionTask(awaiting, "settling", {
      approval,
      ...(policy
        ? { serviceWork: { policy, purchases: servicePurchases } }
        : {}),
      now: updatedAt,
    });
  }
  if (status === "completed") {
    const awaiting =
      type === "pay_with_check" && policy
        ? transitionTask(running, "awaiting_approval", {
            serviceWork: { policy, purchases: servicePurchases },
            now: updatedAt,
          })
        : transitionTask(running, "awaiting_approval", { now: updatedAt });
    const settling = transitionTask(awaiting, "settling", {
      approval,
      ...(policy
        ? { serviceWork: { policy, purchases: servicePurchases } }
        : {}),
      now: updatedAt,
    });
    return transitionTask(settling, "completed", {
      settlement,
      approval,
      now: updatedAt,
    });
  }
  return transitionTask(planned, status, { now: updatedAt });
}

export function hydratePolicy(value: unknown): TaskPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted policy is invalid");
  }
  const candidate = value as RawPolicy;
  const maxServiceSpend = optionalMoney(
    candidate.maxServiceSpend,
    "policy maxServiceSpend",
  );
  const maxPerService = optionalMoney(
    candidate.maxPerService,
    "policy maxPerService",
  );
  const allowedServiceNetworks =
    candidate.allowedServiceNetworks === undefined
      ? undefined
      : stringList(
          candidate.allowedServiceNetworks,
          "policy allowedServiceNetworks",
        );
  if (
    (maxServiceSpend && maxServiceSpend.asset !== "USD") ||
    (maxPerService && maxPerService.asset !== "USD")
  ) {
    throw new Error("persisted service policy budgets must use USD");
  }
  return createTaskPolicy({
    taskId: requiredString(candidate.taskId, "policy taskId"),
    maxServiceSpend,
    maxPerService,
    allowedServiceCategories: stringList(
      candidate.allowedServiceCategories,
      "policy allowedServiceCategories",
    ),
    ...(allowedServiceNetworks ? { allowedServiceNetworks } : {}),
    allowedAssets: stringList(candidate.allowedAssets, "policy allowedAssets"),
    allowedNetworks: stringList(
      candidate.allowedNetworks,
      "policy allowedNetworks",
    ),
    finalPaymentApprovalRequired: requiredBoolean(
      candidate.finalPaymentApprovalRequired,
      "policy finalPaymentApprovalRequired",
    ),
  });
}

export function hydrateApproval(
  value: unknown,
  policy?: TaskPolicy,
): ApprovalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted approval is invalid");
  }
  const candidate = value as RawApproval;
  const amount = hydrateMoney(candidate.amount, "approval amount");
  const requestedAmount =
    candidate.requestedAmount !== undefined
      ? hydrateMoney(candidate.requestedAmount, "approval requestedAmount")
      : amount;
  const executionAmount =
    candidate.executionAmount !== undefined
      ? hydrateMoney(candidate.executionAmount, "approval executionAmount")
      : amount;
  const testMode =
    typeof candidate.testMode === "boolean" ? candidate.testMode : undefined;
  const policySnapshot = policy ?? hydratePolicy(candidate.policySnapshot);
  const serviceEvidence = hydrateApprovalServiceEvidence(
    candidate.serviceEvidence,
  );
  return createApprovalRecord({
    id: requiredString(candidate.id, "approval id"),
    taskId: requiredString(candidate.taskId, "approval taskId"),
    settlementExecutionId: requiredString(
      candidate.settlementExecutionId,
      "approval settlementExecutionId",
    ),
    approverId: requiredString(candidate.approverId, "approval approverId"),
    walletAddress: requiredString(
      candidate.walletAddress,
      "approval walletAddress",
    ),
    amount,
    requestedAmount,
    executionAmount,
    testMode,
    asset: requiredString(candidate.asset, "approval asset"),
    recipient: requiredString(candidate.recipient, "approval recipient"),
    network: requiredString(candidate.network, "approval network"),
    policySnapshot,
    ...(serviceEvidence ? { serviceEvidence } : {}),
    approvedAt: requiredString(candidate.approvedAt, "approval approvedAt"),
  });
}

function hydrateApprovalServiceEvidence(
  value: unknown,
): ApprovalServiceEvidence | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted approval service evidence is invalid");
  }
  const candidate = value as {
    paidPurchaseIds?: unknown;
    paidTotal?: unknown;
  };
  if (!Array.isArray(candidate.paidPurchaseIds)) {
    throw new Error("persisted approval service evidence is invalid");
  }
  const paidPurchaseIds = candidate.paidPurchaseIds.map((entry) =>
    requiredString(entry, "approval service evidence purchase id"),
  );
  const paidTotal = hydrateMoney(
    candidate.paidTotal,
    "approval service evidence paidTotal",
  );
  return Object.freeze({
    paidPurchaseIds: Object.freeze(paidPurchaseIds),
    paidTotal,
  });
}

export function hydrateSettlement(
  value: unknown,
  policy?: TaskPolicy,
): SettlementExecution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted settlement is invalid");
  }
  const candidate = value as RawSettlement;
  const amount = hydrateMoney(candidate.amount, "settlement amount");
  const requestedAmount =
    candidate.requestedAmount !== undefined
      ? hydrateMoney(candidate.requestedAmount, "settlement requestedAmount")
      : amount;
  const executionAmount =
    candidate.executionAmount !== undefined
      ? hydrateMoney(candidate.executionAmount, "settlement executionAmount")
      : amount;
  const testMode =
    typeof candidate.testMode === "boolean" ? candidate.testMode : undefined;
  const reconciliationState =
    typeof candidate.reconciliationState === "string"
      ? (candidate.reconciliationState as ArcReconciliationState)
      : undefined;
  const status = enumValue(
    candidate.status,
    SETTLEMENT_STATUSES,
    "settlement status",
  );
  const policySnapshot = policy ?? hydratePolicy(candidate.policySnapshot);
  const execution = createSettlementExecution(
    {
      id: requiredString(candidate.id, "settlement id"),
      taskId: requiredString(candidate.taskId, "settlement taskId"),
      provider: requiredString(candidate.provider, "settlement provider"),
      amount,
      requestedAmount,
      executionAmount,
      testMode,
      recipient: requiredString(candidate.recipient, "settlement recipient"),
      network: requiredString(candidate.network, "settlement network"),
      approvalRequired: requiredBoolean(
        candidate.approvalRequired,
        "settlement approvalRequired",
      ),
      policySnapshot,
    },
    optionalString(candidate.createdAt, "settlement createdAt"),
  );

  return Object.freeze({
    ...execution,
    status,
    requestedAmount,
    executionAmount,
    testMode,
    transactionHash: optionalString(
      candidate.transactionHash,
      "settlement transactionHash",
    ),
    reconciliationState,
    errorCode: optionalString(candidate.errorCode, "settlement errorCode"),
    confirmationEvidence: candidate.confirmationEvidence as
      SettlementConfirmationEvidence | undefined,
    updatedAt:
      optionalString(candidate.updatedAt, "settlement updatedAt") ??
      execution.updatedAt,
  });
}

export function hydrateProof(value: unknown): OmnisProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted proof is invalid");
  }
  const candidate = value as RawProof;
  const policy = hydratePolicy(candidate.policy);
  const servicePurchases = Array.isArray(candidate.servicePurchases)
    ? candidate.servicePurchases.map(hydrateServicePurchase)
    : [];
  const approval = candidate.approval
    ? hydrateApproval(candidate.approval, policy)
    : undefined;
  const finalPayment = candidate.finalPayment
    ? hydrateSettlement(candidate.finalPayment, policy)
    : undefined;
  const task = hydrateTask(
    candidate.task,
    policy,
    servicePurchases,
    approval,
    finalPayment,
  );

  return finalizeProof({
    task,
    policy,
    servicePurchases,
    settlement: finalPayment,
    approval,
    intent: candidate.intent,
    agentSummary: optionalString(candidate.agentSummary, "proof agentSummary"),
    recordedAt: requiredString(candidate.createdAt, "proof createdAt"),
  });
}

function hydrateBudget(value: unknown): TaskBudgetSnapshot {
  const candidate = recordValue(value, "persisted budget");
  return Object.freeze({
    taskId: requiredString(candidate.taskId, "budget taskId"),
    ...(candidate.configuredServiceBudget === undefined
      ? {}
      : {
          configuredServiceBudget: hydrateMoney(
            candidate.configuredServiceBudget,
            "budget configuredServiceBudget",
          ),
        }),
    confirmedSpend: hydrateMoney(
      candidate.confirmedSpend,
      "budget confirmedSpend",
    ),
    reservedSpend: hydrateMoney(
      candidate.reservedSpend,
      "budget reservedSpend",
    ),
    remainingAvailable: hydrateMoney(
      candidate.remainingAvailable,
      "budget remainingAvailable",
    ),
  });
}

function hydrateServicePurchase(value: unknown): ServicePurchase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted service purchase is invalid");
  }
  const candidate = value as RawServicePurchase;
  const policySnapshot = hydratePolicy(candidate.policySnapshot);
  const purchase = createServicePurchase(
    {
      id: requiredString(candidate.id, "purchase id"),
      taskId: requiredString(candidate.taskId, "purchase taskId"),
      serviceId: requiredString(candidate.serviceId, "purchase serviceId"),
      quotedAmount: hydrateMoney(
        candidate.quotedAmount,
        "purchase quotedAmount",
      ),
      ...(candidate.paymentAmount === undefined
        ? {}
        : {
            paymentAmount: hydrateMoney(
              candidate.paymentAmount,
              "purchase paymentAmount",
            ),
          }),
      ...(candidate.paidAmount === undefined
        ? {}
        : {
            paidAmount: hydrateMoney(
              candidate.paidAmount,
              "purchase paidAmount",
            ),
          }),
      ...(candidate.requestId === undefined
        ? {}
        : {
            requestId: requiredString(
              candidate.requestId,
              "purchase requestId",
            ),
          }),
      ...(candidate.paymentIdentifier === undefined
        ? {}
        : {
            paymentIdentifier: requiredString(
              candidate.paymentIdentifier,
              "purchase paymentIdentifier",
            ),
          }),
      ...(candidate.settlementNetwork === undefined
        ? {}
        : {
            settlementNetwork: requiredString(
              candidate.settlementNetwork,
              "purchase settlementNetwork",
            ),
          }),
      ...(candidate.serviceResult === undefined
        ? {}
        : {
            serviceResult: hydrateServiceResult(
              candidate.serviceResult,
              "purchase serviceResult",
            ),
          }),
      ...(candidate.recoveryState === undefined
        ? {}
        : {
            recoveryState: hydrateRecoveryState(
              candidate.recoveryState,
              "purchase recoveryState",
            ),
          }),
      policySnapshot,
      status: enumValue(
        candidate.status,
        SERVICE_PURCHASE_STATUSES,
        "purchase status",
      ),
      ...(candidate.resultDigest === undefined
        ? {}
        : {
            resultDigest: requiredString(
              candidate.resultDigest,
              "purchase resultDigest",
            ),
          }),
      createdAt: requiredString(candidate.createdAt, "purchase createdAt"),
      updatedAt: requiredString(candidate.updatedAt, "purchase updatedAt"),
    },
    requiredString(candidate.updatedAt, "purchase updatedAt"),
  );
  validateServicePurchaseRecord(purchase);
  return purchase;
}

function hydratePlan(value: unknown): TaskPlanView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted plan is invalid");
  }
  const candidate = value as RawPlan;
  if (!Array.isArray(candidate.missing)) {
    throw new Error("plan missing fields are invalid");
  }
  const parsedMissing = candidate.missing.map((entry) =>
    enumValue(entry, INTENT_MISSING_FIELDS, "plan missing field"),
  );
  const payment =
    candidate.payment === undefined
      ? undefined
      : serializeMoney(hydrateMoney(candidate.payment, "plan payment"));
  const serviceBudget =
    candidate.serviceBudget === undefined
      ? undefined
      : serializeMoney(
          hydrateMoney(candidate.serviceBudget, "plan serviceBudget"),
        );
  const perServiceCap =
    candidate.perServiceCap === undefined
      ? undefined
      : serializeMoney(
          hydrateMoney(candidate.perServiceCap, "plan perServiceCap"),
        );
  if (payment && payment.asset !== "USDC") {
    throw new Error("persisted plan payments must use USDC");
  }
  if (
    (serviceBudget && serviceBudget.asset !== "USD") ||
    (perServiceCap && perServiceCap.asset !== "USD")
  ) {
    throw new Error("persisted plan budgets must use USD");
  }
  return Object.freeze({
    taskId: requiredString(candidate.taskId, "plan taskId"),
    status: enumValue(candidate.status, TASK_PLAN_STATUSES, "plan status"),
    type: enumValue(candidate.type, FINANCIAL_TASK_TYPES, "plan type"),
    title: requiredString(candidate.title, "plan title"),
    ...(candidate.purpose === undefined
      ? {}
      : { purpose: requiredString(candidate.purpose, "plan purpose") }),
    ...(candidate.recipient === undefined
      ? {}
      : { recipient: requiredString(candidate.recipient, "plan recipient") }),
    ...(payment ? { payment } : {}),
    ...(serviceBudget ? { serviceBudget } : {}),
    ...(perServiceCap ? { perServiceCap } : {}),
    serviceRequirement: requiredString(
      candidate.serviceRequirement,
      "plan serviceRequirement",
    ),
    nextAction: requiredString(candidate.nextAction, "plan nextAction"),
    approvalBoundary: requiredString(
      candidate.approvalBoundary,
      "plan approvalBoundary",
    ),
    missing: Object.freeze(parsedMissing),
  });
}

function hydrateMessage(value: unknown): ChatMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted message is invalid");
  }
  const candidate = value as RawMessage;
  const content = requiredString(candidate.content, "message content");
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new Error("persisted message is too long");
  }
  return Object.freeze({
    id: requiredString(candidate.id, "message id"),
    role: enumValue(candidate.role, MESSAGE_ROLES, "message role"),
    content,
    kind: enumValue(candidate.kind, MESSAGE_KINDS, "message kind"),
    ...(candidate.plan === undefined
      ? {}
      : { plan: hydratePlan(candidate.plan) }),
    createdAt: requiredString(candidate.createdAt, "message createdAt"),
  });
}

function budgetsEqual(
  left: TaskBudgetSnapshot,
  right: TaskBudgetSnapshot,
): boolean {
  if (left.taskId !== right.taskId) return false;
  if (
    left.configuredServiceBudget &&
    right.configuredServiceBudget &&
    !moneyEquals(left.configuredServiceBudget, right.configuredServiceBudget)
  ) {
    return false;
  }
  if (
    Boolean(left.configuredServiceBudget) !==
    Boolean(right.configuredServiceBudget)
  ) {
    return false;
  }
  return (
    moneyEquals(left.confirmedSpend, right.confirmedSpend) &&
    moneyEquals(left.reservedSpend, right.reservedSpend) &&
    moneyEquals(left.remainingAvailable, right.remainingAvailable)
  );
}

export function serializeApproval(approval: ApprovalRecord): PersistedApproval {
  return {
    id: approval.id,
    taskId: approval.taskId,
    settlementExecutionId: approval.settlementExecutionId,
    approverId: approval.approverId,
    walletAddress: approval.walletAddress,
    amount: serializeMoney(approval.amount),
    ...(approval.requestedAmount
      ? { requestedAmount: serializeMoney(approval.requestedAmount) }
      : {}),
    ...(approval.executionAmount
      ? { executionAmount: serializeMoney(approval.executionAmount) }
      : {}),
    ...(approval.testMode !== undefined ? { testMode: approval.testMode } : {}),
    asset: approval.asset,
    recipient: approval.recipient,
    network: approval.network,
    policySnapshot: serializePolicy(approval.policySnapshot),
    decision: "approved",
    approvedAt: approval.approvedAt,
    ...(approval.serviceEvidence
      ? {
          serviceEvidence: {
            paidPurchaseIds: [...approval.serviceEvidence.paidPurchaseIds],
            paidTotal: serializeMoney(approval.serviceEvidence.paidTotal),
          },
        }
      : {}),
  };
}

export function serializeSettlement(
  settlement: SettlementExecution,
): PersistedSettlement {
  return {
    id: settlement.id,
    taskId: settlement.taskId,
    provider: settlement.provider,
    amount: serializeMoney(settlement.amount),
    ...(settlement.requestedAmount
      ? { requestedAmount: serializeMoney(settlement.requestedAmount) }
      : {}),
    ...(settlement.executionAmount
      ? { executionAmount: serializeMoney(settlement.executionAmount) }
      : {}),
    ...(settlement.testMode !== undefined
      ? { testMode: settlement.testMode }
      : {}),
    recipient: settlement.recipient,
    network: settlement.network,
    approvalRequired: settlement.approvalRequired,
    policySnapshot: serializePolicy(settlement.policySnapshot),
    status: settlement.status,
    ...(settlement.transactionHash
      ? { transactionHash: settlement.transactionHash }
      : {}),
    ...(settlement.reconciliationState
      ? { reconciliationState: settlement.reconciliationState }
      : {}),
    ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
    ...(settlement.confirmationEvidence
      ? { confirmationEvidence: settlement.confirmationEvidence }
      : {}),
    createdAt: settlement.createdAt,
    updatedAt: settlement.updatedAt,
  };
}

export function serializeProof(proof: OmnisProof): PersistedProof {
  return {
    id: proof.id,
    idempotencyKey: proof.idempotencyKey,
    taskId: proof.taskId,
    ownerId: proof.ownerId,
    createdAt: proof.createdAt,
    intent: proof.intent,
    task: serializeTask(proof.task),
    policy: serializePolicy(proof.policy),
    servicePurchases: proof.servicePurchases.map(serializeServicePurchase),
    totalServiceSpend: serializeMoney(proof.totalServiceSpend),
    ...(proof.approval ? { approval: serializeApproval(proof.approval) } : {}),
    ...(proof.finalPayment
      ? { finalPayment: serializeSettlement(proof.finalPayment) }
      : {}),
    status: proof.status,
    ...(proof.testMode !== undefined ? { testMode: proof.testMode } : {}),
    ...(proof.demoVerificationStatus !== undefined
      ? { demoVerificationStatus: proof.demoVerificationStatus }
      : {}),
    ...(proof.originalPaymentDelivered !== undefined
      ? { originalPaymentDelivered: proof.originalPaymentDelivered }
      : {}),
    ...(proof.reconciliationProvenance
      ? { reconciliationProvenance: proof.reconciliationProvenance }
      : {}),
    ...(proof.agentSummary ? { agentSummary: proof.agentSummary } : {}),
  };
}
export function serializeDraftSession(
  session: TaskSession,
  registry: ServiceRegistry = serviceRegistry,
): string {
  if (session.messages.length > MAX_MESSAGES) {
    throw new Error("draft session has too many messages");
  }
  const servicePurchases = session.servicePurchases ?? [];
  if (servicePurchases.length > MAX_PURCHASES) {
    throw new Error("draft session has too many service purchases");
  }
  if ((session.task === undefined) !== (session.policy === undefined)) {
    throw new Error("task and policy must be persisted together");
  }
  if (
    session.ownerSubject &&
    session.task?.ownerSubject &&
    session.ownerSubject !== session.task.ownerSubject
  ) {
    throw new Error("session and task owner subjects must match");
  }
  if (
    session.ownerWalletAddress &&
    session.task?.ownerWalletAddress &&
    session.ownerWalletAddress !== session.task.ownerWalletAddress
  ) {
    throw new Error("session and task owner wallet addresses must match");
  }
  if (session.discovery && !session.task) {
    throw new Error("discovery state requires a task");
  }
  if (session.recommendation && !session.task) {
    throw new Error("recommendation state requires a task");
  }
  let budget: TaskBudgetSnapshot | undefined;
  if (session.task && session.policy) {
    assertTaskPolicyMatches(session.task, session.policy);
    budget = calculateTaskBudgetState(
      session.task,
      session.policy,
      servicePurchases,
    );
    if (session.budget && !budgetsEqual(session.budget, budget)) {
      throw new Error(
        "persisted task budget does not match the purchase ledger",
      );
    }
  } else if (session.budget) {
    throw new Error("task budget requires a task policy");
  }
  if (servicePurchases.length > 0) {
    if (!session.task || !session.policy) {
      throw new Error("service purchases require a task policy");
    }
    validateServicePurchaseLedger(
      session.task,
      session.policy,
      servicePurchases,
    );
  }

  const persisted: PersistedSession = {
    version: TASK_SESSION_VERSION,
    ...(session.ownerSubject ? { ownerSubject: session.ownerSubject } : {}),
    ...(session.ownerWalletAddress
      ? { ownerWalletAddress: session.ownerWalletAddress }
      : {}),
    messages: session.messages.map(serializeMessage),
    ...(session.pendingIntent
      ? { pendingIntent: serializePendingIntent(session.pendingIntent) }
      : {}),
    ...(session.task ? { task: serializeTask(session.task) } : {}),
    ...(session.policy ? { policy: serializePolicy(session.policy) } : {}),
    ...(servicePurchases.length > 0
      ? { servicePurchases: servicePurchases.map(serializeServicePurchase) }
      : {}),
    ...(budget ? { budget: serializeBudget(budget) } : {}),
    ...(session.discovery
      ? { discovery: serializeDiscovery(session.discovery, registry) }
      : {}),
    ...(session.recommendation
      ? { recommendation: serializeRecommendation(session.recommendation) }
      : {}),
    ...(session.approval
      ? { approval: serializeApproval(session.approval) }
      : {}),
    ...(session.settlement
      ? { settlement: serializeSettlement(session.settlement) }
      : {}),
    ...(session.proof ? { proof: serializeProof(session.proof) } : {}),
  };
  return JSON.stringify(persisted);
}

export type HydrateSessionOptions = Readonly<{
  expectedOwnerSubject?: string;
}>;

export type SaveDraftSessionOptions = HydrateSessionOptions &
  Readonly<{
    persistenceHydrated?: boolean;
  }>;

export function hydrateDraftSession(
  raw: string | null,
  registry: ServiceRegistry = serviceRegistry,
  options: HydrateSessionOptions = {},
): TaskSession | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const candidate = value as RawSession;
    if (
      candidate.version !== TASK_SESSION_VERSION &&
      candidate.version !== LEGACY_TASK_SESSION_VERSION &&
      candidate.version !== EARLIER_TASK_SESSION_VERSION &&
      candidate.version !== INITIAL_TASK_SESSION_VERSION
    ) {
      return null;
    }
    const sessionOwnerSubject = optionalString(
      candidate.ownerSubject,
      "session ownerSubject",
    );
    const sessionOwnerWalletAddress = optionalString(
      candidate.ownerWalletAddress,
      "session ownerWalletAddress",
    );
    if (options.expectedOwnerSubject) {
      const expected = options.expectedOwnerSubject.trim();
      if (sessionOwnerSubject && sessionOwnerSubject !== expected) {
        return null;
      }
      if (!sessionOwnerSubject) {
        return null;
      }
    }
    if (
      !Array.isArray(candidate.messages) ||
      candidate.messages.length > MAX_MESSAGES
    ) {
      return null;
    }
    const messages = candidate.messages.map(hydrateMessage);
    const pendingIntent =
      candidate.pendingIntent === undefined
        ? undefined
        : hydratePendingIntent(candidate.pendingIntent);
    const policy =
      candidate.policy === undefined
        ? undefined
        : hydratePolicy(candidate.policy);
    const servicePurchases =
      candidate.servicePurchases === undefined
        ? []
        : Array.isArray(candidate.servicePurchases) &&
            candidate.servicePurchases.length <= MAX_PURCHASES
          ? candidate.servicePurchases.map(hydrateServicePurchase)
          : null;
    if (servicePurchases === null) return null;
    const persistedBudget =
      candidate.budget === undefined
        ? undefined
        : hydrateBudget(candidate.budget);
    const approval =
      candidate.approval !== undefined
        ? hydrateApproval(candidate.approval, policy)
        : undefined;
    const settlement =
      candidate.settlement !== undefined
        ? hydrateSettlement(candidate.settlement, policy)
        : undefined;
    const proof =
      candidate.proof !== undefined ? hydrateProof(candidate.proof) : undefined;
    const task =
      candidate.task === undefined
        ? undefined
        : hydrateTask(
            candidate.task,
            policy,
            servicePurchases,
            approval,
            settlement,
          );
    const calculatedBudget =
      task && policy
        ? calculateTaskBudgetState(task, policy, servicePurchases)
        : undefined;
    if (
      persistedBudget &&
      (!calculatedBudget || !budgetsEqual(persistedBudget, calculatedBudget))
    ) {
      return null;
    }
    if ((task === undefined) !== (policy === undefined)) return null;
    if (servicePurchases.length > 0 && (!task || !policy)) return null;
    if (task && policy) {
      if (policy.taskId !== task.id) return null;
      if (
        task.finalPaymentApprovalRequired !==
        policy.finalPaymentApprovalRequired
      ) {
        return null;
      }
      if (
        (task.serviceBudget === undefined) !==
        (policy.maxServiceSpend === undefined)
      ) {
        return null;
      }
      if (
        task.serviceBudget &&
        policy.maxServiceSpend &&
        !moneyEquals(task.serviceBudget, policy.maxServiceSpend)
      ) {
        return null;
      }
      if (
        (task.perServiceCap === undefined) !==
        (policy.maxPerService === undefined)
      ) {
        return null;
      }
      if (
        task.perServiceCap &&
        policy.maxPerService &&
        !moneyEquals(task.perServiceCap, policy.maxPerService)
      ) {
        return null;
      }
      validateServicePurchaseLedger(task, policy, servicePurchases);
    }
    const discovery =
      candidate.version !== EARLIER_TASK_SESSION_VERSION
        ? hydrateDiscovery(candidate.discovery, task, registry)
        : undefined;
    const recommendation = hydrateRecommendation(candidate.recommendation);
    if (
      messages.some(
        (message) => message.plan && (!task || message.plan.taskId !== task.id),
      )
    ) {
      return null;
    }
    if (
      options.expectedOwnerSubject &&
      task &&
      task.ownerSubject &&
      task.ownerSubject !== options.expectedOwnerSubject.trim()
    ) {
      return null;
    }
    if (
      sessionOwnerSubject &&
      task?.ownerSubject &&
      sessionOwnerSubject !== task.ownerSubject
    ) {
      return null;
    }
    return Object.freeze({
      version: TASK_SESSION_VERSION,
      ...(sessionOwnerSubject ? { ownerSubject: sessionOwnerSubject } : {}),
      ...(sessionOwnerWalletAddress
        ? { ownerWalletAddress: sessionOwnerWalletAddress }
        : {}),
      messages: Object.freeze(messages),
      ...(pendingIntent ? { pendingIntent } : {}),
      ...(task ? { task } : {}),
      ...(policy ? { policy } : {}),
      ...(servicePurchases.length > 0
        ? { servicePurchases: Object.freeze(servicePurchases) }
        : {}),
      ...(calculatedBudget ? { budget: calculatedBudget } : {}),
      ...(discovery ? { discovery } : {}),
      ...(recommendation ? { recommendation } : {}),
      ...(approval ? { approval } : {}),
      ...(settlement ? { settlement } : {}),
      ...(proof ? { proof } : {}),
    });
  } catch {
    return null;
  }
}

export function loadDraftSession(
  storage: DraftStorage,
  registry: ServiceRegistry = serviceRegistry,
  options: HydrateSessionOptions = {},
): TaskSession | null {
  try {
    const key = getTaskSessionStorageKey(options.expectedOwnerSubject);
    const raw = storage.getItem(key);
    const session = hydrateDraftSession(raw, registry, options);
    if (raw && !session) storage.removeItem(key);
    return session;
  } catch {
    return null;
  }
}
export function isPristineInitialSession(session: TaskSession): boolean {
  return (
    session.version === TASK_SESSION_VERSION &&
    session.messages.length === 0 &&
    session.ownerSubject === undefined &&
    session.ownerWalletAddress === undefined &&
    session.pendingIntent === undefined &&
    session.task === undefined &&
    session.policy === undefined &&
    session.servicePurchases === undefined &&
    session.budget === undefined &&
    session.discovery === undefined &&
    session.approval === undefined &&
    session.settlement === undefined &&
    session.proof === undefined
  );
}

function hasPersistedSessionState(session: TaskSession): boolean {
  return (
    session.messages.length > 0 ||
    session.pendingIntent !== undefined ||
    session.task !== undefined ||
    session.policy !== undefined ||
    (session.servicePurchases?.length ?? 0) > 0 ||
    session.budget !== undefined ||
    session.discovery !== undefined ||
    session.approval !== undefined ||
    session.settlement !== undefined ||
    session.proof !== undefined
  );
}

export function saveDraftSession(
  session: TaskSession,
  storage: DraftStorage,
  registry: ServiceRegistry = serviceRegistry,
  options: SaveDraftSessionOptions = {},
): boolean {
  try {
    const targetSubject = options.expectedOwnerSubject ?? session.ownerSubject;
    if (options.expectedOwnerSubject !== undefined) {
      const expectedOwnerSubject = options.expectedOwnerSubject.trim();
      if (
        !expectedOwnerSubject ||
        session.ownerSubject !== expectedOwnerSubject ||
        (session.task !== undefined &&
          session.task.ownerSubject !== expectedOwnerSubject)
      ) {
        return false;
      }
    }
    const key = getTaskSessionStorageKey(targetSubject);
    const existingRaw = storage.getItem(key);
    if (!options.persistenceHydrated && isPristineInitialSession(session)) {
      const existing = hydrateDraftSession(existingRaw, registry, options);
      if (existing && hasPersistedSessionState(existing)) return false;
    }
    storage.setItem(key, serializeDraftSession(session, registry));
    return true;
  } catch {
    return false;
  }
}

export function clearDraftSession(
  storage: DraftStorage,
  options: HydrateSessionOptions = {},
): void {
  try {
    const key = getTaskSessionStorageKey(options.expectedOwnerSubject);
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
