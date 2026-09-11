import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
} from "@x402/core/types";
import {
  createClientHederaSigner,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  assertWalletActivityEndpoint,
  IDEMPOTENCY_KEY_HEADER,
  readHederaX402RuntimeConfig,
  type HederaX402RuntimeConfig,
} from "./config";
import {
  decodeP4ADiagnostics,
  P4A_DIAGNOSTICS_HEADER,
  type P4AHandshakeDiagnostics,
  type P4AHandshakeStage,
} from "./diagnostics";
import {
  createBlocky402Facilitator,
  fetchBlocky402Support,
  type Blocky402Support,
} from "./facilitator";
import {
  validateWalletActivityPaymentRequired,
  type P4APaymentSafetyError,
} from "./requirements";
import { WALLET_ACTIVITY_SERVICE_PATH } from "../wallet-activity-descriptor";

export type PaymentRecoveryState = Readonly<{
  requestId: string;
  stage: P4AHandshakeStage;
  paymentIdentifier?: string;
  retryable: boolean;
}>;

export class P4APaymentRecoveryError extends Error {
  readonly code = "P4A_PAYMENT_OUTCOME_UNKNOWN" as const;
  readonly recovery: PaymentRecoveryState;
  readonly diagnostics?: P4AHandshakeDiagnostics;

  constructor(
    message: string,
    recovery: PaymentRecoveryState,
    diagnostics?: P4AHandshakeDiagnostics,
  ) {
    super(message);
    this.name = "P4APaymentRecoveryError";
    this.recovery = recovery;
    this.diagnostics = diagnostics;
  }
}

export class P4APaymentFailureError extends Error {
  readonly code = "P4A_PAYMENT_FAILED" as const;
  readonly recovery: PaymentRecoveryState;
  readonly diagnostics?: P4AHandshakeDiagnostics;
  readonly settlement?: SettleResponse;

  constructor(
    message: string,
    recovery: PaymentRecoveryState,
    diagnostics?: P4AHandshakeDiagnostics,
    settlement?: SettleResponse,
  ) {
    super(message);
    this.name = "P4APaymentFailureError";
    this.recovery = recovery;
    this.diagnostics = diagnostics;
    this.settlement = settlement;
  }
}
export class P4AResourceExecutionError extends Error {
  readonly code = "P4A_RESOURCE_EXECUTION_FAILED" as const;
  readonly recovery: PaymentRecoveryState;
  readonly diagnostics?: P4AHandshakeDiagnostics;

  constructor(
    message: string,
    recovery: PaymentRecoveryState,
    diagnostics?: P4AHandshakeDiagnostics,
  ) {
    super(message);
    this.name = "P4AResourceExecutionError";
    this.recovery = recovery;
    this.diagnostics = diagnostics;
  }
}

export class P4APayerError extends Error {
  readonly code = "P4A_PAYER_FAILED" as const;
  readonly retryableBeforePayment: boolean;
  readonly diagnostics?: P4AHandshakeDiagnostics;

  constructor(
    message: string,
    retryableBeforePayment = false,
    diagnostics?: P4AHandshakeDiagnostics,
  ) {
    super(message);
    this.name = "P4APayerError";
    this.retryableBeforePayment = retryableBeforePayment;
    this.diagnostics = diagnostics;
  }
}

export type PaidWalletActivityResult = Readonly<{
  requestId: string;
  serviceResult: unknown;
  paymentIdentifier: string;
  settlement: SettleResponse;
  diagnostics: P4AHandshakeDiagnostics;
  requirements: Readonly<{
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  }>;
}>;

function requestId(value?: string): string {
  const candidate = value?.trim();
  if (candidate && candidate.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(candidate)) {
    return candidate;
  }
  return `p4a-wallet-activity-${crypto.randomUUID()}`;
}

function parsePrivateKey(value: string): PrivateKey {
  try {
    return PrivateKey.fromStringECDSA(value);
  } catch {
    throw new P4APayerError("HEDERA_TESTNET_PAYER_PRIVATE_KEY is not a valid ECDSA key");
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
function responseErrorField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertPaymentResource(
  paymentRequired: PaymentRequired,
  endpoint: URL,
): void {
  const resourceUrl = paymentRequired.resource?.url;
  if (typeof resourceUrl !== "string") {
    throw new P4APayerError("wallet activity payment resource is missing");
  }
  let resource: URL;
  try {
    resource = new URL(resourceUrl);
  } catch {
    throw new P4APayerError("wallet activity payment resource must be an absolute URL");
  }
  if (
    resource.origin !== endpoint.origin ||
    resource.pathname !== endpoint.pathname ||
    resource.search ||
    resource.hash
  ) {
    throw new P4APayerError(
      "payer rejected an x402 resource outside the wallet activity endpoint",
    );
  }
}

function assertPaymentPayloadResource(
  paymentPayload: PaymentPayload,
  paymentRequired: PaymentRequired,
  endpoint: URL,
): void {
  const payloadResource = paymentPayload.resource;
  if (!payloadResource || payloadResource.url !== paymentRequired.resource.url) {
    throw new P4APayerError(
      "signed x402 payload did not preserve the payment resource",
    );
  }
  assertPaymentResource(
    { ...paymentRequired, resource: payloadResource },
    endpoint,
  );
}

function settlementIdentifier(settlement: SettleResponse): string | undefined {
  const candidate = settlement.transaction;
  return typeof candidate === "string" && candidate.trim()
    ? candidate
    : undefined;
}

function responseDiagnostics(
  response: Response,
  fallback: P4AHandshakeDiagnostics,
): P4AHandshakeDiagnostics {
  const remote = decodeP4ADiagnostics(
    response.headers.get(P4A_DIAGNOSTICS_HEADER),
  );
  return (
    remote ?? {
      ...fallback,
      resourceHttpStatus: response.status,
      paymentRequiredPresent: Boolean(response.headers.get("PAYMENT-REQUIRED")),
      paymentResponsePresent: Boolean(response.headers.get("PAYMENT-RESPONSE")),
    }
  );
}

function recovery(
  id: string,
  stage: P4AHandshakeStage,
  paymentIdentifier?: string,
  retryable = false,
): PaymentRecoveryState {
  return {
    requestId: id,
    stage,
    ...(paymentIdentifier ? { paymentIdentifier } : {}),
    retryable,
  };
}

function settlementHeader(httpClient: x402HTTPClient, response: Response): SettleResponse {
  return httpClient.getPaymentSettleResponse((name) =>
    name === "PAYMENT-RESPONSE" ? response.headers.get(name) : null,
  );
}

export type PayWalletActivityInput = Readonly<{
  wallet: string;
  serviceEndpoint: string;
  requestId?: string;
  config?: HederaX402RuntimeConfig;
  fetchImpl?: typeof fetch;
  facilitatorClient?: Pick<FacilitatorClient, "getSupported">;
}>;

export async function payWalletActivityService(
  input: PayWalletActivityInput,
): Promise<PaidWalletActivityResult> {
  const config = input.config ?? readHederaX402RuntimeConfig();
  const endpoint = assertWalletActivityEndpoint(input.serviceEndpoint);
  if (endpoint.pathname !== WALLET_ACTIVITY_SERVICE_PATH) {
    throw new P4APayerError("payer endpoint is outside the P4A allowlist");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const id = requestId(input.requestId);
  const facilitator =
    input.facilitatorClient ?? createBlocky402Facilitator(config);
  const support = await fetchBlocky402Support(facilitator);
  const privateKey = parsePrivateKey(config.payerPrivateKey);
  const signer = createClientHederaSigner(
    config.payerAccountId,
    privateKey,
    { network: HEDERA_TESTNET_CAIP2 },
  );
  const client = new x402Client().register(
    HEDERA_TESTNET_CAIP2,
    new ExactHederaScheme(signer),
  );
  const httpClient = new x402HTTPClient(client);
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      [IDEMPOTENCY_KEY_HEADER]: id,
    },
    body: JSON.stringify({ wallet: input.wallet }),
  };

  let unpaidResponse: Response;
  try {
    unpaidResponse = await fetchImpl(endpoint, requestInit);
  } catch {
    throw new P4APayerError(
      "useOmnis wallet activity endpoint could not be reached before payment creation",
      true,
    );
  }
  const unpaidHeader = unpaidResponse.headers.get("PAYMENT-REQUIRED");
  const unpaidDiagnostics: P4AHandshakeDiagnostics = {
    resourceHttpStatus: unpaidResponse.status,
    paymentRequiredPresent: Boolean(unpaidHeader),
    paymentResponsePresent: false,
    resource: { attempted: false, success: false },
    settlement: { attempted: false },
    recoveryStage: "challenge_received",
  };
  if (unpaidResponse.status !== 402) {
    throw new P4APayerError(
      `wallet activity endpoint returned ${unpaidResponse.status} instead of x402 payment requirements`,
      false,
      unpaidDiagnostics,
    );
  }
  const unpaidBody = await responseBody(unpaidResponse);
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => name === "PAYMENT-REQUIRED" ? unpaidResponse.headers.get(name) : null,
      unpaidBody,
    );
  } catch {
    throw new P4APayerError("wallet activity endpoint returned invalid x402 requirements");
  }
  assertPaymentResource(paymentRequired, endpoint);
  let selected;
  try {
    selected = validateWalletActivityPaymentRequired(
      paymentRequired,
      config,
      support,
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new P4APayerError(error.message);
    }
    throw new P4APayerError("wallet activity payment requirements failed closed");
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  } catch {
    throw new P4APayerError("Hedera x402 payment payload signing failed");
  }
  assertPaymentPayloadResource(paymentPayload, paymentRequired, endpoint);
  if (
    paymentPayload.accepted.network !== selected.requirement.network ||
    paymentPayload.accepted.asset !== selected.requirement.asset ||
    paymentPayload.accepted.payTo !== selected.requirement.payTo ||
    paymentPayload.accepted.amount !== selected.requirement.amount ||
    paymentPayload.accepted.extra?.feePayer !== selected.requirement.extra?.feePayer
  ) {
    throw new P4APayerError("signed x402 payload did not preserve the allowlisted requirements");
  }

  const paidHeaders = {
    ...(requestInit.headers as Record<string, string>),
    ...httpClient.encodePaymentSignatureHeader(paymentPayload),
  };
  let paidResponse: Response;
  try {
    paidResponse = await fetchImpl(endpoint, {
      ...requestInit,
      headers: paidHeaders,
    });
  } catch {
    throw new P4APaymentRecoveryError(
      "the payment was signed and the paid request outcome is unknown; reconcile before retrying",
      recovery(id, "payment_signed"),
      {
        ...unpaidDiagnostics,
        recoveryStage: "payment_signed",
      },
    );
  }

  const paidBody = await responseBody(paidResponse);
  let diagnostics = responseDiagnostics(
    paidResponse,
    {
      ...unpaidDiagnostics,
      resourceHttpStatus: paidResponse.status,
      paymentRequiredPresent: Boolean(paidResponse.headers.get("PAYMENT-REQUIRED")),
      paymentResponsePresent: Boolean(paidResponse.headers.get("PAYMENT-RESPONSE")),
      resource: { attempted: false, success: false },
      settlement: { attempted: false },
      recoveryStage: "payment_signed",
    },
  );
  const responseErrorCode = responseErrorField(paidBody, "error");
  const responseErrorMessage = responseErrorField(paidBody, "message");
  if (
    responseErrorCode === "P4A_RESOURCE_EXECUTION_FAILED" &&
    !diagnostics.settlement.attempted
  ) {
    diagnostics = {
      ...diagnostics,
      resource: {
        attempted: true,
        success: false,
        status: paidResponse.status,
        errorCode: responseErrorCode,
      },
      recoveryStage: "resource_execution",
    };
  } else if (
    responseErrorCode === "PAYMENT_SETTLEMENT_FAILED" &&
    !diagnostics.settlement.attempted
  ) {
    diagnostics = {
      ...diagnostics,
      settlement: { attempted: true, success: false },
      recoveryStage: "settlement_failed",
    };
  }
  const responsePaymentRequired = paidResponse.headers.get("PAYMENT-REQUIRED");
  let paymentResponse: SettleResponse | undefined;
  try {
    if (paidResponse.headers.get("PAYMENT-RESPONSE")) {
      paymentResponse = settlementHeader(httpClient, paidResponse);
    }
  } catch {
    throw new P4APaymentRecoveryError(
      "the paid response contained an invalid settlement response; reconcile before retrying",
      recovery(id, diagnostics.recoveryStage),
      diagnostics,
    );
  }

  if (!paymentResponse) {
    if (responsePaymentRequired) {
      let retryRequirements: PaymentRequired | undefined;
      try {
        retryRequirements = httpClient.getPaymentRequiredResponse(
          (name) => name === "PAYMENT-REQUIRED"
            ? paidResponse.headers.get(name)
            : null,
          paidBody,
        );
      } catch {
        retryRequirements = undefined;
      }
      throw new P4APaymentFailureError(
        retryRequirements?.error
          ? `the resource rejected the signed payment: ${retryRequirements.error}`
          : "the resource returned another payment challenge before settlement",
        recovery(id, "verification_failed"),
        diagnostics,
      );
    }
    if (
      diagnostics.recoveryStage === "resource_execution" ||
      (diagnostics.resource.attempted &&
        !diagnostics.resource.success &&
        !diagnostics.settlement.attempted)
    ) {
      throw new P4AResourceExecutionError(
        responseErrorMessage ??
          "the protected resource failed before settlement; retry after fixing the resource cause",
        recovery(id, "resource_execution", undefined, true),
        diagnostics,
      );
    }
    if (
      diagnostics.recoveryStage === "verification_failed" ||
      diagnostics.recoveryStage === "settlement_failed" ||
      (diagnostics.settlement.attempted === false &&
        paidResponse.status >= 400 &&
        paidResponse.status < 500)
    ) {
      throw new P4APaymentFailureError(
        responseErrorMessage ??
          "the signed payment failed before a settlement response",
        recovery(
          id,
          diagnostics.recoveryStage === "settlement_failed"
            ? "settlement_failed"
            : "verification_confirmed",
          undefined,
          diagnostics.settlement.attempted === false,
        ),
        diagnostics,
      );
    }
    throw new P4APaymentRecoveryError(
      "the paid response did not include a settlement response; reconcile before retrying",
      recovery(id, diagnostics.recoveryStage),
      diagnostics,
    );
  }

  const paymentIdentifier = settlementIdentifier(paymentResponse);
  if (paymentResponse.success !== true) {
    throw new P4APaymentFailureError(
      paymentResponse.errorMessage ??
        paymentResponse.errorReason ??
        "the facilitator reported settlement failure",
      recovery(id, "settlement_failed", paymentIdentifier),
      diagnostics,
      paymentResponse,
    );
  }
  if (!paymentIdentifier) {
    throw new P4APaymentFailureError(
      "the facilitator reported settlement success without a transaction identifier",
      recovery(id, "settlement_failed"),
      diagnostics,
      paymentResponse,
    );
  }
  if (!paidResponse.ok) {
    throw new P4APaymentFailureError(
      "settlement was confirmed but the protected resource was not released",
      recovery(id, "settlement_confirmed", paymentIdentifier),
      diagnostics,
      paymentResponse,
    );
  }
  return Object.freeze({
    requestId: id,
    serviceResult: paidBody,
    paymentIdentifier,
    settlement: paymentResponse,
    diagnostics: {
      ...diagnostics,
      recoveryStage: "resource_released",
    },
    requirements: Object.freeze({
      network: selected.requirement.network,
      asset: selected.requirement.asset,
      amount: selected.requirement.amount,
      payTo: selected.requirement.payTo,
    }),
  });
}

export function validatePayerPaymentRequirementForTests(
  requirement: Parameters<typeof validateWalletActivityPaymentRequired>[0]["accepts"][number],
  config: Pick<HederaX402RuntimeConfig, "serviceAccountId">,
  support: Blocky402Support,
): void {
  validateWalletActivityPaymentRequired(
    { x402Version: 2, accepts: [requirement] },
    config,
    support,
  );
}

export type P4APaymentSafetyFailure = P4APaymentSafetyError;
