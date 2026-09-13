import type { FinancialTaskStatus } from "../domain";

const EXECUTABLE_TASK_STATUSES: readonly FinancialTaskStatus[] = [
  "planned",
  "running",
  "awaiting_approval",
];

export type ServiceExecutionGateTask = Readonly<{
  status: FinancialTaskStatus;
  type?: string | null;
  recipient?: string | null;
  paymentAmount?: unknown;
  serviceBudget?: unknown;
}>;

export function isServiceExecutionOffered(
  task: ServiceExecutionGateTask | undefined,
  hasPendingFinancialClarification: boolean,
): task is ServiceExecutionGateTask & { recipient: string } {
  if (!task || hasPendingFinancialClarification) return false;
  if (!EXECUTABLE_TASK_STATUSES.includes(task.status)) return false;
  if (task.type !== "pay_with_check" && task.type !== "delegate") return false;
  if (!task.recipient || !task.paymentAmount || !task.serviceBudget) return false;
  return true;
}
