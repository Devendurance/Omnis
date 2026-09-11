import type { HTTPAdapter, HTTPProcessResult } from "@x402/core/server";
import type {
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import {
  P4AConfigError,
  IDEMPOTENCY_KEY_HEADER,
  type HederaX402RuntimeConfig,
} from "./config";
import { WALLET_ACTIVITY_SERVICE_PATH } from "../wallet-activity-descriptor";
import {
  encodeP4ADiagnostics,
  P4A_DIAGNOSTICS_HEADER,
  sanitizeP4ADiagnosticText,
  sanitizeP4ADiagnostics,
  type P4AHandshakeDiagnostics,
} from "./diagnostics";
import {
  getWalletActivityRuntime,
  type WalletActivityRuntime,
} from "./resource";
import {
  inspectWalletActivity,
  WalletActivityInputError,
  WalletActivitySourceError,
  type WalletActivitySnapshot,
} from "./wallet-activity";

export type WalletActivityRequestDependencies = Readonly<{
  getRuntime?: () => Promise<WalletActivityRuntime>;
  inspect?: (
    wallet: string,
    options?: Readonly<{ fetchImpl?: typeof fetch; rpcUrl?: string }>,
  ) => Promise<WalletActivitySnapshot>;
}>;

function requestAdapter(request: Request): HTTPAdapter {
  const url = new URL(request.url);
  const resourceUrl = new URL(WALLET_ACTIVITY_SERVICE_PATH, url.origin).toString();
  return {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => resourceUrl,
    getAcceptHeader: () => request.headers.get("accept") ?? "",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function failureBody(
  code: string,
  message: string,
  idempotencyKey?: string,
): Readonly<Record<string, unknown>> {
  return {
    error: code,
    message,
    moneyMoved: "no settlement was requested",
    ...(idempotencyKey ? { requestId: idempotencyKey } : {}),
  };
}
function resourceFailureBody(
  message: string,
  idempotencyKey?: string,
): Readonly<Record<string, unknown>> {
  return {
    error: "P4A_RESOURCE_EXECUTION_FAILED",
    message,
    stage: "resource_execution",
    settlementSent: false,
    paymentSettled: false,
    retryable: true,
    moneyMoved: "no settlement was requested",
    ...(idempotencyKey ? { requestId: idempotencyKey } : {}),
  };
}

function hasHeader(
  headers: Record<string, string>,
  name: string,
): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function diagnosticHeaders(
  diagnostics: P4AHandshakeDiagnostics,
): Record<string, string> {
  if (process.env.NODE_ENV === "production") return {};
  return {
    [P4A_DIAGNOSTICS_HEADER]: encodeP4ADiagnostics(diagnostics),
  };
}

function mergeDiagnostics(
  runtime: WalletActivityRuntime,
  input: P4AHandshakeDiagnostics,
): P4AHandshakeDiagnostics {
  const trace = runtime.facilitatorTrace.snapshot();
  const merged = sanitizeP4ADiagnostics({
    ...input,
    ...(trace.verification
      ? {
          verification: {
            ...trace.verification,
            ...input.verification,
          },
        }
      : {}),
    ...(trace.settlement
      ? {
          settlement: {
            ...trace.settlement,
            ...input.settlement,
          },
        }
      : {}),
  });
  if (!merged) throw new Error("invalid P4A handshake diagnostics");
  return merged;
}

function nextResponse(
  result: Extract<HTTPProcessResult, { type: "payment-error" }>,
  diagnostics: P4AHandshakeDiagnostics,
): Response {
  return new Response(
    JSON.stringify(result.response.body ?? {}),
    {
      status: result.response.status,
      headers: {
        "content-type": "application/json",
        ...result.response.headers,
        ...diagnosticHeaders(diagnostics),
      },
    },
  );
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error("a valid x-omnis idempotency key is required after payment verification");
  }
  return value;
}

async function readWallet(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new WalletActivityInputError("request body must be valid JSON");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { wallet?: unknown }).wallet !== "string"
  ) {
    throw new WalletActivityInputError("request body must include a wallet string");
  }
  return (body as { wallet: string }).wallet;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const statusCode = (error as Record<string, unknown>).statusCode;
    if (
      typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
    ) {
      return statusCode;
    }
  }
  const message = error instanceof Error ? error.message : undefined;
  const match = message?.match(/Facilitator (?:verify|settle) failed \((\d{3})\)/);
  return match ? Number(match[1]) : undefined;
}

function errorField(error: unknown, field: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[field];
}

function settlementFailureFromError(
  error: unknown,
  requirements: PaymentRequirements,
): SettleResponse | undefined {
  const status = errorStatus(error);
  const reason = sanitizeP4ADiagnosticText(
    errorField(error, "errorReason") ??
      (status ? `facilitator_settle_http_${status}` : undefined),
  );
  const message = sanitizeP4ADiagnosticText(errorField(error, "errorMessage"));
  const transaction = errorField(error, "transaction");
  if (
    status !== 400 &&
    status !== 429 &&
    !reason &&
    !message &&
    typeof transaction !== "string"
  ) {
    return undefined;
  }
  return {
    success: false,
    ...(reason ? { errorReason: reason } : {}),
    ...(message ? { errorMessage: message } : {}),
    ...(typeof errorField(error, "payer") === "string"
      ? { payer: errorField(error, "payer") as string }
      : {}),
    transaction: typeof transaction === "string" ? transaction : "",
    network: requirements.network,
  };
}

function settlementTransaction(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function settlementFailureResponse(
  settlement: SettleResponse,
  diagnostics: P4AHandshakeDiagnostics,
  requestId: string,
): Response {
  const transaction = settlementTransaction(settlement.transaction);
  const message =
    sanitizeP4ADiagnosticText(
      settlement.errorMessage ?? settlement.errorReason,
    ) ?? "the facilitator did not confirm settlement";
  return jsonResponse(
    {
      error: "PAYMENT_SETTLEMENT_FAILED",
      message,
      stage: "settlement_failed",
      settlementSent: true,
      paymentSettled: transaction ? "unknown" : false,
      retryable: false,
      moneyMoved: transaction ? "unknown" : "no settlement was confirmed",
      requestId,
    },
    402,
    diagnosticHeaders(diagnostics),
  );
}

export async function handleWalletActivityRequest(
  request: Request,
  dependencies: WalletActivityRequestDependencies = {},
): Promise<Response> {
  let runtime: WalletActivityRuntime;
  try {
    runtime = await (dependencies.getRuntime ?? getWalletActivityRuntime)();
  } catch (error) {
    const configurationInvalid = error instanceof P4AConfigError;
    return jsonResponse(
      failureBody(
        configurationInvalid ? "P4A_CONFIG_INVALID" : "SERVICE_UNAVAILABLE",
        configurationInvalid
          ? "wallet activity service configuration is invalid"
          : "wallet activity service configuration is unavailable",
      ),
      503,
    );
  }

  const adapter = requestAdapter(request);
  const paymentHeader = adapter.getHeader("PAYMENT-SIGNATURE");
  let diagnostics: P4AHandshakeDiagnostics = {
    paymentRequiredPresent: false,
    paymentResponsePresent: false,
    resource: { attempted: false, success: false },
    settlement: { attempted: false },
    recoveryStage: paymentHeader
      ? "verification_sent"
      : "challenge_received",
  };

  let processed: HTTPProcessResult;
  try {
    processed = await runtime.httpServer.processHTTPRequest({
      adapter,
      path: adapter.getPath(),
      method: adapter.getMethod(),
      paymentHeader,
    });
  } catch {
    diagnostics = mergeDiagnostics(runtime, {
      ...diagnostics,
      resourceHttpStatus: 502,
      recoveryStage: "verification_failed",
      verification: {
        ...runtime.facilitatorTrace.snapshot().verification,
        isValid: false,
      },
    });
    return jsonResponse(
      failureBody(
        "PAYMENT_VERIFICATION_FAILED",
        "x402 payment verification failed before settlement",
      ),
      502,
      diagnosticHeaders(diagnostics),
    );
  }

  if (processed.type === "payment-error") {
    const responseHeaders = processed.response.headers;
    diagnostics = mergeDiagnostics(runtime, {
      ...diagnostics,
      resourceHttpStatus: processed.response.status,
      paymentRequiredPresent: hasHeader(responseHeaders, "PAYMENT-REQUIRED"),
      paymentResponsePresent: hasHeader(responseHeaders, "PAYMENT-RESPONSE"),
      recoveryStage: paymentHeader ? "verification_failed" : "challenge_received",
      ...(paymentHeader
        ? {
            verification: {
              ...runtime.facilitatorTrace.snapshot().verification,
              isValid: false,
            },
          }
        : {}),
    });
    return nextResponse(processed, diagnostics);
  }

  diagnostics = mergeDiagnostics(runtime, {
    ...diagnostics,
    recoveryStage: "verification_confirmed",
    verification: {
      ...runtime.facilitatorTrace.snapshot().verification,
      httpStatus:
        runtime.facilitatorTrace.snapshot().verification?.httpStatus ?? 200,
      isValid: true,
    },
  });

  let idempotencyKey: string | undefined;
  if (processed.type === "payment-verified") {
    try {
      idempotencyKey = requireIdempotencyKey(request);
    } catch (error) {
      await processed.cancellationDispatcher
        .cancel({ reason: "after_verify_aborted", responseStatus: 400 })
        .catch(() => undefined);
      diagnostics = mergeDiagnostics(runtime, {
        ...diagnostics,
        resourceHttpStatus: 400,
      });
      return jsonResponse(
        failureBody(
          "IDEMPOTENCY_KEY_REQUIRED",
          error instanceof Error ? error.message : "a valid idempotency key is required",
        ),
        400,
        diagnosticHeaders(diagnostics),
      );
    }
  }

  let snapshot: WalletActivitySnapshot;
  try {
    const wallet = await readWallet(request);
    snapshot = await (dependencies.inspect ?? inspectWalletActivity)(wallet);
  } catch (error) {
    const status = error instanceof WalletActivityInputError ? 400 : 502;
    const errorCode =
      error instanceof WalletActivityInputError ||
      error instanceof WalletActivitySourceError
        ? error.code
        : "WALLET_ACTIVITY_EXECUTION_FAILED";
    diagnostics = mergeDiagnostics(runtime, {
      ...diagnostics,
      resourceHttpStatus: status,
      resource: {
        attempted: true,
        success: false,
        status,
        errorCode,
        ...(error instanceof WalletActivitySourceError &&
        error.upstreamStatus !== undefined
          ? { upstreamStatus: error.upstreamStatus }
          : {}),
      },
      settlement: { attempted: false },
      recoveryStage: "resource_execution",
    });
    return jsonResponse(
      resourceFailureBody(
        "protected wallet activity resource execution failed before settlement",
        idempotencyKey,
      ),
      status,
      diagnosticHeaders(diagnostics),
    );
  }
  const responseBody = JSON.stringify({
    ...snapshot,
    ...(idempotencyKey ? { requestId: idempotencyKey } : {}),
  });
  diagnostics = mergeDiagnostics(runtime, {
    ...diagnostics,
    resourceHttpStatus: 200,
    resource: {
      attempted: true,
      success: true,
      status: 200,
    },
    settlement: { attempted: false },
    recoveryStage:
      processed.type === "payment-verified"
        ? "resource_execution"
        : "resource_released",
  });
  if (processed.type !== "payment-verified") {
    return new Response(responseBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...diagnosticHeaders(diagnostics),
      },
    });
  }

  diagnostics = mergeDiagnostics(runtime, {
    ...diagnostics,
    recoveryStage: "settlement_sent",
    settlement: { attempted: true },
  });
  let settlement: SettleResponse;
  try {
    settlement = processed.beforeHandlerSettlement?.result
      ?? await runtime.facilitator.settle(
        processed.paymentPayload,
        processed.paymentRequirements,
      );
  } catch (error) {
    const explicitFailure = settlementFailureFromError(
      error,
      processed.paymentRequirements,
    );
    if (explicitFailure) {
      diagnostics = mergeDiagnostics(runtime, {
        ...diagnostics,
        resourceHttpStatus: 402,
        paymentResponsePresent: false,
        settlement: {
          attempted: true,
          success: false,
        },
        recoveryStage: "settlement_failed",
      });
      return settlementFailureResponse(
        explicitFailure,
        diagnostics,
        idempotencyKey ?? "unknown",
      );
    }
    diagnostics = mergeDiagnostics(runtime, {
      ...diagnostics,
      resourceHttpStatus: 502,
      settlement: {
        attempted: true,
        ...runtime.facilitatorTrace.snapshot().settlement,
      },
      recoveryStage: "outcome_unknown",
    });
    return jsonResponse(
      {
        error: "PAYMENT_OUTCOME_UNKNOWN",
        message:
          "the settlement request was sent and its outcome is unknown; reconcile before retrying",
        stage: "outcome_unknown",
        settlementSent: true,
        paymentSettled: "unknown",
        retryable: false,
        moneyMoved: "unknown",
        requestId: idempotencyKey,
      },
      502,
      diagnosticHeaders(diagnostics),
    );
  }

  const transaction = settlementTransaction(settlement.transaction);
  const effectiveSettlement: SettleResponse =
    settlement.success === true && !transaction
      ? {
          ...settlement,
          success: false,
          errorReason: "settlement_transaction_missing",
          errorMessage: "facilitator reported success without settlement.transaction",
          transaction: "",
        }
      : settlement;
  const settlementConfirmed =
    effectiveSettlement.success === true && transaction !== undefined;
  diagnostics = mergeDiagnostics(runtime, {
    ...diagnostics,
    resourceHttpStatus: settlementConfirmed ? 200 : 402,
    paymentResponsePresent: settlementConfirmed,
    settlement: {
      attempted: true,
      ...runtime.facilitatorTrace.snapshot().settlement,
      httpStatus:
        runtime.facilitatorTrace.snapshot().settlement?.httpStatus ?? 200,
      success: effectiveSettlement.success,
      ...(effectiveSettlement.errorReason
        ? { errorReason: effectiveSettlement.errorReason }
        : {}),
      ...(effectiveSettlement.errorMessage
        ? { errorMessage: effectiveSettlement.errorMessage }
        : {}),
      ...(effectiveSettlement.transaction
        ? { transaction: effectiveSettlement.transaction }
        : {}),
    },
    recoveryStage: settlementConfirmed
      ? "settlement_confirmed"
      : "settlement_failed",
  });

  if (effectiveSettlement.success !== true) {
    return settlementFailureResponse(
      effectiveSettlement,
      diagnostics,
      idempotencyKey ?? "unknown",
    );
  }

  diagnostics = mergeDiagnostics(runtime, {
    ...diagnostics,
    recoveryStage: "resource_released",
  });
  return new Response(responseBody, {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...runtime.httpServer.createSettlementHeaders(effectiveSettlement),
      ...diagnosticHeaders(diagnostics),
    },
  });
}

export type WalletActivityRuntimeConfigView = Pick<
  HederaX402RuntimeConfig,
  "serviceAccountId" | "blocky402Url"
>;
