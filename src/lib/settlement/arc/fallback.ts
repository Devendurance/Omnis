import { raiseDomainError } from "../../domain/errors";
import type { ReconciliationProvenance } from "../../domain/types";
import {
  ARC_TESTNET_EXPLORER_API_URL,
  ARC_TESTNET_USDC_ADDRESS,
} from "./config";

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export type ArcScanLog = Readonly<{
  address: string;
  topics: readonly (string | null)[];
  data: string;
  index?: string;
}>;

export type ArcScanTxInfoResult = Readonly<{
  blockNumber: string;
  confirmations?: string;
  from: string;
  to: string;
  hash: string;
  gasLimit?: string;
  gasPrice?: string;
  gasUsed?: string;
  timeStamp?: string;
  success: boolean;
  logs: readonly ArcScanLog[];
  revertReason?: string;
}>;


export type FallbackVerificationParams = Readonly<{
  txInfo: ArcScanTxInfoResult;
  expectedHash: string;
  expectedSourceWallet: string;
  expectedRecipient: string;
  expectedUnits: bigint;
  expectedContract?: string;
  now?: string;
}>;

export type FallbackVerificationResult = Readonly<{
  verified: boolean;
  canonicalHash: string;
  blockNumber: string;
  transactionFee?: string;
  provenance: ReconciliationProvenance;
}>;

function normalizeAddressTopic(address: string): string {
  const clean = address.toLowerCase().replace("0x", "").padStart(64, "0");
  return `0x${clean}`;
}

export function formatArcGasFee(
  gasUsedStr?: string,
  gasPriceStr?: string,
): string | undefined {
  if (!gasUsedStr || !gasPriceStr) return undefined;
  try {
    const gasUsed = BigInt(gasUsedStr);
    const gasPrice = BigInt(gasPriceStr);
    const feeAtomic = gasUsed * gasPrice;
    // 18 decimals for Arc native gas token
    const feeStr = feeAtomic.toString().padStart(19, "0");
    const intPart = feeStr.slice(0, -18) || "0";
    const fracPart = feeStr.slice(-18, -10); // 8 decimal places for display
    return `${intPart}.${fracPart} Arc Native Gas`;
  } catch {
    return undefined;
  }
}

export async function fetchArcScanTxInfo(
  txHash: string,
  options?: {
    apiUrl?: string;
    fetchFn?: typeof fetch;
  },
): Promise<ArcScanTxInfoResult | null> {
  const apiUrl = options?.apiUrl || ARC_TESTNET_EXPLORER_API_URL;
  const customFetch = options?.fetchFn || fetch;
  const url = `${apiUrl}?module=transaction&action=gettxinfo&txhash=${encodeURIComponent(txHash)}`;

  try {
    const res = await customFetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "useOmnis-Arc-Reconciliation/1.0",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (
      typeof data !== "object" ||
      data === null ||
      data.status !== "1" ||
      typeof data.result !== "object" ||
      data.result === null
    ) {
      return null;
    }

    const r = data.result;
    if (typeof r.hash !== "string" || typeof r.blockNumber !== "string") {
      return null;
    }

    const logs: ArcScanLog[] = Array.isArray(r.logs)
      ? r.logs.map((l: Record<string, unknown>) => ({
          address: String(l.address || ""),
          topics: Array.isArray(l.topics) ? l.topics.map((t) => (t ? String(t) : null)) : [],
          data: String(l.data || "0x"),
          index: l.index !== undefined ? String(l.index) : undefined,
        }))
      : [];

    return Object.freeze({
      blockNumber: String(r.blockNumber),
      confirmations: r.confirmations !== undefined ? String(r.confirmations) : undefined,
      from: String(r.from || ""),
      to: String(r.to || ""),
      hash: String(r.hash),
      gasLimit: r.gasLimit !== undefined ? String(r.gasLimit) : undefined,
      gasPrice: r.gasPrice !== undefined ? String(r.gasPrice) : undefined,
      gasUsed: r.gasUsed !== undefined ? String(r.gasUsed) : undefined,
      timeStamp: r.timeStamp !== undefined ? String(r.timeStamp) : undefined,
      success: Boolean(r.success),
      logs: Object.freeze(logs),
      revertReason: r.revertReason !== undefined ? String(r.revertReason) : undefined,
    });
  } catch {
    return null;
  }
}


export function verifyArcScanTxEvidence(
  params: FallbackVerificationParams,
): FallbackVerificationResult {
  const {
    txInfo,
    expectedSourceWallet,
    expectedRecipient,
    expectedUnits,
    now = new Date().toISOString(),
  } = params;
  const expectedContract = (
    params.expectedContract || ARC_TESTNET_USDC_ADDRESS
  ).toLowerCase();

  if (
    params.expectedHash &&
    txInfo.hash.toLowerCase() !== params.expectedHash.toLowerCase()
  ) {
    return raiseDomainError(
      "FALLBACK_HASH_MISMATCH",
      `ArcScan fallback transaction hash ${txInfo.hash} does not match expected transaction hash ${params.expectedHash}`,
    );
  }
  if (!txInfo.success) {
    return raiseDomainError(
      "FALLBACK_TRANSACTION_REVERTED",
      `ArcScan reports transaction ${txInfo.hash} status was not successful: ${txInfo.revertReason || "failed"}`,
    );
  }

  if (!txInfo.blockNumber || !txInfo.blockNumber.trim()) {
    return raiseDomainError(
      "FALLBACK_MISSING_BLOCK",
      `ArcScan transaction ${txInfo.hash} is missing a confirmed block number`,
    );
  }

  const expectedFromTopic = normalizeAddressTopic(expectedSourceWallet);
  const expectedToTopic = normalizeAddressTopic(expectedRecipient);

  let validTransferFound = false;
  for (const log of txInfo.logs) {
    if (log.address.toLowerCase() !== expectedContract) continue;
    const topics = log.topics;
    if (topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;
    if (topics[1]?.toLowerCase() !== expectedFromTopic.toLowerCase()) continue;
    if (topics[2]?.toLowerCase() !== expectedToTopic.toLowerCase()) continue;

    try {
      const val = BigInt(log.data);
      if (val === expectedUnits) {
        validTransferFound = true;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!validTransferFound) {
    return raiseDomainError(
      "UNVERIFIED_SETTLEMENT_RECEIPT",
      `ArcScan fallback evidence did not contain the expected Arc USDC Transfer event from ${expectedSourceWallet} to ${expectedRecipient} for ${expectedUnits.toString()} atomic units`,
    );
  }

  const transactionFee = formatArcGasFee(txInfo.gasUsed, txInfo.gasPrice);

  const provenance: ReconciliationProvenance = Object.freeze({
    sourceType: "blockscout_api",
    sourceName: `ArcScan Blockscout API (${ARC_TESTNET_EXPLORER_API_URL})`,
    primaryRpcObserved: false,
    fallbackObserved: true,
    verifiedAt: now,
    blockNumber: txInfo.blockNumber,
    transactionHash: txInfo.hash,
    ...(transactionFee ? { transactionFee } : {}),
  });

  return Object.freeze({
    verified: true,
    canonicalHash: txInfo.hash,
    blockNumber: txInfo.blockNumber,
    transactionFee,
    provenance,
  });
}
