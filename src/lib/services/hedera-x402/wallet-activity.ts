import {
  WALLET_ACTIVITY_RPC_TIMEOUT_MS,
  WALLET_ACTIVITY_RPC_URL,
} from "./config";

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const JSON_RPC_VERSION = "2.0" as const;

export type WalletActivityObservations = Readonly<{
  wallet: string;
  chain: "ethereum:mainnet";
  source: string;
  addressValidity: "valid";
  accountType: "eoa" | "contract" | "unknown";
  transactionCount: string;
  transactionActivityObserved: boolean;
}>;

export type WalletActivityHeuristicFlag = Readonly<{
  code: "no_observed_transaction_history" | "contract_address";
  interpretation: string;
}>;

export type WalletActivitySnapshot = Readonly<{
  observations: WalletActivityObservations;
  heuristicFlags: readonly WalletActivityHeuristicFlag[];
  disclaimer: string;
}>;

export class WalletActivityInputError extends Error {
  readonly code = "WALLET_ACTIVITY_INPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "WalletActivityInputError";
  }
}

export class WalletActivitySourceError extends Error {
  readonly code = "WALLET_ACTIVITY_SOURCE_UNAVAILABLE" as const;
  readonly upstreamStatus?: number;

  constructor(
    message: string,
    options: Readonly<{ upstreamStatus?: number }> = {},
  ) {
    super(message);
    this.name = "WalletActivitySourceError";
    this.upstreamStatus = options.upstreamStatus;
  }
}

type JsonRpcResponse = Readonly<{
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}>;

type JsonRpcBatch = Readonly<{
  responses: readonly JsonRpcResponse[];
  upstreamStatus: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateWallet(wallet: string): string {
  if (typeof wallet !== "string" || !EVM_ADDRESS_PATTERN.test(wallet.trim())) {
    throw new WalletActivityInputError(
      "wallet must be a 20-byte EVM address with a 0x prefix",
    );
  }
  return wallet.trim().toLowerCase();
}

function parseHexQuantity(
  value: unknown,
  field: string,
  upstreamStatus?: number,
): bigint {
  const options =
    upstreamStatus === undefined ? {} : { upstreamStatus };
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new WalletActivitySourceError(
      `Ethereum RPC returned an invalid ${field}`,
      options,
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new WalletActivitySourceError(
      `Ethereum RPC returned an invalid ${field}`,
      options,
    );
  }
}

async function readJsonRpcBatch(
  wallet: string,
  fetchImpl: typeof fetch,
  rpcUrl: string,
): Promise<JsonRpcBatch> {
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify([
        {
          jsonrpc: JSON_RPC_VERSION,
          id: 1,
          method: "eth_getCode",
          params: [wallet, "latest"],
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          id: 2,
          method: "eth_getTransactionCount",
          params: [wallet, "latest"],
        },
      ]),
      signal: AbortSignal.timeout(WALLET_ACTIVITY_RPC_TIMEOUT_MS),
    });
  } catch (error) {
    const message =
      error instanceof Error && /abort|timeout/i.test(error.message)
        ? "Ethereum public RPC request timed out"
        : "Ethereum public RPC could not be reached";
    throw new WalletActivitySourceError(message);
  }
  if (!response.ok) {
    throw new WalletActivitySourceError(
      `Ethereum public RPC returned HTTP ${response.status}`,
      { upstreamStatus: response.status },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WalletActivitySourceError(
      "Ethereum public RPC returned invalid JSON",
      { upstreamStatus: response.status },
    );
  }
  if (
    !Array.isArray(body) ||
    body.length !== 2 ||
    !body.every(isRecord)
  ) {
    throw new WalletActivitySourceError(
      "Ethereum public RPC returned an invalid JSON-RPC batch",
      { upstreamStatus: response.status },
    );
  }
  const responses = body as JsonRpcResponse[];
  const ids = responses.map((candidate) => candidate.id);
  if (
    responses.some((candidate) => candidate.jsonrpc !== JSON_RPC_VERSION) ||
    ids.some((id) => id !== 1 && id !== 2) ||
    new Set(ids).size !== 2
  ) {
    throw new WalletActivitySourceError(
      "Ethereum public RPC returned invalid JSON-RPC response metadata",
      { upstreamStatus: response.status },
    );
  }
  return Object.freeze({
    responses: Object.freeze(responses),
    upstreamStatus: response.status,
  });
}

function responseFor(
  batch: JsonRpcBatch,
  id: number,
  method: string,
): JsonRpcResponse {
  const response = batch.responses.find((candidate) => candidate.id === id);
  if (!response) {
    throw new WalletActivitySourceError(
      `Ethereum public RPC omitted the ${method} result`,
      { upstreamStatus: batch.upstreamStatus },
    );
  }
  if (response.error !== undefined) {
    throw new WalletActivitySourceError(
      `Ethereum public RPC failed the ${method} request`,
      { upstreamStatus: batch.upstreamStatus },
    );
  }
  if (!Object.prototype.hasOwnProperty.call(response, "result")) {
    throw new WalletActivitySourceError(
      `Ethereum public RPC omitted the ${method} result`,
      { upstreamStatus: batch.upstreamStatus },
    );
  }
  return response;
}
export async function inspectWalletActivity(
  wallet: string,
  options: Readonly<{
    fetchImpl?: typeof fetch;
    rpcUrl?: string;
  }> = {},
): Promise<WalletActivitySnapshot> {
  const normalizedWallet = validateWallet(wallet);
  const fetchImpl = options.fetchImpl ?? fetch;
  const rpcUrl = options.rpcUrl ?? WALLET_ACTIVITY_RPC_URL;
  const batch = await readJsonRpcBatch(normalizedWallet, fetchImpl, rpcUrl);
  const code = responseFor(batch, 1, "eth_getCode");
  const transactionCount = responseFor(
    batch,
    2,
    "eth_getTransactionCount",
  );
  if (
    typeof code.result !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(code.result)
  ) {
    throw new WalletActivitySourceError(
      "Ethereum RPC returned invalid contract code",
      { upstreamStatus: batch.upstreamStatus },
    );
  }
  const count = parseHexQuantity(
    transactionCount.result,
    "transaction count",
    batch.upstreamStatus,
  );
  const accountType =
    code.result === "0x"
      ? "eoa"
      : code.result.startsWith("0x") && code.result.length > 2
        ? "contract"
        : "unknown";
  const heuristicFlags: WalletActivityHeuristicFlag[] = [];
  if (count === BigInt(0)) {
    heuristicFlags.push({
      code: "no_observed_transaction_history",
      interpretation:
        "No Ethereum mainnet transaction history was observed at the latest block. This is a heuristic input, not a fraud finding.",
    });
  }
  if (accountType === "contract") {
    heuristicFlags.push({
      code: "contract_address",
      interpretation:
        "The address contains deployed contract code. Contract status alone does not indicate fraud or payment risk.",
    });
  }
  return Object.freeze({
    observations: Object.freeze({
      wallet: normalizedWallet,
      chain: "ethereum:mainnet",
      source: rpcUrl,
      addressValidity: "valid",
      accountType,
      transactionCount: count.toString(),
      transactionActivityObserved: count > BigInt(0),
    }),
    heuristicFlags: Object.freeze(heuristicFlags),
    disclaimer:
      "Observations come from a public read-only Ethereum JSON-RPC source. No authoritative fraud score or third-party risk intelligence is provided.",
  });
}

export function isSupportedWalletAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_PATTERN.test(value.trim());
}
