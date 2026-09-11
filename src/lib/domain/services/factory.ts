import { raiseDomainError } from "../errors";
import { assertMoney, moneyGreaterThan } from "../money";
import { createTaskPolicy } from "../policy/engine";
import {
  SERVICE_ENVIRONMENTS,
  SERVICE_PURCHASE_STATUSES,
  type ServiceDescriptor,
  type ServiceEnvironment,
  type ServicePurchase,
  type ServicePurchaseStatus,
} from "../types";

export type CreateServiceDescriptorInput = Omit<
  ServiceDescriptor,
  "status" | "environment" | "catalogOnly"
> & {
  status?: ServiceDescriptor["status"];
  environment?: ServiceEnvironment;
  catalogOnly?: boolean;
};

export type CreateServicePurchaseInput = Omit<
  ServicePurchase,
  "status" | "createdAt" | "updatedAt"
> & {
  status?: ServicePurchaseStatus;
  createdAt?: string;
  updatedAt?: string;
};

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return raiseDomainError("INVALID_SERVICE", `${field} is required`);
  }
  return value.trim();
}

function requireSchema(
  value: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return raiseDomainError("INVALID_SERVICE", `${field} must be an object`);
  }
  return value;
}

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireText(value, field);
}

function requireServiceResult(
  value: ServicePurchase["serviceResult"],
): NonNullable<ServicePurchase["serviceResult"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return raiseDomainError("INVALID_SERVICE_RESULT", "service result must be an object");
  }
  if (
    !value.observations ||
    typeof value.observations !== "object" ||
    Array.isArray(value.observations) ||
    !Array.isArray(value.heuristicFlags)
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RESULT",
      "service result must separate observations and heuristic flags",
    );
  }
  const disclaimer = optionalText(value.disclaimer, "service result disclaimer");
  const requestId = optionalText(value.requestId, "service result request id");
  return Object.freeze({
    observations: Object.freeze({ ...value.observations }),
    heuristicFlags: Object.freeze(
      value.heuristicFlags.map((flag) => {
        if (!flag || typeof flag !== "object" || Array.isArray(flag)) {
          return raiseDomainError(
            "INVALID_SERVICE_RESULT",
            "service heuristic flags must be objects",
          );
        }
        return Object.freeze({ ...flag });
      }),
    ),
    ...(disclaimer ? { disclaimer } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function requireRecoveryState(
  value: ServicePurchase["recoveryState"],
): NonNullable<ServicePurchase["recoveryState"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery state must be an object",
    );
  }
  const mode = value.mode;
  if (mode !== "read_only_reconcile") {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery must be read-only reconciliation",
    );
  }
  if (
    value.settlementSent !== true &&
    value.settlementSent !== false &&
    value.settlementSent !== "unknown"
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery settlement state is invalid",
    );
  }
  if (
    value.paymentSettled !== true &&
    value.paymentSettled !== false &&
    value.paymentSettled !== "unknown"
  ) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "service recovery payment state is invalid",
    );
  }
  if (value.retryable !== false) {
    return raiseDomainError(
      "INVALID_SERVICE_RECOVERY",
      "ambiguous service payment recovery cannot be retried",
    );
  }
  return Object.freeze({
    mode,
    stage: requireText(value.stage, "service recovery stage"),
    requestId: requireText(value.requestId, "service recovery request id"),
    ...(value.paymentIdentifier
      ? { paymentIdentifier: requireText(value.paymentIdentifier, "service recovery payment identifier") }
      : {}),
    ...(value.settlementNetwork
      ? { settlementNetwork: requireText(value.settlementNetwork, "service recovery network") }
      : {}),
    settlementSent: value.settlementSent,
    paymentSettled: value.paymentSettled,
    retryable: false as const,
    message: requireText(value.message, "service recovery message"),
  });
}

export function createServiceDescriptor(
  input: CreateServiceDescriptorInput,
): ServiceDescriptor {
  const id = requireText(input.id, "service id");
  const name = requireText(input.name, "service name");
  const capability = requireText(input.capability, "service capability");
  const category = requireText(input.category, "service category");
  const description = requireText(input.description, "service description");
  const endpoint = requireText(input.endpoint, "service endpoint");
  const network = requireText(input.network, "service network");
  assertMoney(input.price);
  if (input.paymentAmount) assertMoney(input.paymentAmount);
  if (input.paymentProtocol !== "x402") {
    return raiseDomainError(
      "INVALID_SERVICE_PAYMENT_PROTOCOL",
      "service payment protocol must be x402",
    );
  }
  if (
    input.status !== undefined &&
    !["available", "unavailable"].includes(input.status)
  ) {
    return raiseDomainError("INVALID_SERVICE_STATUS", "service status is invalid");
  }
  const environment = input.environment ?? "development";
  if (!SERVICE_ENVIRONMENTS.includes(environment)) {
    return raiseDomainError(
      "INVALID_SERVICE_ENVIRONMENT",
      "service environment is invalid",
    );
  }
  const catalogOnly = input.catalogOnly ?? environment === "development";
  if (typeof catalogOnly !== "boolean") {
    return raiseDomainError(
      "INVALID_SERVICE_CATALOG_STATUS",
      "service catalog status must be explicit",
    );
  }
  return Object.freeze({
    id,
    name,
    capability,
    category,
    description,
    endpoint,
    price: input.price,
    ...(input.paymentAmount ? { paymentAmount: input.paymentAmount } : {}),
    network,
    paymentProtocol: input.paymentProtocol,
    inputSchema: requireSchema(input.inputSchema, "service input schema"),
    outputSchema: requireSchema(input.outputSchema, "service output schema"),
    status: input.status ?? "available",
    environment,
    catalogOnly,
  });
}

export function createServicePurchase(
  input: CreateServicePurchaseInput,
  now = new Date().toISOString(),
): ServicePurchase {
  const id = requireText(input.id, "service purchase id");
  const taskId = requireText(input.taskId, "service purchase task id");
  const serviceId = requireText(input.serviceId, "service id");
  const timestamp = requireText(input.createdAt ?? now, "service purchase timestamp");
  const updatedAt = requireText(
    input.updatedAt ?? timestamp,
    "service purchase update timestamp",
  );
  assertMoney(input.quotedAmount);
  if (input.paymentAmount) assertMoney(input.paymentAmount);
  if (input.paidAmount) {
    assertMoney(input.paidAmount);
    if (input.paidAmount.asset !== input.quotedAmount.asset) {
      return raiseDomainError(
        "SERVICE_PURCHASE_ASSET_MISMATCH",
        "paid amount asset must match the quoted amount asset",
      );
    }
    if (moneyGreaterThan(input.paidAmount, input.quotedAmount)) {
      return raiseDomainError(
        "SERVICE_PURCHASE_AMOUNT_INCREASED",
        "paid amount cannot exceed the quoted amount",
      );
    }
  }
  if (!SERVICE_PURCHASE_STATUSES.includes(input.status ?? "quoted")) {
    return raiseDomainError(
      "INVALID_SERVICE_PURCHASE_STATUS",
      "service purchase status is invalid",
    );
  }
  const status = input.status ?? "quoted";
  const policySnapshot = createTaskPolicy(input.policySnapshot);
  if (policySnapshot.taskId !== taskId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_POLICY_MISMATCH",
      "service purchase policy snapshot must belong to the task",
    );
  }
  const requestId = optionalText(input.requestId, "service purchase request id");
  const paymentIdentifier = optionalText(
    input.paymentIdentifier,
    "service purchase payment identifier",
  );
  const settlementNetwork = optionalText(
    input.settlementNetwork,
    "service purchase settlement network",
  );
  const recoveryState = input.recoveryState
    ? requireRecoveryState(input.recoveryState)
    : undefined;
  const serviceResult = input.serviceResult
    ? requireServiceResult(input.serviceResult)
    : undefined;
  if (status === "paid" && (!input.paidAmount || !paymentIdentifier)) {
    return raiseDomainError(
      "SERVICE_PAYMENT_IDENTIFIER_REQUIRED",
      "a paid service purchase requires amount and payment identifier",
    );
  }
  if (status !== "paying" && recoveryState) {
    return raiseDomainError(
      "SERVICE_PURCHASE_RECOVERY_DATA_INVALID",
      "service recovery data is only valid while payment is paying",
    );
  }
  if (status !== "paid" && serviceResult) {
    return raiseDomainError(
      "SERVICE_PURCHASE_RESULT_DATA_INVALID",
      "service results are only valid for paid purchases",
    );
  }
  if (
    status !== "paid" &&
    (input.paidAmount || paymentIdentifier || settlementNetwork) &&
    !(status === "paying" && recoveryState)
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_PAYMENT_DATA_INVALID",
      "payment evidence is only valid for a paid or recoverable paying purchase",
    );
  }
  if (recoveryState && requestId && recoveryState.requestId !== requestId) {
    return raiseDomainError(
      "SERVICE_PURCHASE_RECOVERY_DATA_INVALID",
      "service recovery request id must match the purchase request id",
    );
  }
  if (
    recoveryState?.paymentIdentifier &&
    paymentIdentifier &&
    recoveryState.paymentIdentifier !== paymentIdentifier
  ) {
    return raiseDomainError(
      "SERVICE_PURCHASE_RECOVERY_DATA_INVALID",
      "service recovery payment identifier must match the purchase evidence",
    );
  }
  return Object.freeze({
    ...input,
    id,
    taskId,
    serviceId,
    policySnapshot,
    status,
    createdAt: timestamp,
    updatedAt,
    ...(requestId ? { requestId } : {}),
    ...(paymentIdentifier ? { paymentIdentifier } : {}),
    ...(settlementNetwork ? { settlementNetwork } : {}),
    ...(serviceResult ? { serviceResult } : {}),
    ...(recoveryState ? { recoveryState } : {}),
  });
}

