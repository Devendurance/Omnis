import { hydrateMoney, serializeMoney } from "../domain/money";
import type { FinancialIntentFields } from "../intent/types";
import { isRecordObject } from "./guard";

function readMoneyField(value: unknown) {
  if (value === undefined) return undefined;
  return hydrateMoney(value);
}

export function serializePromotedIntent(
  fields: FinancialIntentFields,
): Record<string, unknown> {
  return Object.freeze({
    ...(fields.type ? { type: fields.type } : {}),
    ...(fields.recipient ? { recipient: fields.recipient } : {}),
    ...(fields.paymentAmountText ? { paymentAmountText: fields.paymentAmountText } : {}),
    ...(fields.paymentAsset ? { paymentAsset: fields.paymentAsset } : {}),
    ...(fields.purpose ? { purpose: fields.purpose } : {}),
    ...(fields.finalPaymentApprovalRequired !== undefined
      ? { finalPaymentApprovalRequired: fields.finalPaymentApprovalRequired }
      : {}),
    ...(fields.unsupportedAsset ? { unsupportedAsset: fields.unsupportedAsset } : {}),
    ...(fields.paymentAmount ? { paymentAmount: serializeMoney(fields.paymentAmount) } : {}),
    ...(fields.serviceBudget
      ? { serviceBudget: serializeMoney(fields.serviceBudget) }
      : {}),
    ...(fields.perServiceCap ? { perServiceCap: serializeMoney(fields.perServiceCap) } : {}),
  });
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readPromotedIntent(value: unknown): FinancialIntentFields | undefined {
  if (!isRecordObject(value)) return undefined;
  try {
    const type = readOptionalText(value.type);
    if (
      type !== undefined &&
      type !== "pay" &&
      type !== "pay_with_check" &&
      type !== "delegate"
    ) {
      return undefined;
    }
    const paymentAmount = readMoneyField(value.paymentAmount);
    const serviceBudget = readMoneyField(value.serviceBudget);
    const perServiceCap = readMoneyField(value.perServiceCap);
    const approval = value.finalPaymentApprovalRequired;
    if (approval !== undefined && typeof approval !== "boolean") return undefined;
    return Object.freeze({
      ...(type ? { type: type as FinancialIntentFields["type"] } : {}),
      ...(readOptionalText(value.recipient)
        ? { recipient: readOptionalText(value.recipient) as string }
        : {}),
      ...(readOptionalText(value.paymentAmountText)
        ? { paymentAmountText: readOptionalText(value.paymentAmountText) as string }
        : {}),
      ...(readOptionalText(value.paymentAsset)
        ? { paymentAsset: readOptionalText(value.paymentAsset) as string }
        : {}),
      ...(readOptionalText(value.purpose)
        ? { purpose: readOptionalText(value.purpose) as string }
        : {}),
      ...(approval !== undefined ? { finalPaymentApprovalRequired: approval as boolean } : {}),
      ...(readOptionalText(value.unsupportedAsset)
        ? { unsupportedAsset: readOptionalText(value.unsupportedAsset) as string }
        : {}),
      ...(paymentAmount ? { paymentAmount } : {}),
      ...(serviceBudget ? { serviceBudget } : {}),
      ...(perServiceCap ? { perServiceCap } : {}),
    });
  } catch {
    return undefined;
  }
}
