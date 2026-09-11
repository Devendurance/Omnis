import {
  HEDERA_TESTNET_MIRROR_NODE_URL,
  isValidHederaEntityId,
} from "@x402/hedera";
import {
  P4A_PROTOCOL,
  type HederaX402RuntimeConfig,
} from "./config";
import type { Blocky402Support } from "./facilitator";
import { WALLET_ACTIVITY_MAX_AMOUNT } from "./requirements";
import type { HederaUsdcMetadata } from "./resource";

const MIRROR_NODE_TIMEOUT_MS = 8_000;
const READY_FREEZE_STATUSES = new Set(["UNFROZEN", "NOT_APPLICABLE"]);
const READY_KYC_STATUSES = new Set(["GRANTED", "NOT_APPLICABLE"]);

export const P4A_PREFLIGHT_ERROR_CODES = {
  accountNotFound: "P4A_ACCOUNT_NOT_FOUND",
  facilitatorUnsupported: "P4A_FACILITATOR_UNSUPPORTED",
  payerInsufficient: "P4A_PAYER_USDC_INSUFFICIENT",
  payerNotAssociated: "P4A_PAYER_USDC_NOT_ASSOCIATED",
  payerNotReady: "P4A_PAYER_USDC_NOT_READY",
  runtimeCheckFailed: "P4A_RUNTIME_CHECK_FAILED",
  serviceNotAssociated: "P4A_SERVICE_USDC_NOT_ASSOCIATED",
  serviceNotReady: "P4A_SERVICE_USDC_NOT_READY",
  tokenMetadataInvalid: "P4A_TOKEN_METADATA_INVALID",
  unavailable: "P4A_PREFLIGHT_UNAVAILABLE",
} as const;

export type P4APreflightErrorCode =
  (typeof P4A_PREFLIGHT_ERROR_CODES)[keyof typeof P4A_PREFLIGHT_ERROR_CODES];

type PreflightAccountBase = Readonly<{
  accountId: string;
  exists: boolean | null;
  associated: boolean | null;
  freezeStatus: string | null;
  kycStatus: string | null;
  ready: boolean;
}>;

export type P4APayerPreflight = Readonly<
  PreflightAccountBase & {
    balanceAtomic: string | null;
    sufficientBalance: boolean | null;
  }
>;

export type P4AReceiverPreflight = PreflightAccountBase;

export type P4APreflightResult = Readonly<{
  network: typeof P4A_PROTOCOL.network;
  asset: Readonly<{
    tokenId: typeof P4A_PROTOCOL.asset;
    symbol: "USDC";
    decimals: typeof P4A_PROTOCOL.decimals;
  }>;
  priceAtomic: string;
  payer: P4APayerPreflight;
  receiver: P4AReceiverPreflight;
  facilitator: Readonly<{
    supported: boolean;
    feePayer: string | null;
  }>;
  readyForOnePaidTest: boolean;
  error?: P4APreflightErrorCode;
}>;

export type P4APreflightOptions = Readonly<{
  config: Pick<
    HederaX402RuntimeConfig,
    "payerAccountId" | "serviceAccountId"
  >;
  token: HederaUsdcMetadata;
  support: Blocky402Support;
  fetchImpl?: typeof fetch;
}>;

export class P4APreflightUnavailableError extends Error {
  readonly code = P4A_PREFLIGHT_ERROR_CODES.unavailable;

  constructor(message: string) {
    super(message);
    this.name = "P4APreflightUnavailableError";
  }
}

type JsonResult = Readonly<{
  status: number;
  body: unknown;
}>;

type TokenRelationship = Readonly<{
  tokenId: string | null;
  balanceAtomic: string | null;
  freezeStatus: string | null;
  kycStatus: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountUrl(accountId: string): string {
  return `${HEDERA_TESTNET_MIRROR_NODE_URL}/api/v1/accounts/${encodeURIComponent(accountId)}`;
}

function tokenRelationshipsUrl(accountId: string): string {
  return `${accountUrl(accountId)}/tokens?token.id=${encodeURIComponent(P4A_PROTOCOL.asset)}`;
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(MIRROR_NODE_TIMEOUT_MS),
    });
  } catch {
    throw new P4APreflightUnavailableError(
      "Hedera Mirror Node preflight request could not be reached",
    );
  }

  if (response.status === 404) return { status: response.status, body: undefined };
  if (!response.ok) {
    throw new P4APreflightUnavailableError(
      `Hedera Mirror Node preflight returned HTTP ${response.status}`,
    );
  }

  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new P4APreflightUnavailableError(
      "Hedera Mirror Node preflight returned invalid JSON",
    );
  }
}

function parseAtomicBalance(value: unknown): string {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }
  throw new P4APreflightUnavailableError(
    "Hedera Mirror Node returned an invalid token balance",
  );
}

async function accountExists(
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const result = await getJson(accountUrl(accountId), fetchImpl);
  if (result.status === 404) return false;
  if (!isRecord(result.body)) {
    throw new P4APreflightUnavailableError(
      "Hedera Mirror Node returned an invalid account response",
    );
  }
  return result.body.deleted !== true;
}

function parseRelationship(value: unknown): TokenRelationship {
  if (!isRecord(value)) {
    throw new P4APreflightUnavailableError(
      "Hedera Mirror Node returned an invalid token relationship",
    );
  }
  return Object.freeze({
    tokenId: typeof value.token_id === "string" ? value.token_id : null,
    balanceAtomic:
      value.balance === undefined ? null : parseAtomicBalance(value.balance),
    freezeStatus:
      typeof value.freeze_status === "string" ? value.freeze_status : null,
    kycStatus: typeof value.kyc_status === "string" ? value.kyc_status : null,
  });
}

async function tokenRelationship(
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<TokenRelationship | undefined> {
  const result = await getJson(tokenRelationshipsUrl(accountId), fetchImpl);
  if (result.status === 404) return undefined;
  if (!isRecord(result.body) || !Array.isArray(result.body.tokens)) {
    throw new P4APreflightUnavailableError(
      "Hedera Mirror Node returned an invalid token relationship response",
    );
  }
  const relationship = result.body.tokens.find((candidate) => {
    return isRecord(candidate) && candidate.token_id === P4A_PROTOCOL.asset;
  });
  return relationship === undefined ? undefined : parseRelationship(relationship);
}

function relationshipIsReady(relationship: TokenRelationship | undefined): boolean {
  return (
    relationship !== undefined &&
    relationship.tokenId === P4A_PROTOCOL.asset &&
    relationship.balanceAtomic !== null &&
    relationship.freezeStatus !== null &&
    READY_FREEZE_STATUSES.has(relationship.freezeStatus) &&
    relationship.kycStatus !== null &&
    READY_KYC_STATUSES.has(relationship.kycStatus)
  );
}

function tokenMatchesAllowlist(token: HederaUsdcMetadata): boolean {
  return (
    token.asset === P4A_PROTOCOL.asset &&
    token.symbol === "USDC" &&
    token.decimals === P4A_PROTOCOL.decimals
  );
}

function supportMatchesAllowlist(support: Blocky402Support): boolean {
  return (
    support.x402Version === P4A_PROTOCOL.version &&
    support.scheme === P4A_PROTOCOL.scheme &&
    support.network === P4A_PROTOCOL.network &&
    isValidHederaEntityId(support.feePayer)
  );
}

function unknownPayer(accountId: string): P4APayerPreflight {
  return Object.freeze({
    accountId,
    exists: null,
    associated: null,
    balanceAtomic: null,
    sufficientBalance: null,
    freezeStatus: null,
    kycStatus: null,
    ready: false,
  });
}

function unknownReceiver(accountId: string): P4AReceiverPreflight {
  return Object.freeze({
    accountId,
    exists: null,
    associated: null,
    freezeStatus: null,
    kycStatus: null,
    ready: false,
  });
}

function baseResult(
  config: Pick<
    HederaX402RuntimeConfig,
    "payerAccountId" | "serviceAccountId"
  >,
  support: Blocky402Support,
): Omit<P4APreflightResult, "readyForOnePaidTest" | "error"> {
  return {
    network: P4A_PROTOCOL.network,
    asset: {
      tokenId: P4A_PROTOCOL.asset,
      symbol: "USDC",
      decimals: P4A_PROTOCOL.decimals,
    },
    priceAtomic: WALLET_ACTIVITY_MAX_AMOUNT.toString(),
    payer: unknownPayer(config.payerAccountId),
    receiver: unknownReceiver(config.serviceAccountId),
    facilitator: {
      supported: supportMatchesAllowlist(support),
      feePayer: supportMatchesAllowlist(support) ? support.feePayer : null,
    },
  };
}

function failedResult(
  config: Pick<
    HederaX402RuntimeConfig,
    "payerAccountId" | "serviceAccountId"
  >,
  support: Blocky402Support,
  error: P4APreflightErrorCode,
): P4APreflightResult {
  return Object.freeze({
    ...baseResult(config, support),
    readyForOnePaidTest: false,
    error,
  });
}

export async function runP4APreflight(
  options: P4APreflightOptions,
): Promise<P4APreflightResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!tokenMatchesAllowlist(options.token)) {
    return failedResult(
      options.config,
      options.support,
      P4A_PREFLIGHT_ERROR_CODES.tokenMetadataInvalid,
    );
  }
  if (!supportMatchesAllowlist(options.support)) {
    return failedResult(
      options.config,
      options.support,
      P4A_PREFLIGHT_ERROR_CODES.facilitatorUnsupported,
    );
  }

  const [payerExists, receiverExists] = await Promise.all([
    accountExists(options.config.payerAccountId, fetchImpl),
    accountExists(options.config.serviceAccountId, fetchImpl),
  ]);
  const [payerRelationship, receiverRelationship] = await Promise.all([
    payerExists
      ? tokenRelationship(options.config.payerAccountId, fetchImpl)
      : Promise.resolve(undefined),
    receiverExists
      ? tokenRelationship(options.config.serviceAccountId, fetchImpl)
      : Promise.resolve(undefined),
  ]);

  const payerAssociated = payerRelationship !== undefined;
  const payerBalance = payerRelationship?.balanceAtomic ?? null;
  const payerSufficient =
    payerBalance === null
      ? false
      : BigInt(payerBalance) >= WALLET_ACTIVITY_MAX_AMOUNT;
  const payerReady =
    payerExists &&
    payerAssociated &&
    payerSufficient &&
    relationshipIsReady(payerRelationship);
  const receiverAssociated = receiverRelationship !== undefined;
  const receiverReady =
    receiverExists &&
    receiverAssociated &&
    relationshipIsReady(receiverRelationship);
  const result = {
    network: P4A_PROTOCOL.network,
    asset: {
      tokenId: P4A_PROTOCOL.asset,
      symbol: "USDC" as const,
      decimals: P4A_PROTOCOL.decimals,
    },
    priceAtomic: WALLET_ACTIVITY_MAX_AMOUNT.toString(),
    payer: {
      accountId: options.config.payerAccountId,
      exists: payerExists,
      associated: payerAssociated,
      balanceAtomic: payerBalance,
      sufficientBalance: payerSufficient,
      freezeStatus: payerRelationship?.freezeStatus ?? null,
      kycStatus: payerRelationship?.kycStatus ?? null,
      ready: payerReady,
    },
    receiver: {
      accountId: options.config.serviceAccountId,
      exists: receiverExists,
      associated: receiverAssociated,
      freezeStatus: receiverRelationship?.freezeStatus ?? null,
      kycStatus: receiverRelationship?.kycStatus ?? null,
      ready: receiverReady,
    },
    facilitator: {
      supported: true,
      feePayer: options.support.feePayer,
    },
  } satisfies Omit<P4APreflightResult, "readyForOnePaidTest" | "error">;

  let error: P4APreflightErrorCode | undefined;
  if (!payerExists || !receiverExists) {
    error = P4A_PREFLIGHT_ERROR_CODES.accountNotFound;
  } else if (!payerAssociated) {
    error = P4A_PREFLIGHT_ERROR_CODES.payerNotAssociated;
  } else if (!payerSufficient) {
    error = P4A_PREFLIGHT_ERROR_CODES.payerInsufficient;
  } else if (!relationshipIsReady(payerRelationship)) {
    error = P4A_PREFLIGHT_ERROR_CODES.payerNotReady;
  } else if (!receiverAssociated) {
    error = P4A_PREFLIGHT_ERROR_CODES.serviceNotAssociated;
  } else if (!relationshipIsReady(receiverRelationship)) {
    error = P4A_PREFLIGHT_ERROR_CODES.serviceNotReady;
  }

  return Object.freeze({
    ...result,
    readyForOnePaidTest: error === undefined,
    ...(error ? { error } : {}),
  });
}

export function unavailableP4APreflight(
  config: Pick<
    HederaX402RuntimeConfig,
    "payerAccountId" | "serviceAccountId"
  >,
  support: Blocky402Support,
  error: P4APreflightErrorCode,
): P4APreflightResult {
  return failedResult(config, support, error);
}
