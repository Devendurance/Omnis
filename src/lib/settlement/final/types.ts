import type { Money, SerializedMoney } from "../../domain/money";
import type {
  ApprovalRecord,
  ArcReconciliationState,
  FinancialTask,
  OmnisProof,
  SettlementExecution,
} from "../../domain/types";
import type {
  PersistedApproval,
  PersistedProof,
  PersistedSettlement,
  PersistedTask,
} from "../../tasks/persistence";
export type FinalSettlementPreflight = Readonly<{
  executionWallet: string;
  recipient: string;
  amount: Money;
  arcChainId: number;
  arcChainReadiness: boolean;
  arcUsdcBalance: Money;
  sufficientBalance: boolean;
  nativeGasBalanceWei: bigint;
  nativeGasRequiredWei: bigint;
  sufficientGas: boolean;
  walletCheckCompleted: boolean;
  serviceAmountSpent: Money;
  serviceBudgetRemaining: Money;
  testMode: boolean;
  effectivePaymentAmount: Money;
  signing: false;
  transaction: "not_submitted";
  readyForApproval: boolean;
  blockers: readonly string[];
}>;

export type SerializedFinalSettlementPreflight = Readonly<{
  executionWallet: string;
  recipient: string;
  amount: SerializedMoney;
  arcChainId: number;
  arcChainReadiness: boolean;
  arcUsdcBalance: SerializedMoney;
  sufficientBalance: boolean;
  nativeGasBalanceWei: string;
  nativeGasRequiredWei: string;
  sufficientGas: boolean;
  walletCheckCompleted: boolean;
  serviceAmountSpent: SerializedMoney;
  serviceBudgetRemaining: SerializedMoney;
  testMode: boolean;
  effectivePaymentAmount: SerializedMoney;
  signing: false;
  transaction: "not_submitted";
  readyForApproval: boolean;
  blockers: readonly string[];
}>;

export type FinalSettlementAuthorizedExecution = Readonly<{
  sourceWallet: string;
  recipient: string;
  amount: Money;
  requestedAmount?: Money;
  executionAmount?: Money;
  effectiveUnits: string;
  testMode: boolean;
  sourceChain: "Arc Testnet";
  destinationChain: "Arc Testnet";
  chainId: 5042002;
  operationType: "erc20_transfer";
}>;

export type SerializedFinalSettlementAuthorizedExecution = Readonly<{
  sourceWallet: string;
  recipient: string;
  amount: SerializedMoney;
  requestedAmount?: SerializedMoney;
  executionAmount?: SerializedMoney;
  effectiveUnits: string;
  testMode: boolean;
  sourceChain: "Arc Testnet";
  destinationChain: "Arc Testnet";
  chainId: 5042002;
  operationType: "erc20_transfer";
}>;

export type FinalSettlementAction =
  | "prepare"
  | "approve"
  | "submit"
  | "reconcile"
  | "recover_legacy";

export type FinalSettlementResponse = Readonly<{
  ok: boolean;
  error?: string;
  blockers?: readonly string[];
  action?: FinalSettlementAction;
  preflight?: SerializedFinalSettlementPreflight | FinalSettlementPreflight;
  settlement?: PersistedSettlement | SettlementExecution;
  approval?: PersistedApproval | ApprovalRecord;
  task?: PersistedTask | FinancialTask;
  proof?: PersistedProof | OmnisProof;
  authorizedExecution?:
    | SerializedFinalSettlementAuthorizedExecution
    | FinalSettlementAuthorizedExecution;
  status?: "pending" | "confirmed" | "reverted" | "failed" | "unobserved";
  reconciliationState?: ArcReconciliationState;
  testMode?: boolean;
  session?: unknown;
}>;
