import {
  assertMoney,
  assertTaskPolicyMatches,
  authorizeServiceSpend,
  calculateTaskBudgetState,
  markServicePurchaseExecutionStarted,
  markServicePurchaseFailed,
  raiseDomainError,
  recordServicePurchasePaymentEvidence,
  recordServicePurchaseRecovery,
  setServicePurchaseExecutionDetails,
  transitionServicePurchase,
  type FinancialTask,
  type PersistedServiceResult,
  type ServiceDescriptor,
  type ServicePurchase,
  type TaskPolicy,
} from "../domain";
import {
  HEDERA_TESTNET_NETWORK,
  HEDERA_TESTNET_USDC_ASSET,
  WALLET_ACTIVITY_PRICE,
  WALLET_ACTIVITY_QUOTE,
  WALLET_ACTIVITY_SERVICE_ID,
  WALLET_ACTIVITY_SERVICE_PATH,
} from "../services/wallet-activity-descriptor";
import { beginTaskExecution, moveTaskToAwaitingApproval } from "./runtime";
import { resolveRequiredCapability } from "../services/capabilities";
import type { ServiceRegistry } from "../services/registry";
import type { TaskBudgetState } from "../domain/services/budget";
import type { TaskDiscoveryState } from "./session";
const MAX_SERVICE_RESULT_BYTES = 64_000;


export type ServiceExecutionState = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  budget: TaskBudgetState;
}>;

export type ServicePaymentRequirements = Readonly<{
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}>;

export type TrustedServicePayment = Readonly<{
  requestId: string;
  serviceResult: unknown;
  paymentIdentifier: string;
  settlement: Readonly<{
    success: boolean;
    transaction?: string;
    network?: string;
    [key: string]: unknown;
  }>;
  requirements: ServicePaymentRequirements;
}>;

export type ServicePaymentExecutor = (input: Readonly<{
  wallet: string;
  serviceEndpoint: string;
  requestId: string;
}>) => Promise<TrustedServicePayment>;

export type ExpectedServicePayment = Readonly<{
  network: string;
  asset: string;
  amount: string;
  payTo?: string;
}>;

export type ServiceExecutionPersist = (
  state: ServiceExecutionState,
) => Promise<void> | void;

type ServiceExecutionInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  registry: ServiceRegistry;
  discovery?: TaskDiscoveryState;
  selectedServiceId?: string;
  wallet?: string;
  requestId?: string;
  now?: string;
  persist?: ServiceExecutionPersist;
}>;

export type AuthorizeServicePurchaseInput = ServiceExecutionInput;

export type ServiceAuthorizationOutcome = Readonly<
  | {
      kind: "approved";
      state: ServiceExecutionState;
      service: ServiceDescriptor;
      purchase: ServicePurchase;
    }
  | {
      kind: "paid";
      state: ServiceExecutionState;
      service: ServiceDescriptor;
      purchase: ServicePurchase;
      message: string;
    }
  | {
      kind: "pending";
      state: ServiceExecutionState;
      service: ServiceDescriptor;
      purchase: ServicePurchase;
      message: string;
    }
>;

export type ServiceExecutionOutcome = Readonly<
  | ServiceAuthorizationOutcome
  | {
      kind: "failed";
      state: ServiceExecutionState;
      service: ServiceDescriptor;
      purchase: ServicePurchase;
      message: string;
    }
  | {
      kind: "recovery";
      state: ServiceExecutionState;
      service: ServiceDescriptor;
      purchase: ServicePurchase;
      message: string;
    }
>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stateFor(
  task: FinancialTask,
  policy: TaskPolicy,
  servicePurchases: readonly ServicePurchase[],
): ServiceExecutionState {
  return Object.freeze({
    task,
    policy,
    servicePurchases: Object.freeze([...servicePurchases]),
    budget: calculateTaskBudgetState(task, policy, servicePurchases),
  });
}
const executionInFlight = new Map<
  string,
  Promise<ServiceExecutionOutcome>
>();
const executionCompleted = new Map<string, ServiceExecutionOutcome>();
const MAX_EXECUTION_RESULTS = 100;

function executionKey(input: ServiceExecutionInput): string {
  const selectedServiceId =
    input.selectedServiceId ?? input.discovery?.selectedServiceId;
  const active = input.servicePurchases.find(
    (purchase) =>
      purchase.serviceId === selectedServiceId &&
      ["approved", "paying", "paid"].includes(purchase.status),
  );
  if (input.requestId?.trim()) return `request:${input.requestId.trim()}`;
  if (active?.requestId) return `request:${active.requestId}`;
  const attempt = input.servicePurchases.filter(
    (purchase) => purchase.serviceId === selectedServiceId,
  ).length;
  return `task:${input.task.id}:service:${selectedServiceId ?? "none"}:attempt:${attempt}`;
}

function rememberExecution(
  key: string,
  outcome: ServiceExecutionOutcome,
): void {
  if (outcome.kind === "failed") return;
  executionCompleted.set(key, outcome);
  while (executionCompleted.size > MAX_EXECUTION_RESULTS) {
    const oldest = executionCompleted.keys().next().value;
    if (!oldest) break;
    executionCompleted.delete(oldest);
  }
}

async function persistState(
  state: ServiceExecutionState,
  persist: ServiceExecutionPersist | undefined,
): Promise<void> {
  if (persist) await persist(state);
}

function replacePurchase(
  purchases: readonly ServicePurchase[],
  replacement: ServicePurchase,
): readonly ServicePurchase[] {
  const index = purchases.findIndex((purchase) => purchase.id === replacement.id);
  if (index < 0) return Object.freeze([...purchases, replacement]);
  const next = [...purchases];
  next[index] = replacement;
  return Object.freeze(next);
}

function serviceForInput(input: ServiceExecutionInput): ServiceDescriptor {
  assertTaskPolicyMatches(input.task, input.policy);
  if (input.task.type !== "pay_with_check") {
    throw new Error("wallet activity purchase requires a pay_with_check task");
  }
  if (resolveRequiredCapability(input.task) !== "wallet-activity") {
    throw new Error("pay_with_check capability resolution is not wallet-activity");
  }
  const selectedId = (
    input.selectedServiceId ?? input.discovery?.selectedServiceId
  )?.trim();
  if (!selectedId) throw new Error("a selected wallet activity service is required");
  if (input.discovery) {
    if (input.discovery.registryVersion !== input.registry.version) {
      throw new Error("service discovery is stale; refresh the registry before paying");
    }
    if (input.discovery.selectedServiceId !== selectedId) {
      throw new Error("selected service does not match the persisted discovery state");
    }
  }
  const service = input.registry.getService(selectedId);
  if (!service) throw new Error("selected service is not present in the registry");
  if (
    service.id !== WALLET_ACTIVITY_SERVICE_ID ||
    service.capability !== "wallet-activity" ||
    service.category !== "wallet-risk" ||
    service.endpoint !== WALLET_ACTIVITY_SERVICE_PATH ||
    service.network !== HEDERA_TESTNET_NETWORK ||
    service.paymentProtocol !== "x402" ||
    service.environment !== "testnet" ||
    service.catalogOnly ||
    service.status !== "available"
  ) {
    throw new Error("selected service is not the executable wallet activity service");
  }
  if (!service.paymentAmount) {
    throw new Error("wallet activity service is missing its on-chain amount");
  }
  assertMoney(service.price);
  assertMoney(service.paymentAmount);
  if (
    service.price.asset !== WALLET_ACTIVITY_QUOTE.asset ||
    service.price.units !== WALLET_ACTIVITY_QUOTE.units ||
    service.paymentAmount.asset !== WALLET_ACTIVITY_PRICE.asset ||
    service.paymentAmount.units !== WALLET_ACTIVITY_PRICE.units
  ) {
    throw new Error("wallet activity service quote is not the fixed allowlisted amount");
  }
  return service;
}

function walletForInput(input: ServiceExecutionInput): string {
  const wallet = (input.wallet ?? input.task.recipient)?.trim();
  if (!wallet) throw new Error("wallet activity purchase requires a wallet");
  return wallet;
}

function requestIdFor(
  input: ServiceExecutionInput,
  purchaseId: string,
): string {
  const candidate = input.requestId?.trim() || `p4b-wallet-activity-${purchaseId}`;
  if (candidate.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(candidate)) {
    throw new Error("service payment request id is invalid");
  }
  return candidate;
}

function activePurchase(
  purchases: readonly ServicePurchase[],
  serviceId: string,
): ServicePurchase | undefined {
  const active = purchases.filter(
    (purchase) =>
      purchase.serviceId === serviceId &&
      ["approved", "paying", "paid"].includes(purchase.status),
  );
  if (active.length > 1) {
    throw new Error("multiple active purchases exist for the selected service");
  }
  return active[0];
}

function requireAuthorization(
  input: ServiceExecutionInput,
  service: ServiceDescriptor,
  purchaseId?: string,
): ServicePurchase {
  const authorization = authorizeServiceSpend({
    task: input.task,
    policy: input.policy,
    service,
    quotedPrice: service.price,
    existingPurchases: input.servicePurchases,
    ...(purchaseId ? { purchaseId } : {}),
  });
  if (authorization.decision !== "ALLOW" || !authorization.purchase) {
    return raiseDomainError(
      authorization.reasonCode,
      authorization.explanation,
    );
  }
  return authorization.purchase;
}

export async function authorizeServicePurchase(
  input: AuthorizeServicePurchaseInput,
): Promise<ServiceAuthorizationOutcome> {
  const service = serviceForInput(input);
  walletForInput(input);
  let task = input.task;
  if (task.status === "planned") {
    task = beginTaskExecution(task, input.policy, input.now);
    await persistState(
      stateFor(task, input.policy, input.servicePurchases),
      input.persist,
    );
  }
  if (task.status !== "running" && task.status !== "awaiting_approval") {
    throw new Error(`wallet activity purchase cannot begin from ${task.status}`);
  }

  const current = activePurchase(input.servicePurchases, service.id);
  if (current?.status === "paid") {
    const nextTask =
      task.status === "running"
        ? moveTaskToAwaitingApproval(
            task,
            input.policy,
            input.servicePurchases,
            input.now,
          )
        : task;
    const state = stateFor(nextTask, input.policy, input.servicePurchases);
    await persistState(state, input.persist);
    return {
      kind: "paid",
      state,
      service,
      purchase: current,
      message: "wallet activity check already paid; no second payment was sent",
    };
  }
  if (current?.status === "paying") {
    if (input.requestId && current.requestId !== input.requestId.trim()) {
      throw new Error("service payment request id does not match the persisted attempt");
    }
    const state = stateFor(task, input.policy, input.servicePurchases);
    return {
      kind: "pending",
      state,
      service,
      purchase: current,
      message:
        current.recoveryState?.message ??
        "wallet activity payment is pending; reconcile before retrying",
    };
  }

  const authorized = requireAuthorization(
    { ...input, task },
    service,
    current?.status === "approved" ? current.id : undefined,
  );
  const requestId = requestIdFor(input, authorized.id);
  const prepared = setServicePurchaseExecutionDetails(authorized, {
    requestId,
    paymentAmount: service.paymentAmount,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const purchases = replacePurchase(input.servicePurchases, prepared);
  const state = stateFor(task, input.policy, purchases);
  await persistState(state, input.persist);
  return { kind: "approved", state, service, purchase: prepared };
}

export function startServicePurchasePayment(
  state: ServiceExecutionState,
  purchaseId: string,
  now?: string,
): ServiceExecutionState {
  const purchase = state.servicePurchases.find((entry) => entry.id === purchaseId);
  if (!purchase) throw new Error("service purchase was not found");
  const servicePaymentAmount = purchase.paymentAmount;
  const started = markServicePurchaseExecutionStarted(
    purchase,
    purchase.requestId ?? `p4b-wallet-activity-${purchase.id}`,
    servicePaymentAmount,
    now,
  );
  return stateFor(
    state.task,
    state.policy,
    replacePurchase(state.servicePurchases, started),
  );
}

export class ServicePaymentContractError extends Error {
  readonly paymentIdentifier?: string;
  readonly settlementNetwork?: string;
  readonly knownFailure: boolean;

  constructor(
    message: string,
    details: Readonly<{
      paymentIdentifier?: string;
      settlementNetwork?: string;
      knownFailure?: boolean;
    }> = {},
  ) {
    super(message);
    this.name = "ServicePaymentContractError";
    this.paymentIdentifier = details.paymentIdentifier;
    this.settlementNetwork = details.settlementNetwork;
    this.knownFailure = details.knownFailure ?? false;
  }
}

function trustedServiceResult(value: unknown): PersistedServiceResult {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ServicePaymentContractError(
      "protected service result is not JSON-safe",
    );
  }
  if (!encoded || encoded.length > MAX_SERVICE_RESULT_BYTES) {
    throw new ServicePaymentContractError(
      "protected service result is too large",
    );
  }
  if (!isRecord(value)) {
    throw new ServicePaymentContractError(
      "protected service result is missing after settlement",
    );
  }
  if (!isRecord(value.observations) || !Array.isArray(value.heuristicFlags)) {
    throw new ServicePaymentContractError(
      "protected service result must include observations and heuristic flags",
    );
  }
  if (value.heuristicFlags.some((flag) => !isRecord(flag))) {
    throw new ServicePaymentContractError(
      "protected service heuristic flags are malformed",
    );
  }
  return value as PersistedServiceResult;
}

function trustedPayment(
  payment: TrustedServicePayment,
  requestId: string,
  service: ServiceDescriptor,
  expectedPayment?: ExpectedServicePayment,
): Readonly<{
  paymentIdentifier: string;
  settlementNetwork: string;
  serviceResult: PersistedServiceResult;
}> {
  const paymentIdentifier = nonEmpty(payment.paymentIdentifier);
  const settlement = isRecord(payment.settlement) ? payment.settlement : undefined;
  const settlementIdentifier = settlement
    ? nonEmpty(settlement.transaction)
    : undefined;
  const settlementNetwork = settlement
    ? nonEmpty(settlement.network)
    : undefined;
  const expected = expectedPayment ?? {
    network: HEDERA_TESTNET_NETWORK,
    asset: HEDERA_TESTNET_USDC_ASSET,
    amount: WALLET_ACTIVITY_PRICE.units.toString(),
  };
  if (payment.requestId !== requestId) {
    throw new ServicePaymentContractError(
      "service payment response request id does not match the persisted attempt",
      { paymentIdentifier, settlementNetwork },
    );
  }
  if (settlement?.success !== true) {
    throw new ServicePaymentContractError(
      "facilitator did not report a successful service settlement",
      {
        paymentIdentifier: paymentIdentifier ?? settlementIdentifier,
        settlementNetwork,
        knownFailure: !paymentIdentifier && !settlementIdentifier,
      },
    );
  }
  if (
    !paymentIdentifier ||
    !settlementIdentifier ||
    paymentIdentifier !== settlementIdentifier
  ) {
    throw new ServicePaymentContractError(
      "successful service settlement is missing its transaction identifier",
      { paymentIdentifier, settlementNetwork },
    );
  }
  if (
    !settlementNetwork ||
    settlementNetwork !== expected.network ||
    expected.network !== service.network
  ) {
    throw new ServicePaymentContractError(
      "service settlement network is not the expected network",
      { paymentIdentifier, settlementNetwork },
    );
  }
  const requirements = isRecord(payment.requirements)
    ? payment.requirements
    : undefined;
  const requirementNetwork = nonEmpty(requirements?.network);
  const requirementAsset = nonEmpty(requirements?.asset);
  const requirementAmount = nonEmpty(requirements?.amount);
  const requirementPayTo = nonEmpty(requirements?.payTo);
  if (
    !requirements ||
    requirementNetwork !== expected.network ||
    requirementAsset !== expected.asset ||
    requirementAmount !== expected.amount ||
    !requirementPayTo ||
    (expected.payTo !== undefined && requirementPayTo !== expected.payTo)
  ) {
    throw new ServicePaymentContractError(
      "service payment requirements changed from the allowlisted amount or recipient",
      { paymentIdentifier, settlementNetwork },
    );
  }
  let serviceResult: PersistedServiceResult;
  try {
    serviceResult = trustedServiceResult(payment.serviceResult);
  } catch (error) {
    if (error instanceof ServicePaymentContractError) {
      throw new ServicePaymentContractError(error.message, {
        paymentIdentifier,
        settlementNetwork,
      });
    }
    throw error;
  }
  return {
    paymentIdentifier,
    settlementNetwork,
    serviceResult,
  };
}

function errorMetadata(error: unknown): Readonly<{
  code?: string;
  message: string;
  paymentIdentifier?: string;
  settlementNetwork?: string;
  knownFailure: boolean;
  stage: string;
}> {
  if (error instanceof ServicePaymentContractError) {
    return {
      message: error.message,
      ...(error.paymentIdentifier
        ? { paymentIdentifier: error.paymentIdentifier }
        : {}),
      ...(error.settlementNetwork
        ? { settlementNetwork: error.settlementNetwork }
        : {}),
      knownFailure: error.knownFailure,
      stage: error.paymentIdentifier ? "settlement_confirmed" : "outcome_unknown",
    };
  }
  const candidate = isRecord(error) ? error : undefined;
  const recovery = candidate && isRecord(candidate.recovery)
    ? candidate.recovery
    : undefined;
  const settlement = candidate && isRecord(candidate.settlement)
    ? candidate.settlement
    : undefined;
  const paymentIdentifier =
    nonEmpty(recovery?.paymentIdentifier) ?? nonEmpty(settlement?.transaction);
  const settlementNetwork = nonEmpty(settlement?.network);
  const code = nonEmpty(candidate?.code);
  const stage = nonEmpty(recovery?.stage) ?? "outcome_unknown";
  const knownFailure =
    !paymentIdentifier &&
    (code === "P4A_RESOURCE_EXECUTION_FAILED" ||
      code === "P4A_PAYER_FAILED" ||
      (code === "P4A_PAYMENT_FAILED" &&
        (settlement?.success === false ||
          ["verification_failed", "verification_confirmed", "settlement_failed"].includes(
            stage,
          ))));
  return {
    ...(code ? { code } : {}),
    message: error instanceof Error ? error.message : "service payment outcome is unknown",
    ...(paymentIdentifier ? { paymentIdentifier } : {}),
    ...(settlementNetwork ? { settlementNetwork } : {}),
    knownFailure,
    stage,
  };
}

export type ExecuteServicePurchaseInput = ServiceExecutionInput & {
  executePayment: ServicePaymentExecutor;
  expectedPayment?: ExpectedServicePayment;
};

async function executeServicePurchaseOnce(
  input: ExecuteServicePurchaseInput,
): Promise<ServiceExecutionOutcome> {
  const authorization = await authorizeServicePurchase(input);
  if (authorization.kind !== "approved") return authorization;
  const startedState = startServicePurchasePayment(
    authorization.state,
    authorization.purchase.id,
    input.now,
  );
  const startedPurchase = startedState.servicePurchases.find(
    (purchase) => purchase.id === authorization.purchase.id,
  );
  if (!startedPurchase) throw new Error("started service purchase was lost");
  await persistState(startedState, input.persist);
  const requestId = startedPurchase.requestId;
  if (!requestId) throw new Error("started service purchase has no request id");
  let latestPurchase = startedPurchase;
  let observedPayment:
    | Readonly<{
        paymentIdentifier: string;
        settlementNetwork: string;
      }>
    | undefined;
  try {
    const payment = await input.executePayment({
      wallet: walletForInput(input),
      serviceEndpoint: authorization.service.endpoint,
      requestId,
    });
    const trusted = trustedPayment(
      payment,
      requestId,
      authorization.service,
      input.expectedPayment,
    );
    observedPayment = {
      paymentIdentifier: trusted.paymentIdentifier,
      settlementNetwork: trusted.settlementNetwork,
    };
    const evidencePurchase = recordServicePurchasePaymentEvidence(
      startedPurchase,
      {
        paymentIdentifier: trusted.paymentIdentifier,
        settlementNetwork: trusted.settlementNetwork,
        ...(input.now !== undefined ? { now: input.now } : {}),
      },
    );
    latestPurchase = evidencePurchase;
    const evidenceState = stateFor(
      startedState.task,
      startedState.policy,
      replacePurchase(startedState.servicePurchases, evidencePurchase),
    );
    await persistState(evidenceState, input.persist);
    const paidPurchase = transitionServicePurchase(evidencePurchase, "paid", {
      paidAmount: authorization.service.price,
      paymentAmount: authorization.service.paymentAmount,
      paymentIdentifier: trusted.paymentIdentifier,
      settlementNetwork: trusted.settlementNetwork,
      serviceResult: trusted.serviceResult,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const paidPurchases = replacePurchase(
      startedState.servicePurchases,
      paidPurchase,
    );
    const task = moveTaskToAwaitingApproval(
      startedState.task,
      startedState.policy,
      paidPurchases,
      input.now,
    );
    const state = stateFor(task, startedState.policy, paidPurchases);
    await persistState(state, input.persist);
    return {
      kind: "paid",
      state,
      service: authorization.service,
      purchase: paidPurchase,
      message: "wallet activity check paid and confirmed; final contractor payment remains approval-only",
    };
  } catch (error) {
    const metadata = errorMetadata(error);
    const paymentIdentifier =
      metadata.paymentIdentifier ?? observedPayment?.paymentIdentifier;
    const settlementNetwork =
      metadata.settlementNetwork ?? observedPayment?.settlementNetwork;
    if (!metadata.knownFailure) {
      const recovered = recordServicePurchaseRecovery(latestPurchase, {
        stage:
          paymentIdentifier && metadata.stage === "outcome_unknown"
            ? "settlement_confirmed"
            : metadata.stage,
        ...(paymentIdentifier ? { paymentIdentifier } : {}),
        ...(settlementNetwork ? { settlementNetwork } : {}),
        settlementSent: paymentIdentifier ? true : "unknown",
        paymentSettled: "unknown",
        message:
          "payment confirmation pending; no retry is available. reconcile the persisted identifier before continuing",
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      const state = stateFor(
        startedState.task,
        startedState.policy,
        replacePurchase(startedState.servicePurchases, recovered),
      );
      await persistState(state, input.persist);
      return {
        kind: "recovery",
        state,
        service: authorization.service,
        purchase: recovered,
        message: metadata.message,
      };
    }
    const failed = markServicePurchaseFailed(latestPurchase, input.now);
    const state = stateFor(
      startedState.task,
      startedState.policy,
      replacePurchase(startedState.servicePurchases, failed),
    );
    await persistState(state, input.persist);
    return {
      kind: "failed",
      state,
      service: authorization.service,
      purchase: failed,
      message: metadata.message,
    };
  }
}
export async function executeServicePurchase(
  input: ExecuteServicePurchaseInput,
): Promise<ServiceExecutionOutcome> {
  const key = executionKey(input);
  const cached = executionCompleted.get(key);
  if (cached) return cached;
  const running = executionInFlight.get(key);
  if (running) return running;
  const promise = executeServicePurchaseOnce(input);
  executionInFlight.set(key, promise);
  try {
    const outcome = await promise;
    rememberExecution(key, outcome);
    return outcome;
  } finally {
    if (executionInFlight.get(key) === promise) {
      executionInFlight.delete(key);
    }
  }
}
