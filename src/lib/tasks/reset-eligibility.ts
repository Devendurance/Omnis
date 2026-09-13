import type { FinancialTaskStatus, ServicePurchaseStatus, SettlementStatus } from "../domain";
import type { TaskSession } from "./session";

export const NEW_TASK_BLOCKED_MESSAGE =
  "This task is still settling. Finish or reconcile it before starting a new task.";

const SAFE_PURCHASE_STATUSES: readonly ServicePurchaseStatus[] = [
  "quoted",
  "failed",
  "cancelled",
];

const IN_FLIGHT_SETTLEMENT_STATUSES: readonly SettlementStatus[] = [
  "prepared",
  "awaiting_approval",
  "submitting",
  "submitted",
  "confirming",
  "confirmation_delayed",
];

const TERMINAL_TASK_STATUSES: readonly FinancialTaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export type NewTaskEligibility =
  | { allowed: true }
  | { allowed: false; reason: string };

function blocked(): NewTaskEligibility {
  return { allowed: false, reason: NEW_TASK_BLOCKED_MESSAGE };
}

function purchasesAreSafe(session: TaskSession): boolean {
  return (session.servicePurchases ?? []).every(
    (purchase) =>
      SAFE_PURCHASE_STATUSES.includes(purchase.status) &&
      purchase.recoveryState === undefined,
  );
}

function hasInFlightSettlement(session: TaskSession): boolean {
  const settlement = session.settlement;
  if (!settlement) return false;
  if (IN_FLIGHT_SETTLEMENT_STATUSES.includes(settlement.status)) return true;
  if (settlement.status !== "confirmed" && settlement.transactionHash) return true;
  return false;
}

function isResolvedTerminal(session: TaskSession): boolean {
  const task = session.task;
  if (!task || !TERMINAL_TASK_STATUSES.includes(task.status)) return false;
  if (task.status === "completed") {
    return session.settlement?.status === "confirmed";
  }
  if (session.approval !== undefined) return false;
  if (session.settlement) {
    if (!["failed", "reverted", "confirmed"].includes(session.settlement.status)) {
      return false;
    }
  }
  return purchasesAreSafe(session);
}

export function canStartNewTask(
  session: TaskSession,
  financialExecutionPending: boolean,
): NewTaskEligibility {
  if (financialExecutionPending) return blocked();
  if (isResolvedTerminal(session)) return { allowed: true };

  const task = session.task;
  if (!task) {
    if (session.approval || session.settlement) return blocked();
    return purchasesAreSafe(session) ? { allowed: true } : blocked();
  }

  if (task.status === "draft") {
    if (session.approval || session.settlement) return blocked();
    return purchasesAreSafe(session) ? { allowed: true } : blocked();
  }

  if (task.status !== "planned" && task.status !== "awaiting_approval") {
    return blocked();
  }
  if (session.approval || hasInFlightSettlement(session)) return blocked();
  if (session.settlement || !purchasesAreSafe(session)) return blocked();
  return { allowed: true };
}
