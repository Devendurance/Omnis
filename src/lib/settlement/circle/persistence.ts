import {
  parseMoney,
  serializeMoney,
  type SerializedMoney,
} from "../../domain/money";
import type {
  CircleSettlementEvidence,
  CircleSettlementExecution,
  CircleSettlementExecutionStatus,
  CircleSettlementFailureReason,
  CircleSettlementOperationType,
  SettlementConfirmationParams,
} from "./types";

export const P6A_SETTLEMENT_STORAGE_PREFIX = "useomnis:p6a:settlement:";
export const P6A_SETTLEMENT_DRAFT_KEY = "useomnis:p6a:settlement:draft";

export function getSettlementStorageKey(ownerSubject?: string): string {
  const clean = ownerSubject?.trim();
  if (!clean) return P6A_SETTLEMENT_DRAFT_KEY;
  return `${P6A_SETTLEMENT_STORAGE_PREFIX}${clean}`;
}

type SerializedSettlementEvidence = Readonly<{
  executionWallet: string;
  recipient: string;
  amount: SerializedMoney;
  asset: "USDC";
  sourceChain: "Arc_Testnet";
  destinationChain: string;
  circleOperation: CircleSettlementOperationType;
  transactionHash: string;
  explorerUrl?: string;
  confirmedStatus: "confirmed" | "reverted";
  blockNumber?: number;
  timestamp: string;
  reconciliationSource?: "onchain_receipt" | "circle_sdk";
}>;

type SerializedSettlementParams = Readonly<{
  sourceWallet: string;
  recipient: string;
  amount: SerializedMoney;
  sourceChain: string;
  destinationChain: string;
  operationType: CircleSettlementOperationType;
  maxFee: SerializedMoney;
}>;

type SerializedSettlementExecution = Readonly<{
  version: 1;
  id: string;
  taskId?: string;
  operationType: CircleSettlementOperationType;
  params: SerializedSettlementParams;
  status: CircleSettlementExecutionStatus;
  transactionHash?: string;
  failureReason?: CircleSettlementFailureReason;
  errorMessage?: string;
  evidence?: SerializedSettlementEvidence;
  submittedAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export function serializeSettlementExecution(
  execution: CircleSettlementExecution,
): string {
  const serialized: SerializedSettlementExecution = {
    version: 1,
    id: execution.id,
    taskId: execution.taskId,
    operationType: execution.operationType,
    params: {
      sourceWallet: execution.params.sourceWallet,
      recipient: execution.params.recipient,
      amount: serializeMoney(execution.params.amount),
      sourceChain: execution.params.sourceChain,
      destinationChain: execution.params.destinationChain,
      operationType: execution.params.operationType,
      maxFee: serializeMoney(execution.params.maxFee),
    },
    status: execution.status,
    transactionHash: execution.transactionHash,
    failureReason: execution.failureReason,
    errorMessage: execution.errorMessage,
    evidence: execution.evidence
      ? {
          ...execution.evidence,
          amount: serializeMoney(execution.evidence.amount),
        }
      : undefined,
    submittedAt: execution.submittedAt,
    confirmedAt: execution.confirmedAt,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };

  return JSON.stringify(serialized);
}

export function deserializeSettlementExecution(
  rawJson: string,
): CircleSettlementExecution {
  const parsed = JSON.parse(rawJson) as SerializedSettlementExecution;
  if (!parsed || parsed.version !== 1 || !parsed.id || !parsed.params) {
    throw new Error("Invalid serialized settlement execution data");
  }

  const params: SettlementConfirmationParams = {
    sourceWallet: parsed.params.sourceWallet,
    recipient: parsed.params.recipient,
    amount: parseMoney(
      parsed.params.amount.amount,
      parsed.params.amount.asset,
      parsed.params.amount.decimals,
    ),
    sourceChain: parsed.params.sourceChain,
    destinationChain: parsed.params.destinationChain,
    operationType: parsed.params.operationType,
    maxFee: parseMoney(
      parsed.params.maxFee.amount,
      parsed.params.maxFee.asset,
      parsed.params.maxFee.decimals,
    ),
  };

  let evidence: CircleSettlementEvidence | undefined;
  if (parsed.evidence) {
    evidence = {
      ...parsed.evidence,
      amount: parseMoney(
        parsed.evidence.amount.amount,
        parsed.evidence.amount.asset,
        parsed.evidence.amount.decimals,
      ),
    };
  }

  return {
    id: parsed.id,
    taskId: parsed.taskId,
    operationType: parsed.operationType,
    params,
    status: parsed.status,
    transactionHash: parsed.transactionHash,
    failureReason: parsed.failureReason,
    errorMessage: parsed.errorMessage,
    evidence,
    submittedAt: parsed.submittedAt,
    confirmedAt: parsed.confirmedAt,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

export function saveSettlementExecution(
  execution: CircleSettlementExecution,
  ownerSubject?: string,
): void {
  if (typeof window === "undefined") return;
  const key = getSettlementStorageKey(ownerSubject);
  const data = serializeSettlementExecution(execution);
  try {
    window.localStorage.setItem(key, data);
  } catch {
    // Storage quota or disabled storage
  }
}

export function loadSettlementExecution(
  ownerSubject?: string,
): CircleSettlementExecution | null {
  if (typeof window === "undefined") return null;
  const key = getSettlementStorageKey(ownerSubject);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return deserializeSettlementExecution(raw);
  } catch {
    return null;
  }
}

export function clearSettlementExecution(ownerSubject?: string): void {
  if (typeof window === "undefined") return;
  const key = getSettlementStorageKey(ownerSubject);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
