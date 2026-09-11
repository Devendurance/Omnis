import {
  isSettlementTerminal,
  isTaskTerminal,
  settlementTransitions,
  taskTransitions,
  type FinancialTask,
  type FinancialTaskStatus,
  type SettlementExecution,
  type SettlementStatus,
} from "../domain";

export type TaskProgressView = Readonly<{
  status: FinancialTaskStatus;
  isTerminal: boolean;
  nextStatuses: readonly FinancialTaskStatus[];
}>;

export type SettlementProgressView = Readonly<{
  status: SettlementStatus;
  isTerminal: boolean;
  hasTransactionIdentifier: boolean;
  hasTrustedConfirmation: boolean;
  nextStatuses: readonly SettlementStatus[];
  recoveryMode?: "read_only_reconcile";
  canResubmit: false;
}>;

export function selectTaskProgressView(
  task: FinancialTask,
): TaskProgressView {
  return Object.freeze({
    status: task.status,
    isTerminal: isTaskTerminal(task.status),
    nextStatuses: taskTransitions()[task.status],
  });
}

export function selectSettlementProgressView(
  execution: SettlementExecution,
): SettlementProgressView {
  const evidence = execution.confirmationEvidence;
  const hasTransactionIdentifier = Boolean(execution.transactionHash);
  const hasTrustedConfirmation = Boolean(
    hasTransactionIdentifier &&
      evidence?.source === "reconciliation" &&
      (evidence.outcome === "confirmed" || evidence.outcome === "reverted") &&
      evidence.transactionHash === execution.transactionHash &&
      evidence.observedAt.trim(),
  );
  return Object.freeze({
    status: execution.status,
    isTerminal: isSettlementTerminal(execution.status),
    hasTransactionIdentifier,
    hasTrustedConfirmation,
    nextStatuses: settlementTransitions()[execution.status],
    ...(execution.status === "confirmation_delayed" && hasTransactionIdentifier
      ? { recoveryMode: "read_only_reconcile" as const }
      : {}),
    canResubmit: false,
  });
}
