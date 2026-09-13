import type { ChatMessage } from "../tasks/session";

export const CONVERSATION_WINDOW_SIZE = 8;

export type ChatTaskSummary = Readonly<{
  status: string;
  type?: string;
  recipient?: string | null;
  paymentAmount?: unknown;
  serviceBudget?: unknown;
}>;

export type ChatPolicySummary = Readonly<{
  finalPaymentApprovalRequired?: boolean;
}>;

export type BoundedTaskContext = Readonly<{
  taskStatus?: string;
  taskType?: string;
  recipientPresent: boolean;
  paymentAmountPresent: boolean;
  serviceBudgetPresent: boolean;
  approvalRequired?: boolean;
  settledOrSubmitted: boolean;
}>;

function isLockedStatus(status: string): boolean {
  return (
    status === "settling" ||
    status === "running" ||
    status === "completed" ||
    status === "cancelled" ||
    status === "failed"
  );
}

export function buildBoundedTaskContext(
  task?: ChatTaskSummary,
  policy?: ChatPolicySummary,
): BoundedTaskContext {
  if (!task) {
    return Object.freeze({
      recipientPresent: false,
      paymentAmountPresent: false,
      serviceBudgetPresent: false,
      settledOrSubmitted: false,
    });
  }
  return Object.freeze({
    taskStatus: task.status,
    ...(task.type ? { taskType: task.type } : {}),
    recipientPresent: Boolean(task.recipient),
    paymentAmountPresent: task.paymentAmount !== undefined && task.paymentAmount !== null,
    serviceBudgetPresent: task.serviceBudget !== undefined && task.serviceBudget !== null,
    ...(policy && policy.finalPaymentApprovalRequired !== undefined
      ? { approvalRequired: policy.finalPaymentApprovalRequired }
      : {}),
    settledOrSubmitted: isLockedStatus(task.status),
  });
}

export function buildBoundedMessages(
  messages: readonly ChatMessage[],
): ReadonlyArray<Readonly<{ role: string; content: string }>> {
  return Object.freeze(
    messages
      .slice(-CONVERSATION_WINDOW_SIZE)
      .map((message) =>
        Object.freeze({
          role: message.role === "user" ? "user" : "assistant",
          content: message.content.slice(0, 1000),
        }),
      ),
  );
}

export function isTaskLockedForChat(task?: ChatTaskSummary): boolean {
  if (!task) return false;
  return isLockedStatus(task.status);
}
