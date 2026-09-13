import { formatMoney } from "../domain";
import type {
  ApprovalRecord,
  FinancialTaskType,
  Money,
  SettlementExecution,
} from "../domain";
import { serviceRegistry, type ServiceRegistry } from "../services/registry";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "./persistence";
import type { TaskSession } from "./session";

/**
 * P9A.7 owner-scoped task archive.
 *
 * The live draft session (`useomnis:session:<owner>`) stays the single
 * authoritative financial record. This archive only keeps immutable
 * serialized snapshots of prior sessions so record pages can list history
 * without a second source of financial truth. Storage is browser-local.
 */

export const TASK_ARCHIVE_VERSION = 1 as const;
export const TASK_ARCHIVE_STORAGE_PREFIX = "useomnis:archive:v1:";

type ArchiveStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function getTaskArchiveStorageKey(
  ownerSubject?: string,
): string | null {
  const clean = ownerSubject?.trim();
  if (!clean) return null;
  return `${TASK_ARCHIVE_STORAGE_PREFIX}${clean}`;
}

function readRawEntries(
  storage: ArchiveStorage,
  key: string,
): string[] | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Every member must be a usable snapshot: a malformed member makes the
  // whole archive unreadable so a later write cannot silently discard it.
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.length === 0) return null;
  }
  return parsed as string[];
}
function writeRawEntries(
  storage: ArchiveStorage,
  key: string,
  entries: readonly string[],
): boolean {
  try {
    storage.setItem(key, JSON.stringify([...entries]));
    return true;
  } catch {
    return false;
  }
}

function serializedTaskId(serialized: string): string | undefined {
  try {
    const parsed = JSON.parse(serialized) as {
      task?: { id?: unknown };
    };
    return typeof parsed.task?.id === "string" ? parsed.task.id : undefined;
  } catch {
    return undefined;
  }
}

function sessionHasRecordableState(session: TaskSession): boolean {
  if (session.task) return true;
  if (session.messages.length > 0) return true;
  if ((session.servicePurchases ?? []).length > 0) return true;
  if (session.approval || session.settlement || session.proof) return true;
  if (session.pendingIntent !== undefined) return true;
  return false;
}

/**
 * Snapshot the outgoing active session into the owner archive.
 * Returns false when there is nothing worth keeping, no owner scope, or
 * the stored archive cannot be read back safely. Callers must not replace
 * the active session when this returns false for a session with history.
 * Never throws.
 */
export function archiveTaskSession(
  storage: ArchiveStorage,
  session: TaskSession,
  ownerSubject: string | undefined,
  registry: ServiceRegistry = serviceRegistry,
): boolean {
  const key = getTaskArchiveStorageKey(ownerSubject);
  if (!key) return false;
  if (!sessionHasRecordableState(session)) return false;
  let serialized: string;
  try {
    serialized = serializeDraftSession(session, registry);
  } catch {
    return false;
  }
  const existing = readRawEntries(storage, key);
  // An unreadable archive is not an empty archive: overwriting it could
  // discard previous tasks, so archival fails closed here.
  if (existing === null) return false;
  if (existing.includes(serialized)) return true;
  const taskId = serializedTaskId(serialized);
  const next =
    taskId !== undefined
      ? existing.filter((entry) => serializedTaskId(entry) !== taskId)
      : [...existing];
  next.push(serialized);
  // No eviction: starting a new task must not delete previous tasks.
  return writeRawEntries(storage, key, next);
}
/**
 * Resolve one historical session by task id or by the stable
 * `conversation-<archive index>` fallback used for taskless drafts.
 * Read only: never mutates the archive or the active session.
 */
export function findHistorySession(
  active: TaskSession | null,
  archived: readonly TaskSession[],
  id: string,
): TaskSession | null {
  if (active?.task?.id === id) return active;
  for (const session of archived) {
    if (session.task?.id === id) return session;
  }
  const match = /^conversation-(\d+)$/.exec(id.trim());
  if (match) {
    const index = Number(match[1]);
    const session = archived[index];
    if (session && !session.task) return session;
  }
  return null;
}

/**
 * Stable row id for a session inside its owner's history. Task sessions
 * use the task id; taskless drafts use their archive position.
 */
export function historyRowId(
  session: TaskSession,
  archived: readonly TaskSession[],
): string {
  if (session.task?.id) return session.task.id;
  const index = archived.indexOf(session);
  return `conversation-${index >= 0 ? index : 0}`;
}

/** Hydrated historical sessions for one owner, oldest first. */
export function loadTaskArchive(
  storage: ArchiveStorage,
  ownerSubject: string | undefined,
  registry: ServiceRegistry = serviceRegistry,
): readonly TaskSession[] {
  const key = getTaskArchiveStorageKey(ownerSubject);
  if (!key) return [];
  const owner = ownerSubject?.trim();
  const sessions: TaskSession[] = [];
  const entries = readRawEntries(storage, key);
  if (entries === null) return [];
  for (const entry of entries) {
    try {
      const session = hydrateDraftSession(
        entry,
        registry,
        owner ? { expectedOwnerSubject: owner } : {},
      );
      if (session) sessions.push(session);
    } catch {
      continue;
    }
  }
  return Object.freeze(sessions);
}
export function clearTaskArchive(
  storage: ArchiveStorage,
  ownerSubject: string | undefined,
): void {
  const key = getTaskArchiveStorageKey(ownerSubject);
  if (!key) return;
  try {
    storage.removeItem(key);
  } catch {
    return;
  }
}

export type ArchivedTaskMode = "pay" | "pay + check" | "delegate";

export function taskModeLabel(type: FinancialTaskType): ArchivedTaskMode {
  if (type === "delegate") return "delegate";
  if (type === "pay_with_check") return "pay + check";
  return "pay";
}

function compactMoney(amount: Money): string {
  return `${formatMoney(amount)} ${amount.asset}`;
}
export type TaskDisplayStatus =
  | "draft"
  | "planned"
  | "awaiting approval"
  | "service paid"
  | "settling"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Single authoritative mapping from persisted session state to the status
 * shown on record pages. Terminal task states win; a paid service purchase
 * surfaces as `service paid` while the task is still in flight. Proof
 * presence alone never decides the label.
 */
export function taskDisplayStatus(session: TaskSession): TaskDisplayStatus {
  const task = session.task;
  if (!task) return "draft";
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "settling") return "settling";
  if (task.status === "awaiting_approval") return "awaiting approval";
  const paid = (session.servicePurchases ?? []).some(
    (purchase) => purchase.status === "paid",
  );
  if (paid) return "service paid";
  if (task.status === "planned") return "planned";
  // `running` has no dedicated record state: execution progress surfaces via
  // service events, so the row keeps the last user-facing checkpoint.
  if (task.status === "running") return "planned";
  return "draft";
}

export function summarizeTaskSession(session: TaskSession): string {
  const task = session.task;
  if (!task) {
    const firstUser = session.messages.find(
      (message) => message.role === "user",
    );
    const text = firstUser?.content.trim();
    return text && text.length > 0 ? text : "Untitled task";
  }
  const who =
    task.purpose?.trim() ||
    task.recipient?.trim() ||
    task.originalIntent?.trim() ||
    "task";
  if (task.paymentAmount) {
    const verb = task.type === "delegate" ? "Delegate" : "Pay";
    return `${verb} ${who} ${compactMoney(task.paymentAmount)}`;
  }
  return task.originalIntent?.trim() || who;
}
function latestTimestamp(session: TaskSession): string {
  const candidates: Array<string | undefined> = [
    session.task?.updatedAt,
    session.task?.createdAt,
    session.approval?.approvedAt,
    session.settlement?.updatedAt,
    session.proof?.createdAt,
  ];
  for (const message of session.messages) {
    candidates.push(message.createdAt);
  }
  for (const purchase of session.servicePurchases ?? []) {
    candidates.push(purchase.updatedAt);
  }
  let latest = "";
  for (const candidate of candidates) {
    if (candidate && candidate > latest) latest = candidate;
  }
  return latest;
}


/**
 * Active session plus archive, newest first. The active session wins when
 * a task id appears in both places. Pristine sessions (no task, messages,
 * or records) are excluded so a fresh draft never renders as history.
 */
export function listTaskHistory(
  active: TaskSession | null,
  archived: readonly TaskSession[],
): readonly TaskSession[] {
  const activeTaskId = active?.task?.id;
  const kept = archived.filter(
    (session) =>
      sessionHasRecordableState(session) &&
      (activeTaskId === undefined || session.task?.id !== activeTaskId),
  );
  const combined =
    active && sessionHasRecordableState(active)
      ? [...kept, active]
      : [...kept];
  const ranked = combined.map((session, index) => ({
    session,
    index,
    at: latestTimestamp(session),
  }));
  ranked.sort((left, right) => {
    if (right.at !== left.at) return right.at < left.at ? -1 : 1;
    return right.index - left.index;
  });
  return Object.freeze(ranked.map((entry) => entry.session));
}

export type TaskHistoryFilter = "all tasks" | "pay" | "delegate";

export function filterTaskHistory(
  sessions: readonly TaskSession[],
  filter: string,
): readonly TaskSession[] {
  if (filter === "pay") {
    return sessions.filter((session) => {
      const mode = taskModeLabel(session.task?.type ?? "pay");
      return mode === "pay" || mode === "pay + check";
    });
  }
  if (filter === "delegate") {
    return sessions.filter(
      (session) => taskModeLabel(session.task?.type ?? "pay") === "delegate",
    );
  }
  return sessions;
}

export function taskMatchesQuery(
  session: TaskSession,
  query: string,
): boolean {
  const clean = query.trim().toLowerCase();
  if (!clean) return true;
  const haystacks = [
    summarizeTaskSession(session),
    session.task?.id,
    session.task?.recipient,
    session.task?.originalIntent,
  ];
  return haystacks.some(
    (field) => field && field.toLowerCase().includes(clean),
  );
}

export type ActivityEventKind = "task" | "service" | "approval" | "settlement";

export type ActivityEvent = Readonly<{
  id: string;
  kind: ActivityEventKind;
  label: string;
  taskId: string;
  taskSummary: string;
  amount?: string;
  status: string;
  at: string;
}>;

function serviceAmountLabel(
  purchase: NonNullable<TaskSession["servicePurchases"]>[number],
): string | undefined {
  const amount = purchase.paidAmount ?? purchase.paymentAmount ?? purchase.quotedAmount;
  return amount ? `$${compactMoney(amount)}` : undefined;
}

/**
 * Derive ledger events only from persisted records. Sessions without a
 * task contribute no events; nothing is synthesized.
 */
export function deriveActivityEvents(
  sessions: readonly TaskSession[],
): readonly ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const session of sessions) {
    const task = session.task;
    if (!task) continue;
    const summary = summarizeTaskSession(session);
    events.push({
      id: `${task.id}:created`,
      kind: "task",
      label: "task created",
      taskId: task.id,
      taskSummary: summary,
      status: task.status,
      at: task.createdAt,
    });
    for (const purchase of session.servicePurchases ?? []) {
      const confirmed = purchase.status === "paid";
      const event: ActivityEvent = {
        id: `${task.id}:service:${purchase.id}`,
        kind: "service",
        label: confirmed
          ? "service purchase confirmed"
          : `service purchase ${purchase.status}`,
        taskId: task.id,
        taskSummary: summary,
        status: purchase.status,
        at: purchase.updatedAt,
      };
      const amount = serviceAmountLabel(purchase);
      events.push(amount ? { ...event, amount } : event);
    }
    const approval: ApprovalRecord | undefined = session.approval;
    if (approval) {
      const event: ActivityEvent = {
        id: `${task.id}:approval:${approval.id}`,
        kind: "approval",
        label: "approval granted",
        taskId: task.id,
        taskSummary: summary,
        status: approval.decision,
        at: approval.approvedAt,
      };
      events.push({ ...event, amount: compactMoney(approval.amount) });
    }
    const settlement: SettlementExecution | undefined = session.settlement;
    if (settlement) {
      const submitted =
        settlement.transactionHash !== undefined ||
        (settlement.status !== "prepared" &&
          settlement.status !== "awaiting_approval");
      const amount = compactMoney(settlement.executionAmount ?? settlement.amount);
      if (submitted) {
        events.push({
          id: `${task.id}:settlement:${settlement.id}:submitted`,
          kind: "settlement",
          label: "settlement submitted",
          taskId: task.id,
          taskSummary: summary,
          amount,
          status: "submitted",
          at: settlement.updatedAt,
        });
      }
      if (settlement.status === "confirmed") {
        events.push({
          id: `${task.id}:settlement:${settlement.id}:confirmed`,
          kind: "settlement",
          label: "settlement confirmed",
          taskId: task.id,
          taskSummary: summary,
          amount,
          status: settlement.status,
          at: settlement.updatedAt,
        });
      }
      if (settlement.status === "failed" || settlement.status === "reverted") {
        events.push({
          id: `${task.id}:settlement:${settlement.id}:${settlement.status}`,
          kind: "settlement",
          label: `settlement ${settlement.status}`,
          taskId: task.id,
          taskSummary: summary,
          amount: compactMoney(settlement.amount),
          status: settlement.status,
          at: settlement.updatedAt,
        });
      }
    }
    if (
      task.status === "completed" ||
      task.status === "cancelled" ||
      task.status === "failed"
    ) {
      const event: ActivityEvent = {
        id: `${task.id}:task:${task.status}`,
        kind: "task",
        label: `task ${task.status}`,
        taskId: task.id,
        taskSummary: summary,
        status: task.status,
        at: task.updatedAt,
      };
      if (session.settlement) {
        const amount =
          session.settlement.executionAmount ?? session.settlement.amount;
        events.push({ ...event, amount: compactMoney(amount) });
      } else {
        events.push(event);
      }
    }
  }
  events.sort((left, right) => {
    if (right.at !== left.at) return right.at < left.at ? -1 : 1;
    return right.id < left.id ? -1 : 1;
  });
  return Object.freeze(events);
}

export type ActivityFilter =
  | "all activity"
  | "services"
  | "approvals"
  | "settlement";

export function filterActivityEvents(
  events: readonly ActivityEvent[],
  filter: string,
): readonly ActivityEvent[] {
  if (filter === "services") return events.filter((e) => e.kind === "service");
  if (filter === "approvals")
    return events.filter((e) => e.kind === "approval");
  if (filter === "settlement")
    return events.filter((e) => e.kind === "settlement");
  return events;
}

export function activityMatchesQuery(
  event: ActivityEvent,
  query: string,
): boolean {
  const clean = query.trim().toLowerCase();
  if (!clean) return true;
  return [event.label, event.taskSummary, event.taskId, event.amount ?? ""].some(
    (field) => field.toLowerCase().includes(clean),
  );
}
