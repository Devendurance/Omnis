import { raiseDomainError } from "../errors";
import { moneyEquals, type Money } from "../money";
import {
  SERVICE_PURCHASE_STATUSES,
  type PersistedServiceResult,
  type ServicePurchase,
  type ServicePurchaseRecoveryState,
  type ServicePurchaseStatus,
} from "../types";
import { createServicePurchase } from "./factory";
import { validateServicePurchaseRecord } from "./validation";

const SERVICE_PURCHASE_TRANSITIONS: Readonly<
  Record<ServicePurchaseStatus, readonly ServicePurchaseStatus[]>
> = {
  quoted: ["approved", "failed", "cancelled"],
  approved: ["paying", "failed", "cancelled"],
  paying: ["paid", "failed", "cancelled"],
  paid: [],
  failed: [],
  cancelled: [],
};

export type ServicePurchaseTransitionContext = Readonly<{
  paidAmount?: Money;
  paymentAmount?: Money;
  paymentIdentifier?: string;
  settlementNetwork?: string;
  serviceResult?: PersistedServiceResult;
  now?: string;
}>;

function requireTimestamp(value: string | undefined): string {
  if (value === undefined) return "";
  if (!value.trim()) {
    return raiseDomainError(
      "INVALID_SERVICE_PURCHASE_TIMESTAMP",
      "service purchase transition timestamp is empty",
    );
  }
  return value;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value, (_, entry) =>
    typeof entry === "bigint" ? `${entry}n` : entry,
  );
}

function assertPaidReplayMatches(
  purchase: ServicePurchase,
  context: ServicePurchaseTransitionContext,
): void {
  if (context.paidAmount && !purchase.paidAmount) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "a paid replay must match the persisted paid amount",
    );
  }
  if (
    context.paidAmount &&
    purchase.paidAmount &&
    !moneyEquals(context.paidAmount, purchase.paidAmount)
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "a paid replay must match the persisted paid amount",
    );
  }
  if (
    context.paymentAmount &&
    (!purchase.paymentAmount ||
      !moneyEquals(context.paymentAmount, purchase.paymentAmount))
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "a paid replay must match the persisted payment amount",
    );
  }
  if (
    context.paymentIdentifier !== undefined &&
    context.paymentIdentifier.trim() !== purchase.paymentIdentifier
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "a paid replay must match the persisted payment identifier",
    );
  }
  if (
    context.settlementNetwork !== undefined &&
    context.settlementNetwork !== purchase.settlementNetwork
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "a paid replay must match the persisted settlement network",
    );
  }
  if (
    context.serviceResult &&
    stableValue(context.serviceResult) !== stableValue(purchase.serviceResult)
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "a paid replay must match the persisted service result",
    );
  }
}

export function canTransitionServicePurchase(
  from: ServicePurchaseStatus,
  to: ServicePurchaseStatus,
): boolean {
  if (
    !SERVICE_PURCHASE_STATUSES.includes(from) ||
    !SERVICE_PURCHASE_STATUSES.includes(to)
  ) {
    return false;
  }
  return SERVICE_PURCHASE_TRANSITIONS[from].includes(to);
}

export function isServicePurchaseReserved(
  status: ServicePurchaseStatus,
): boolean {
  return status === "approved" || status === "paying";
}

export function isServicePurchaseConfirmed(
  status: ServicePurchaseStatus,
): boolean {
  return status === "paid";
}

export function transitionServicePurchase(
  purchase: ServicePurchase,
  nextStatus: ServicePurchaseStatus,
  context: ServicePurchaseTransitionContext = {},
): ServicePurchase {
  validateServicePurchaseRecord(purchase);
  if (!SERVICE_PURCHASE_STATUSES.includes(nextStatus)) {
    return raiseDomainError(
      "INVALID_SERVICE_PURCHASE_STATUS",
      `unsupported service purchase status: ${nextStatus}`,
    );
  }

  if (purchase.status === nextStatus) {
    if (nextStatus === "paid") assertPaidReplayMatches(purchase, context);
    return purchase;
  }

  if (!canTransitionServicePurchase(purchase.status, nextStatus)) {
    return raiseDomainError(
      "SERVICE_PURCHASE_TRANSITION_NOT_ALLOWED",
      `cannot transition service purchase from ${purchase.status} to ${nextStatus}`,
      { from: purchase.status, to: nextStatus },
    );
  }

  const updatedAt = requireTimestamp(context.now) || purchase.updatedAt;
  if (nextStatus === "paid") {
    if (!context.paidAmount || !context.paymentIdentifier?.trim()) {
      return raiseDomainError(
        "SERVICE_PAYMENT_IDENTIFIER_REQUIRED",
        "a paid service purchase requires amount and payment identifier",
      );
    }
    return createServicePurchase(
      {
        ...purchase,
        status: "paid",
        paidAmount: context.paidAmount,
        paymentIdentifier: context.paymentIdentifier,
        ...(context.paymentAmount
          ? { paymentAmount: context.paymentAmount }
          : {}),
        ...(context.settlementNetwork
          ? { settlementNetwork: context.settlementNetwork }
          : {}),
        ...(context.serviceResult
          ? { serviceResult: context.serviceResult }
          : {}),
        recoveryState: undefined,
        updatedAt,
      },
      updatedAt,
    );
  }

  if (
    context.paidAmount ||
    context.paymentAmount ||
    context.paymentIdentifier !== undefined ||
    context.settlementNetwork !== undefined ||
    context.serviceResult
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_TRANSITION_DATA_INVALID",
      "payment completion data is only valid when marking a purchase paid",
    );
  }

  return createServicePurchase(
    {
      ...purchase,
      status: nextStatus,
      paidAmount: undefined,
      paymentIdentifier: undefined,
      settlementNetwork: undefined,
      serviceResult: undefined,
      recoveryState: undefined,
      updatedAt,
    },
    updatedAt,
  );
}

export type ServicePurchaseExecutionDetails = Readonly<{
  requestId: string;
  paymentAmount?: Money;
  now?: string;
}>;

export function setServicePurchaseExecutionDetails(
  purchase: ServicePurchase,
  details: ServicePurchaseExecutionDetails,
): ServicePurchase {
  validateServicePurchaseRecord(purchase);
  const requestId = details.requestId.trim();
  if (!requestId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_REQUEST_ID_INVALID",
      "service payment request id is required",
    );
  }
  if (purchase.requestId && purchase.requestId !== requestId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "service payment request id cannot change",
    );
  }
  const updatedAt = requireTimestamp(details.now) || purchase.updatedAt;
  return createServicePurchase(
    {
      ...purchase,
      requestId,
      ...(details.paymentAmount
        ? { paymentAmount: details.paymentAmount }
        : {}),
      updatedAt,
    },
    updatedAt,
  );
}

export type ServicePurchaseRecoveryUpdate = Readonly<{
  requestId?: string;
  stage: string;
  paymentIdentifier?: string;
  settlementNetwork?: string;
  settlementSent: boolean | "unknown";
  paymentSettled: boolean | "unknown";
  message: string;
  now?: string;
}>;

export function recordServicePurchaseRecovery(
  purchase: ServicePurchase,
  update: ServicePurchaseRecoveryUpdate,
): ServicePurchase {
  if (purchase.status !== "paying") {
    return raiseDomainError(
      "SERVICE_PURCHASE_RECOVERY_STATE_INVALID",
      "service payment recovery requires a paying purchase",
    );
  }
  const requestId = (update.requestId ?? purchase.requestId)?.trim();
  if (!requestId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_REQUEST_ID_INVALID",
      "service payment recovery requires a request id",
    );
  }
  if (purchase.requestId && purchase.requestId !== requestId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "service payment request id cannot change",
    );
  }
  if (
    purchase.paymentIdentifier &&
    update.paymentIdentifier &&
    purchase.paymentIdentifier !== update.paymentIdentifier.trim()
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
      "service payment identifier cannot change",
    );
  }
  const updatedAt = requireTimestamp(update.now) || purchase.updatedAt;
  const recoveryState: ServicePurchaseRecoveryState = {
    mode: "read_only_reconcile",
    stage: update.stage.trim(),
    requestId,
    ...(update.paymentIdentifier?.trim()
      ? { paymentIdentifier: update.paymentIdentifier.trim() }
      : purchase.recoveryState?.paymentIdentifier
        ? { paymentIdentifier: purchase.recoveryState.paymentIdentifier }
        : {}),
    ...(update.settlementNetwork?.trim()
      ? { settlementNetwork: update.settlementNetwork.trim() }
      : purchase.recoveryState?.settlementNetwork
        ? { settlementNetwork: purchase.recoveryState.settlementNetwork }
        : {}),
    settlementSent: update.settlementSent,
    paymentSettled: update.paymentSettled,
    retryable: false,
    message: update.message.trim(),
  };
  return createServicePurchase(
    {
      ...purchase,
      requestId,
      ...(update.paymentIdentifier?.trim()
        ? { paymentIdentifier: update.paymentIdentifier.trim() }
        : {}),
      ...(update.settlementNetwork?.trim()
        ? { settlementNetwork: update.settlementNetwork.trim() }
        : {}),
      recoveryState,
      updatedAt,
    },
    updatedAt,
  );
}

export function markServicePurchaseExecutionStarted(
  purchase: ServicePurchase,
  requestId: string,
  paymentAmount?: Money,
  now?: string,
): ServicePurchase {
  let paying = setServicePurchaseExecutionDetails(purchase, {
    requestId,
    ...(paymentAmount ? { paymentAmount } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  if (paying.status === "approved") {
    paying = transitionServicePurchase(paying, "paying", { now });
  } else if (paying.status !== "paying") {
    return raiseDomainError(
      "SERVICE_PURCHASE_EXECUTION_NOT_ALLOWED",
      `service payment cannot start from ${paying.status}`,
    );
  }
  return recordServicePurchaseRecovery(paying, {
    stage: "payment_execution_started",
    settlementSent: "unknown",
    paymentSettled: "unknown",
    message: "payment confirmation pending; reconcile before retrying",
    now,
  });
}

export function recordServicePurchasePaymentEvidence(
  purchase: ServicePurchase,
  input: Readonly<{
    paymentIdentifier: string;
    settlementNetwork: string;
    now?: string;
  }>,
): ServicePurchase {
  return recordServicePurchaseRecovery(purchase, {
    stage: "settlement_confirmed",
    paymentIdentifier: input.paymentIdentifier,
    settlementNetwork: input.settlementNetwork,
    settlementSent: true,
    paymentSettled: true,
    message: "service payment settled; recording the protected result",
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

export function markServicePurchasePaying(
  purchase: ServicePurchase,
  now?: string,
): ServicePurchase {
  return transitionServicePurchase(purchase, "paying", { now });
}

export function markServicePurchasePaid(
  purchase: ServicePurchase,
  paidAmount?: Money,
  paymentIdentifier?: string,
  now?: string,
  evidence?: Readonly<{
    paymentAmount?: Money;
    settlementNetwork?: string;
    serviceResult?: PersistedServiceResult;
  }>,
): ServicePurchase {
  return transitionServicePurchase(purchase, "paid", {
    ...(paidAmount ? { paidAmount } : {}),
    ...(paymentIdentifier !== undefined ? { paymentIdentifier } : {}),
    ...(evidence?.paymentAmount
      ? { paymentAmount: evidence.paymentAmount }
      : {}),
    ...(evidence?.settlementNetwork
      ? { settlementNetwork: evidence.settlementNetwork }
      : {}),
    ...(evidence?.serviceResult
      ? { serviceResult: evidence.serviceResult }
      : {}),
    ...(now !== undefined ? { now } : {}),
  });
}

export function markServicePurchaseFailed(
  purchase: ServicePurchase,
  now?: string,
): ServicePurchase {
  return transitionServicePurchase(purchase, "failed", { now });
}

export function markServicePurchaseCancelled(
  purchase: ServicePurchase,
  now?: string,
): ServicePurchase {
  return transitionServicePurchase(purchase, "cancelled", { now });
}

export function servicePurchaseTransitions(): Readonly<
  Record<ServicePurchaseStatus, readonly ServicePurchaseStatus[]>
> {
  return SERVICE_PURCHASE_TRANSITIONS;
}
