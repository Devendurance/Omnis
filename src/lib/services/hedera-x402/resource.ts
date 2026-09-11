import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
} from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import {
  HEDERA_TESTNET_MIRROR_NODE_URL,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  createWalletActivityServiceDescriptor,
  WALLET_ACTIVITY_SERVICE_PATH,
} from "../wallet-activity-descriptor";
import {
  IDEMPOTENCY_KEY_HEADER,
  WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS,
  readHederaX402RuntimeConfig,
  type HederaX402RuntimeConfig,
} from "./config";
import {
  Blocky402FacilitatorClient,
  createBlocky402Facilitator,
  createTracedFacilitator,
  parseBlocky402Support,
  type Blocky402Support,
  type P4AFacilitatorTrace,
} from "./facilitator";
import {
  expectedWalletActivityRequirements,
  validateWalletActivityPaymentRequirement,
} from "./requirements";

export type HederaUsdcMetadata = Readonly<{
  asset: string;
  decimals: number;
  symbol?: string;
}>;

export class HederaUsdcMetadataError extends Error {
  readonly code = "HEDERA_USDC_METADATA_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "HederaUsdcMetadataError";
  }
}

export async function verifyHederaTestnetUsdc(
  fetchImpl: typeof fetch = fetch,
): Promise<HederaUsdcMetadata> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${HEDERA_TESTNET_MIRROR_NODE_URL}/api/v1/tokens/${HEDERA_TESTNET_USDC}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    throw new HederaUsdcMetadataError(
      "Hedera testnet Mirror Node token metadata could not be reached",
    );
  }
  if (!response.ok) {
    throw new HederaUsdcMetadataError(
      `Hedera testnet Mirror Node returned HTTP ${response.status} for USDC metadata`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HederaUsdcMetadataError(
      "Hedera testnet Mirror Node returned invalid USDC metadata",
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HederaUsdcMetadataError("Hedera USDC metadata is not an object");
  }
  const candidate = body as {
    token_id?: unknown;
    decimals?: unknown;
    symbol?: unknown;
  };
  if (candidate.token_id !== HEDERA_TESTNET_USDC) {
    throw new HederaUsdcMetadataError(
      "Hedera testnet Mirror Node returned metadata for the wrong token",
    );
  }
  const decimals = String(candidate.decimals ?? "");
  if (decimals !== String(HEDERA_USDC_DECIMALS)) {
    throw new HederaUsdcMetadataError(
      `Hedera testnet USDC decimals changed from ${HEDERA_USDC_DECIMALS}`,
    );
  }
  if (candidate.symbol !== "USDC") {
    throw new HederaUsdcMetadataError(
      "Hedera testnet token id does not advertise the USDC symbol",
    );
  }
  return Object.freeze({
    asset: HEDERA_TESTNET_USDC,
    decimals: HEDERA_USDC_DECIMALS,
    ...(typeof candidate.symbol === "string"
      ? { symbol: candidate.symbol }
      : {}),
  });
}

export type WalletActivityRuntime = Readonly<{
  httpServer: x402HTTPResourceServer;
  facilitator: FacilitatorClient;
  facilitatorTrace: P4AFacilitatorTrace;
  support: Blocky402Support;
  token: HederaUsdcMetadata;
  config: HederaX402RuntimeConfig;
  descriptor: ReturnType<typeof createWalletActivityServiceDescriptor>;
}>;

export type WalletActivityRuntimeOptions = Readonly<{
  config?: HederaX402RuntimeConfig;
  facilitatorClient?: FacilitatorClient;
  support?: Blocky402Support;
  token?: HederaUsdcMetadata;
  fetchImpl?: typeof fetch;
}>;

async function supportFromFacilitator(
  facilitator: FacilitatorClient,
  support: Blocky402Support | undefined,
): Promise<Blocky402Support> {
  if (support) return support;
  if (facilitator instanceof Blocky402FacilitatorClient) {
    await facilitator.getSupported();
    return facilitator.getAdvertisedSupport();
  }
  return parseBlocky402Support(await facilitator.getSupported());
}

export async function createWalletActivityRuntime(
  options: WalletActivityRuntimeOptions = {},
): Promise<WalletActivityRuntime> {
  const config = options.config ?? readHederaX402RuntimeConfig();
  const rawFacilitator =
    options.facilitatorClient ?? createBlocky402Facilitator(config);
  const support = await supportFromFacilitator(rawFacilitator, options.support);
  const tracedFacilitator = createTracedFacilitator(rawFacilitator);
  const facilitator = tracedFacilitator.facilitator;
  const server = new x402ResourceServer(facilitator);
  server.register(
    "hedera:testnet",
    new ExactHederaScheme({
      defaultAssets: {
        "hedera:testnet": {
          asset: HEDERA_TESTNET_USDC,
          decimals: HEDERA_USDC_DECIMALS,
        },
      },
    }),
  );
  const route = {
    accepts: {
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      payTo: config.serviceAccountId,
      price: "$0.003" as const,
      maxTimeoutSeconds: WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS,
    },
    description:
      "Read-only Ethereum wallet activity observations for a bounded payment decision.",
    mimeType: "application/json",
    serviceName: "useOmnis wallet activity check",
  };
  const httpServer = new x402HTTPResourceServer(server, {
    [`POST ${WALLET_ACTIVITY_SERVICE_PATH}`]: route,
  });
  await httpServer.initialize();
  const token =
    options.token ?? (await verifyHederaTestnetUsdc(options.fetchImpl ?? fetch));
  if (token.asset !== HEDERA_TESTNET_USDC || token.decimals !== HEDERA_USDC_DECIMALS) {
    throw new HederaUsdcMetadataError(
      "runtime USDC metadata does not match the allowlisted Hedera testnet token",
    );
  }
  const requirements = await server.buildPaymentRequirements({
    scheme: "exact",
    network: "hedera:testnet",
    payTo: config.serviceAccountId,
    price: "$0.003",
    maxTimeoutSeconds: WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS,
  });
  if (requirements.length !== 1) {
    throw new Error("wallet activity route must expose exactly one payment requirement");
  }
  validateWalletActivityPaymentRequirement(
    requirements[0] as PaymentRequirements,
    config,
    support,
  );
  const expected = expectedWalletActivityRequirements(config, support);
  const actual = requirements[0] as PaymentRequirements;
  if (
    actual.network !== expected.network ||
    actual.scheme !== expected.scheme ||
    actual.asset !== expected.asset ||
    actual.amount !== expected.amount ||
    actual.payTo !== expected.payTo ||
    actual.extra?.feePayer !== expected.extra.feePayer
  ) {
    throw new Error("wallet activity route produced payment requirements outside the allowlist");
  }
  return Object.freeze({
    httpServer,
    facilitator,
    facilitatorTrace: tracedFacilitator.trace,
    support,
    token,
    config,
    descriptor: createWalletActivityServiceDescriptor("available"),
  });
}

let defaultRuntime: Promise<WalletActivityRuntime> | undefined;

export function getWalletActivityRuntime(): Promise<WalletActivityRuntime> {
  if (defaultRuntime) return defaultRuntime;

  let config: HederaX402RuntimeConfig;
  try {
    config = readHederaX402RuntimeConfig();
  } catch (error) {
    return Promise.reject(error);
  }

  const pending = createWalletActivityRuntime({ config });
  const cached = pending.catch((error: unknown) => {
    if (defaultRuntime === cached) defaultRuntime = undefined;
    throw error;
  });
  defaultRuntime = cached;
  return cached;
}

export function resetWalletActivityRuntimeForTests(): void {
  defaultRuntime = undefined;
}

export { IDEMPOTENCY_KEY_HEADER };
