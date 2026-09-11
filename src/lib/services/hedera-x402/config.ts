import {
  HEDERA_TESTNET_CAIP2,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
  PrivateKey,
  isValidHederaEntityId,
} from "@x402/hedera";
import {
  HEDERA_TESTNET_NETWORK,
  HEDERA_TESTNET_USDC_ASSET,
  WALLET_ACTIVITY_SERVICE_PATH,
} from "../wallet-activity-descriptor";

export const BLOCKY402_DEFAULT_URL = "https://api.testnet.blocky402.com" as const;
export const WALLET_ACTIVITY_RPC_URL = "https://ethereum.publicnode.com" as const;
export const WALLET_ACTIVITY_RPC_TIMEOUT_MS = 8_000 as const;
export const P4A_SPIKE_ROUTE_PATH = "/api/dev/x402-wallet-activity" as const;
export const P4A_SPIKE_TOKEN_HEADER = "x-omnis-p4a-token" as const;
export const IDEMPOTENCY_KEY_HEADER = "x-omnis-idempotency-key" as const;
export const WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS = 180 as const;

export type P4AEnvironment = Readonly<Record<string, string | undefined>>;

export type HederaX402RuntimeConfig = Readonly<{
  payerAccountId: string;
  payerPrivateKey: string;
  serviceAccountId: string;
  blocky402Url: string;
}>;

export type P4AConfigInspection = Readonly<{
  configured: boolean;
  missing: readonly string[];
  invalid: readonly string[];
}>;

export class P4AConfigError extends Error {
  readonly code = "P4A_CONFIG_INVALID" as const;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(
    message: string,
    details: Readonly<{ missing?: readonly string[]; invalid?: readonly string[] }> = {},
  ) {
    super(message);
    this.name = "P4AConfigError";
    this.missing = Object.freeze([...(details.missing ?? [])]);
    this.invalid = Object.freeze([...(details.invalid ?? [])]);
  }
}

function requiredEnv(
  env: P4AEnvironment,
  name: string,
  missing: string[],
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    missing.push(name);
    return undefined;
  }
  return value;
}

function canonicalBlocky402Url(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new P4AConfigError("BLOCKY402_TESTNET_URL must be a valid URL", {
      invalid: ["BLOCKY402_TESTNET_URL"],
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "api.testnet.blocky402.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new P4AConfigError(
      "BLOCKY402_TESTNET_URL must point to the hosted Blocky402 testnet facilitator",
      { invalid: ["BLOCKY402_TESTNET_URL"] },
    );
  }
  return BLOCKY402_DEFAULT_URL;
}

function validateAccountId(value: string, field: string, invalid: string[]): void {
  if (!isValidHederaEntityId(value)) invalid.push(field);
}

function validateEcdsaPrivateKey(value: string, invalid: string[]): void {
  try {
    PrivateKey.fromStringECDSA(value);
  } catch {
    invalid.push("HEDERA_TESTNET_PAYER_PRIVATE_KEY");
  }
}

export function readHederaX402RuntimeConfig(
  env: P4AEnvironment = process.env,
): HederaX402RuntimeConfig {
  const missing: string[] = [];
  const payerAccountId = requiredEnv(
    env,
    "HEDERA_TESTNET_PAYER_ACCOUNT_ID",
    missing,
  );
  const payerPrivateKey = requiredEnv(
    env,
    "HEDERA_TESTNET_PAYER_PRIVATE_KEY",
    missing,
  );
  const serviceAccountId = requiredEnv(
    env,
    "HEDERA_X402_SERVICE_ACCOUNT_ID",
    missing,
  );
  const blocky402Url = requiredEnv(env, "BLOCKY402_TESTNET_URL", missing);
  if (missing.length > 0) {
    throw new P4AConfigError(
      "P4A Hedera x402 configuration is incomplete",
      { missing },
    );
  }

  const invalid: string[] = [];
  validateAccountId(payerAccountId!, "HEDERA_TESTNET_PAYER_ACCOUNT_ID", invalid);
  validateAccountId(serviceAccountId!, "HEDERA_X402_SERVICE_ACCOUNT_ID", invalid);
  validateEcdsaPrivateKey(payerPrivateKey!, invalid);
  let canonicalUrl: string | undefined;
  try {
    canonicalUrl = canonicalBlocky402Url(blocky402Url!);
  } catch (error) {
    if (error instanceof P4AConfigError) invalid.push(...error.invalid);
    else invalid.push("BLOCKY402_TESTNET_URL");
  }
  if (invalid.length > 0 || !canonicalUrl) {
    throw new P4AConfigError(
      "P4A Hedera x402 configuration is invalid",
      { invalid: [...new Set(invalid)] },
    );
  }

  return Object.freeze({
    payerAccountId: payerAccountId!,
    payerPrivateKey: payerPrivateKey!,
    serviceAccountId: serviceAccountId!,
    blocky402Url: canonicalUrl,
  });
}

export function inspectP4AEnvironment(
  env: P4AEnvironment = process.env,
): P4AConfigInspection {
  try {
    readHederaX402RuntimeConfig(env);
    return Object.freeze({ configured: true, missing: [], invalid: [] });
  } catch (error) {
    if (!(error instanceof P4AConfigError)) {
      return Object.freeze({
        configured: false,
        missing: [],
        invalid: ["unknown"],
      });
    }
    return Object.freeze({
      configured: false,
      missing: error.missing,
      invalid: error.invalid,
    });
  }
}

export function readPublicOrigin(env: P4AEnvironment = process.env): URL | null {
  const raw = env.OMNIS_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new P4AConfigError("OMNIS_PUBLIC_ORIGIN must be a valid URL", {
      invalid: ["OMNIS_PUBLIC_ORIGIN"],
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new P4AConfigError(
      "OMNIS_PUBLIC_ORIGIN must be a bare https origin with no path",
      { invalid: ["OMNIS_PUBLIC_ORIGIN"] },
    );
  }
  return parsed;
}

export function assertWalletActivityEndpoint(
  endpoint: string,
  env: P4AEnvironment = process.env,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new P4AConfigError("P4A service endpoint must be a valid URL", {
      invalid: ["service endpoint"],
    });
  }
  if (
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    parsed.pathname === WALLET_ACTIVITY_SERVICE_PATH &&
    ["http:", "https:"].includes(parsed.protocol)
  ) {
    const localHost = ["127.0.0.1", "localhost"].includes(
      parsed.hostname.toLowerCase(),
    );
    if (localHost) return parsed;
    const publicOrigin = readPublicOrigin(env);
    if (
      publicOrigin &&
      parsed.protocol === "https:" &&
      parsed.origin === publicOrigin.origin
    ) {
      return parsed;
    }
  }
  throw new P4AConfigError(
    "P4A payer may only call the exact allowlisted useOmnis wallet activity endpoint",
    { invalid: ["service endpoint"] },
  );
}

export function resolveWalletActivityEndpoint(
  requestUrl: string,
  env: P4AEnvironment = process.env,
): string {
  const requestOrigin = new URL(requestUrl).origin;
  const publicOrigin = readPublicOrigin(env);
  if (
    env.NODE_ENV === "production" &&
    publicOrigin &&
    requestOrigin === publicOrigin.origin
  ) {
    return new URL(WALLET_ACTIVITY_SERVICE_PATH, publicOrigin.origin).toString();
  }
  return new URL(WALLET_ACTIVITY_SERVICE_PATH, requestOrigin).toString();
}
export function assertLocalWalletActivityEndpoint(endpoint: string): URL {
  const parsed = assertWalletActivityEndpoint(endpoint);
  const localHost = ["127.0.0.1", "localhost"].includes(
    parsed.hostname.toLowerCase(),
  );
  if (!localHost) {
    throw new P4AConfigError(
      "P4A payer may only call the exact local useOmnis wallet activity endpoint",
      { invalid: ["service endpoint"] },
    );
  }
  return parsed;
}


export const P4A_PROTOCOL = Object.freeze({
  version: 2,
  scheme: "exact",
  network: HEDERA_TESTNET_CAIP2,
  descriptorNetwork: HEDERA_TESTNET_NETWORK,
  asset: HEDERA_TESTNET_USDC,
  descriptorAsset: HEDERA_TESTNET_USDC_ASSET,
  decimals: HEDERA_USDC_DECIMALS,
});
