import type {
  FinancialTaskType,
  Money,
} from "../domain";

export const INTENT_PARSE_STATUSES = [
  "ready",
  "needs_clarification",
  "unsupported",
  "ambiguous",
] as const;
export type IntentParseStatus = (typeof INTENT_PARSE_STATUSES)[number];

export const INTENT_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type IntentConfidence = (typeof INTENT_CONFIDENCE_LEVELS)[number];

export const INTENT_MISSING_FIELDS = [
  "task_type",
  "recipient",
  "payment_amount",
  "payment_asset",
  "service_budget",
] as const;
export type IntentMissingField = (typeof INTENT_MISSING_FIELDS)[number];

export type FinancialIntentFields = Readonly<{
  type?: FinancialTaskType;
  recipient?: string;
  paymentAmount?: Money;
  paymentAmountText?: string;
  paymentAsset?: string;
  purpose?: string;
  serviceBudget?: Money;
  perServiceCap?: Money;
  finalPaymentApprovalRequired?: boolean;
  unsupportedAsset?: string;
}>;

export type ConversationContext = Readonly<{
  pendingIntent?: FinancialIntentFields;
  pendingField?: string;
}>;

export type FinancialIntentParseResult = Readonly<{
  status: IntentParseStatus;
  intentType?: FinancialTaskType;
  fields: FinancialIntentFields;
  missing: readonly IntentMissingField[];
  ambiguities: readonly string[];
  confidence: IntentConfidence;
  clarification?: string;
  sourceText: string;
}>;
