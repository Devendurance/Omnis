import { hydrateMoney, serializeMoney, type SerializedMoney } from "../domain/money";
import { isRecordObject } from "./guard";

export type InterpretRequestSnapshot = Readonly<{
  messages: ReadonlyArray<
    Readonly<{
      role: string;
      content: string;
    }>
  >;
  pendingIntent?: unknown;
  pendingField?: unknown;
  task?: unknown;
  policy?: unknown;
}>;

const KNOWN_PENDING_FIELDS: ReadonlyArray<string> = Object.freeze([
  "serviceBudget",
  "recipient",
  "paymentAmount",
  "paymentAsset",
  "taskType",
]);

export function readPendingField(value: unknown): string | undefined {
  return typeof value === "string" && KNOWN_PENDING_FIELDS.includes(value)
    ? value
    : undefined;
}

function serializeMoneyField(value: unknown): SerializedMoney | undefined {
  if (!isRecordObject(value)) return undefined;
  try {
    return serializeMoney(hydrateMoney(value));
  } catch {
    return undefined;
  }
}

function readTextField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildPendingIntent(value: unknown): Record<string, unknown> | null {
  if (!isRecordObject(value)) return null;
  const paymentAmount = serializeMoneyField(value.paymentAmount);
  const serviceBudget = serializeMoneyField(value.serviceBudget);
  const perServiceCap = serializeMoneyField(value.perServiceCap);
  const type = readTextField(value, "type");
  const recipient = readTextField(value, "recipient");
  const paymentAmountText = readTextField(value, "paymentAmountText");
  const paymentAsset = readTextField(value, "paymentAsset");
  const purpose = readTextField(value, "purpose");
  return {
    ...(type ? { type } : {}),
    ...(recipient ? { recipient } : {}),
    ...(paymentAmountText ? { paymentAmountText } : {}),
    ...(paymentAsset ? { paymentAsset } : {}),
    ...(purpose ? { purpose } : {}),
    ...(paymentAmount ? { paymentAmount } : {}),
    ...(serviceBudget ? { serviceBudget } : {}),
    ...(perServiceCap ? { perServiceCap } : {}),
  };
}

function buildTaskSummary(value: unknown): Record<string, unknown> | null {
  if (!isRecordObject(value)) return null;
  const status = readTextField(value, "status");
  if (!status) return null;
  const type = readTextField(value, "type");
  const recipient = readTextField(value, "recipient");
  const paymentAmount = serializeMoneyField(value.paymentAmount);
  const serviceBudget = serializeMoneyField(value.serviceBudget);
  return {
    status,
    ...(type ? { type } : {}),
    ...(recipient ? { recipient } : {}),
    ...(paymentAmount ? { paymentAmount } : {}),
    ...(serviceBudget ? { serviceBudget } : {}),
  };
}

export function buildInterpretRequestBody(
  text: string,
  snapshot: InterpretRequestSnapshot,
): Record<string, unknown> {
  const policyRecord = isRecordObject(snapshot.policy) ? snapshot.policy : undefined;
  const approvalRequired =
    policyRecord && typeof policyRecord.finalPaymentApprovalRequired === "boolean"
      ? policyRecord.finalPaymentApprovalRequired
      : undefined;
  return Object.freeze({
    action: "interpret",
    userText: text,
    messages: Object.freeze(
      snapshot.messages.slice(-8).map((m) =>
        Object.freeze({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
        }),
      ),
    ),
    pendingIntent: buildPendingIntent(snapshot.pendingIntent),
    task: buildTaskSummary(snapshot.task),
    policy: approvalRequired === undefined ? null : { finalPaymentApprovalRequired: approvalRequired },
    ...(readPendingField(snapshot.pendingField)
      ? { pendingField: readPendingField(snapshot.pendingField) as string }
      : {}),
  });
}
