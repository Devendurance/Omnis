import {
  assertLocalWalletActivityEndpoint,
  P4A_SPIKE_TOKEN_HEADER,
  readHederaX402RuntimeConfig,
  P4AConfigError,
} from "./config";
import {
  Blocky402SupportError,
  type Blocky402Support,
} from "./facilitator";
import {
  P4AResourceExecutionError,
  P4APaymentFailureError,
  P4APaymentRecoveryError,
  P4APayerError,
  payWalletActivityService,
} from "./payer";
import {
  P4A_PREFLIGHT_ERROR_CODES,
  runP4APreflight,
  unavailableP4APreflight,
  type P4APreflightErrorCode,
  type P4APreflightResult,
} from "./preflight";
import {
  createWalletActivityRuntime,
  HederaUsdcMetadataError,
} from "./resource";

type P4ADevRequestOptions = Readonly<{
  createRuntime?: typeof createWalletActivityRuntime;
  runPreflight?: typeof runP4APreflight;
}>;

const UNAVAILABLE_SUPPORT = Object.freeze({
  x402Version: 2,
  scheme: "exact",
  network: "hedera:testnet",
  feePayer: "invalid",
}) as Blocky402Support;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }
  return body as Record<string, unknown>;
}

type P4ARuntimeConfig = ReturnType<typeof readHederaX402RuntimeConfig>;
type P4ARuntime = Awaited<ReturnType<typeof createWalletActivityRuntime>>;

function dryRunPayload(
  config: P4ARuntimeConfig,
  runtime: P4ARuntime,
  preflight: P4APreflightResult,
): Record<string, unknown> {
  return {
    mode: "dry-run",
    configured: true,
    descriptor: {
      id: runtime.descriptor.id,
      environment: runtime.descriptor.environment,
      catalogOnly: runtime.descriptor.catalogOnly,
      network: runtime.descriptor.network,
      paymentProtocol: runtime.descriptor.paymentProtocol,
      status: runtime.descriptor.status,
      price: {
        amount: runtime.descriptor.price.units.toString(),
        asset: runtime.descriptor.price.asset,
        decimals: runtime.descriptor.price.decimals,
      },
    },
    network: preflight.network,
    asset: preflight.asset,
    priceAtomic: preflight.priceAtomic,
    blocky402: {
      url: config.blocky402Url,
      x402Version: runtime.support.x402Version,
      scheme: runtime.support.scheme,
      network: runtime.support.network,
      feePayer: runtime.support.feePayer,
    },
    token: runtime.token,
    payer: preflight.payer,
    receiver: preflight.receiver,
    facilitator: preflight.facilitator,
    signing: "not performed",
    settlement: "not performed",
    readyForOnePaidTest: preflight.readyForOnePaidTest,
    ...(preflight.error ? { error: preflight.error } : {}),
  };
}

function dryRunFailurePayload(
  config: P4ARuntimeConfig,
  error: P4APreflightErrorCode,
): Record<string, unknown> {
  const preflight = unavailableP4APreflight(
    config,
    UNAVAILABLE_SUPPORT,
    error,
  );
  return {
    mode: "dry-run",
    configured: true,
    ...preflight,
    signing: "not performed",
    settlement: "not performed",
  };
}

function runtimeFailureCode(error: unknown): P4APreflightErrorCode {
  if (error instanceof HederaUsdcMetadataError) {
    return P4A_PREFLIGHT_ERROR_CODES.tokenMetadataInvalid;
  }
  if (error instanceof Blocky402SupportError) {
    return P4A_PREFLIGHT_ERROR_CODES.facilitatorUnsupported;
  }
  return P4A_PREFLIGHT_ERROR_CODES.runtimeCheckFailed;
}

export async function handleP4ADevRequest(
  request: Request,
  options: P4ADevRequestOptions = {},
): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return json({ error: "NOT_FOUND" }, 404);
  }
  const spikeToken = process.env.OMNIS_P4A_SPIKE_TOKEN?.trim();
  if (!spikeToken) {
    return json({ error: "P4A_SPIKE_DISABLED" }, 503);
  }
  if (request.headers.get(P4A_SPIKE_TOKEN_HEADER) !== spikeToken) {
    return json({ error: "FORBIDDEN" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return json(
      {
        error: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : "invalid request",
      },
      400,
    );
  }
  const action = body.action;
  if (action !== "dry-run" && action !== "pay") {
    return json(
      {
        error: "EXPLICIT_ACTION_REQUIRED",
        message: "action must be dry-run or pay",
      },
      400,
    );
  }

  let config: P4ARuntimeConfig;
  try {
    config = readHederaX402RuntimeConfig();
  } catch (error) {
    if (error instanceof P4AConfigError) {
      return json(
        {
          error: "P4A_CONFIG_INVALID",
          configured: false,
          missing: error.missing,
          invalid: error.invalid,
          readyForOnePaidTest: false,
          signing: "not performed",
          settlement: "not performed",
        },
        503,
      );
    }
    return json(
      {
        error: "P4A_CONFIG_INVALID",
        configured: false,
        readyForOnePaidTest: false,
        signing: "not performed",
        settlement: "not performed",
      },
      503,
    );
  }

  if (action === "dry-run") {
    const createRuntime = options.createRuntime ?? createWalletActivityRuntime;
    const runPreflight = options.runPreflight ?? runP4APreflight;
    let runtime: P4ARuntime;
    try {
      runtime = await createRuntime({ config });
    } catch (error) {
      return json(
        dryRunFailurePayload(config, runtimeFailureCode(error)),
        503,
      );
    }
    try {
      const preflight = await runPreflight({
        config,
        token: runtime.token,
        support: runtime.support,
      });
      return json(
        dryRunPayload(config, runtime, preflight),
        preflight.readyForOnePaidTest ? 200 : 503,
      );
    } catch {
      const code = P4A_PREFLIGHT_ERROR_CODES.unavailable;
      return json(
        dryRunPayload(
          config,
          runtime,
          unavailableP4APreflight(config, runtime.support, code),
        ),
        503,
      );
    }
  }

  if (body.confirm !== "settle-one-testnet-payment") {
    return json(
      {
        error: "EXPLICIT_CONFIRMATION_REQUIRED",
        message: "pay requires confirm=settle-one-testnet-payment",
      },
      400,
    );
  }
  if (typeof body.wallet !== "string" || !body.wallet.trim()) {
    return json({ error: "WALLET_REQUIRED" }, 400);
  }
  const endpoint = new URL(
    "/api/services/wallet-activity",
    request.url,
  ).toString();
  try {
    assertLocalWalletActivityEndpoint(endpoint);
    const result = await payWalletActivityService({
      wallet: body.wallet,
      serviceEndpoint: endpoint,
      config,
      ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
    });
    return json(
      {
        mode: "paid-request",
        requestId: result.requestId,
        paymentIdentifier: result.paymentIdentifier,
        settlement: result.settlement,
        diagnostics: result.diagnostics,
        requirements: result.requirements,
        serviceResult: result.serviceResult,
      },
      200,
    );
  } catch (error) {
    if (error instanceof P4AResourceExecutionError) {
      return json(
        {
          error: error.code,
          message: error.message,
          recovery: error.recovery,
          settlementSent: false,
          paymentSettled: false,
          retryable: true,
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
        },
        502,
      );
    }
    if (error instanceof P4APaymentRecoveryError) {
      return json(
        {
          error: error.code,
          message: error.message,
          recovery: error.recovery,
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
        },
        502,
      );
    }
    if (error instanceof P4APaymentFailureError) {
      return json(
        {
          error: error.code,
          message: error.message,
          recovery: error.recovery,
          ...(error.settlement ? { settlement: error.settlement } : {}),
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
        },
        502,
      );
    }
    if (error instanceof P4APayerError) {
      return json(
        {
          error: error.code,
          message: error.message,
          retryableBeforePayment: error.retryableBeforePayment,
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
        },
        502,
      );
    }
    return json({ error: "P4A_PAID_REQUEST_FAILED" }, 502);
  }
}
