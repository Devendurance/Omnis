import { money } from "../domain";
import { isRecordObject } from "../conversation/guard";
import type { FinancialIntentFields, IntentMissingField } from "./types";

export const SEMANTIC_INTENTS = [
  "pay",
  "pay_with_check",
  "research",
  "clarify",
  "status",
] as const;
export type SemanticIntent = (typeof SEMANTIC_INTENTS)[number];

export type PendingField =
  | "serviceBudget"
  | "recipient"
  | "paymentAmount"
  | "paymentAsset"
  | "taskType";

export function pendingFieldFor(
  missing: readonly IntentMissingField[],
): PendingField | null {
  const first = missing[0];
  if (first === "service_budget") return "serviceBudget";
  if (first === "recipient") return "recipient";
  if (first === "payment_amount") return "paymentAmount";
  if (first === "payment_asset") return "paymentAsset";
  if (first === "task_type") return "taskType";
  return null;
}

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function wordCountToNumber(text: string): number | undefined {
  const tokens = text.toLowerCase().split(/[\s-]+/);
  if (tokens.length === 1) return WORD_NUMBERS[tokens[0]];
  if (tokens.length === 2) {
    const tens = WORD_NUMBERS[tokens[0]];
    const ones = WORD_NUMBERS[tokens[1]];
    if (
      tens !== undefined &&
      ones !== undefined &&
      tens >= 20 &&
      tens % 10 === 0 &&
      ones >= 1 &&
      ones <= 9
    ) {
      return tens + ones;
    }
  }
  return undefined;
}

function centsToDecimalText(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${dollars}.${rest.toString().padStart(2, "0")}`;
}

const NUMERIC_CENTS_PATTERN =
  /\b(\d{1,3})\s*cents?\b/i;
const WORD_CENTS_PATTERN = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join("|")})(?:[\\s-]+(one|two|three|four|five|six|seven|eight|nine))?\\s*cents?\\b`,
  "i",
);
const WORD_DOLLAR_PATTERN = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join("|")})(?:[\\s-]+(one|two|three|four|five|six|seven|eight|nine))?\\s*dollars?\\b`,
  "i",
);
const DOLLAR_SIGN_PATTERN = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/;
const NUMERIC_DOLLARS_PATTERN =
  /\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*dollars?\b/i;

export function normalizeMoneyPhrase(phrase: string): string | undefined {
  const text = phrase.trim();
  if (!text) return undefined;
  const dollarSign = text.match(DOLLAR_SIGN_PATTERN);
  if (dollarSign) return dollarSign[1].replace(/,/g, "");
  const numericDollars = text.match(NUMERIC_DOLLARS_PATTERN);
  if (numericDollars) return numericDollars[1].replace(/,/g, "");
  const numericCents = text.match(NUMERIC_CENTS_PATTERN);
  if (numericCents) {
    const cents = Number(numericCents[1]);
    if (!Number.isInteger(cents) || cents < 0 || cents > 9900) return undefined;
    return centsToDecimalText(cents);
  }
  const wordCents = text.match(WORD_CENTS_PATTERN);
  if (wordCents) {
    const phraseText = wordCents[2] ? `${wordCents[1]} ${wordCents[2]}` : wordCents[1];
    const cents = wordCountToNumber(phraseText);
    if (cents === undefined) return undefined;
    return centsToDecimalText(cents);
  }
  const wordDollars = text.match(WORD_DOLLAR_PATTERN);
  if (wordDollars) {
    const phraseText = wordDollars[2]
      ? `${wordDollars[1]} ${wordDollars[2]}`
      : wordDollars[1];
    const count = wordCountToNumber(phraseText);
    if (count === undefined) return undefined;
    return `${count}.00`;
  }
  return undefined;
}

const BARE_BUDGET_REPLY_PATTERN =
  /^\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*(usdc|usd|dollars?)?\s*[.!?]?\s*$/i;

export function normalizeServiceBudgetReply(text: string): string | undefined {
  const normalized = normalizeMoneyPhrase(text);
  if (normalized) return normalized;
  const bare = text.match(BARE_BUDGET_REPLY_PATTERN);
  if (bare) return normalizeDecimalText(bare[1]);
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type SemanticExtraction = Readonly<{
  intent?: SemanticIntent;
  recipientAddress?: string;
  recipientEvidence?: string;
  recipientLabel?: string;
  paymentAmount?: string;
  paymentAsset?: string;
  paymentEvidence?: string;
  serviceBudgetAmount?: string;
  serviceBudgetAsset?: string;
  serviceBudgetEvidence?: string;
  requiresWalletCheck?: boolean;
  clarification?: string;
}>;

const SEMANTIC_TEXT_KEYS = [
  "recipientAddress",
  "recipientEvidence",
  "recipientLabel",
  "paymentAmount",
  "paymentAsset",
  "paymentEvidence",
  "serviceBudgetAmount",
  "serviceBudgetAsset",
  "serviceBudgetEvidence",
  "clarification",
] as const;

export function validateSemanticExtraction(
  value: unknown,
): { ok: true; proposal: SemanticExtraction } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, proposal: Object.freeze({}) };
  }
  if (!isRecordObject(value)) return { ok: false, error: "semantic must be an object" };
  if (
    value.intent !== undefined &&
    (typeof value.intent !== "string" ||
      !(SEMANTIC_INTENTS as readonly string[]).includes(value.intent))
  ) {
    return { ok: false, error: "semantic.intent must be a known intent" };
  }
  for (const key of SEMANTIC_TEXT_KEYS) {
    const entry = value[key];
    if (entry !== undefined && asTrimmedString(entry) === undefined) {
      return { ok: false, error: `semantic.${key} must be text` };
    }
  }
  if (
    value.requiresWalletCheck !== undefined &&
    typeof value.requiresWalletCheck !== "boolean"
  ) {
    return { ok: false, error: "semantic.requiresWalletCheck must be boolean" };
  }
  const proposal: Record<string, unknown> = {};
  if (typeof value.intent === "string") proposal.intent = value.intent;
  for (const key of SEMANTIC_TEXT_KEYS) {
    const text = asTrimmedString(value[key]);
    if (text) proposal[key] = key === "clarification" ? text.slice(0, 500) : text.slice(0, 200);
  }
  if (typeof value.requiresWalletCheck === "boolean") {
    proposal.requiresWalletCheck = value.requiresWalletCheck;
  }
  return { ok: true, proposal: Object.freeze(proposal) as SemanticExtraction };
}

export type EvidenceValue = Readonly<{
  units: bigint;
  asset: string;
}>;

export type EvidenceContext = Readonly<{
  sourceText: string;
  pendingRecipient?: string;
  pendingPayment?: EvidenceValue;
  taskRecipient?: string;
  taskPayment?: EvidenceValue;
  pendingServiceBudget?: EvidenceValue;
  taskServiceBudget?: EvidenceValue;
  deterministicPayment?: EvidenceValue;
  deterministicServiceBudget?: EvidenceValue;
}>;

function evidenceValueMatches(
  value: EvidenceValue | undefined,
  amountText: string,
  asset: string,
): boolean {
  if (!value) return false;
  if (value.asset.toUpperCase() !== asset.toUpperCase()) return false;
  try {
    return money(amountText, asset).units === value.units;
  } catch {
    return false;
  }
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function sourceMentionsAddress(sourceText: string, address: string): boolean {
  return sourceText.toLowerCase().includes(address.toLowerCase());
}


function normalizeDecimalText(value: string): string {
  const stripped = value.replace(/,/g, "").trim();
  return stripped.startsWith(".") ? `0${stripped}` : stripped;
}

function decimalVariants(amountText: string): string[] {
  const normalized = normalizeDecimalText(amountText);
  const variants = new Set<string>([normalized]);
  if (/^0\.\d+$/.test(normalized)) variants.add(normalized.slice(1));
  if (/^\.\d+$/.test(normalized)) variants.add(`0${normalized}`);
  return [...variants];
}

const SOURCE_MONEY_PHRASE_PATTERN = new RegExp(
  `(?:\\$\\s*(?:\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+))|(?:\\b(?:\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)\\s*dollars?\\b)|(?:\\b(?:\\d{1,3}|${Object.keys(WORD_NUMBERS).join("|")})(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?\\s*cents?\\b)|(?:\\b(?:${Object.keys(WORD_NUMBERS).join("|")})(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?\\s*dollars?\\b)`,
  "gi",
);
function sourceMentionsPaymentAmount(sourceText: string, amountText: string): boolean {
  const lowered = sourceText.toLowerCase();
  return decimalVariants(amountText).some((variant) => {
    const needle = variant.toLowerCase();
    let from = 0;
    for (;;) {
      const index = lowered.indexOf(needle, from);
      if (index < 0) return false;
      if (/^\s*usdc\b/.test(lowered.slice(index + needle.length, index + needle.length + 8))) {
        return true;
      }
      from = index + needle.length;
    }
  });
}
const BUDGET_WINDOW_PATTERN =
  /\$|spend|spending|budget|allowance|cap|capped|max|up\s*to|no more than|at most|cents?|dollars?|use|using|give/i;

function sourceMentionsBudgetAmount(sourceText: string, amountText: string): boolean {
  const wanted = new Set<string>();
  for (const variant of decimalVariants(amountText)) wanted.add(variant);
  for (const match of sourceText.matchAll(SOURCE_MONEY_PHRASE_PATTERN)) {
    const phraseNormalized = normalizeMoneyPhrase(match[0]);
    if (
      phraseNormalized &&
      decimalVariants(phraseNormalized).some((variant) => wanted.has(variant))
    ) {
      return true;
    }
  }
  const lowered = sourceText.toLowerCase();
  return decimalVariants(amountText).some((variant) => {
    const needle = variant.toLowerCase();
    let from = 0;
    for (;;) {
      const index = lowered.indexOf(needle, from);
      if (index < 0) return false;
      const window = lowered.slice(Math.max(0, index - 48), index + needle.length + 16);
      if (BUDGET_WINDOW_PATTERN.test(window)) return true;
      from = index + needle.length;
    }
  });
}
export type ValidatedSemanticFields = Readonly<{
  type?: FinancialIntentFields["type"];
  recipient?: string;
  recipientLabel?: string;
  paymentAmountText?: string;
  paymentAsset?: string;
  serviceBudgetText?: string;
  requiresWalletCheck?: boolean;
}>;

export function declinesWalletCheck(text: string): boolean {
  return (
    /\b(?:don't|do not|never mind|cancel|skip|forget|without|no)\b[^.!?]{0,40}\bchecks?(?:ing|ed)?\b/i.test(
      text,
    ) || /\bno\s+checks?\b/i.test(text)
  );
}

export function validateSemanticEvidence(
  proposal: SemanticExtraction,
  context: EvidenceContext,
): { ok: true; fields: ValidatedSemanticFields } | { ok: false; error: string } {
  const fields: {
    type?: FinancialIntentFields["type"];
    recipient?: string;
    recipientLabel?: string;
    paymentAmountText?: string;
    paymentAsset?: string;
    serviceBudgetText?: string;
    requiresWalletCheck?: boolean;
  } = {};
  if (proposal.intent) {
    if (proposal.intent === "pay" || proposal.intent === "pay_with_check") {
      fields.type = proposal.intent;
    } else if (proposal.intent === "research") {
      fields.type = "delegate";
    }
  }
  if (proposal.requiresWalletCheck === true) {
    fields.requiresWalletCheck = true;
  } else if (
    proposal.requiresWalletCheck === false &&
    declinesWalletCheck(context.sourceText)
  ) {
    fields.requiresWalletCheck = false;
  }
  if (proposal.recipientLabel) fields.recipientLabel = proposal.recipientLabel;

  if (proposal.recipientAddress) {
    const address = proposal.recipientAddress.trim();
    if (!ADDRESS_PATTERN.test(address)) {
      return { ok: false, error: "semantic recipient is not a valid address" };
    }
    const grounded =
      sourceMentionsAddress(context.sourceText, address) ||
      context.pendingRecipient?.toLowerCase() === address.toLowerCase() ||
      context.taskRecipient?.toLowerCase() === address.toLowerCase();
    if (!grounded) {
      return { ok: false, error: "semantic recipient is not grounded in user input" };
    }
    fields.recipient = address;
  }

  if (proposal.paymentAmount) {
    const asset =
      proposal.paymentAsset?.trim().toUpperCase() ||
      context.deterministicPayment?.asset.toUpperCase() ||
      context.pendingPayment?.asset.toUpperCase() ||
      context.taskPayment?.asset.toUpperCase();
    if (!asset) {
      return { ok: false, error: "semantic payment needs an explicit asset" };
    }
    if (asset !== "USDC") {
      return { ok: false, error: "semantic payment asset must be USDC" };
    }
    const amountText = normalizeDecimalText(proposal.paymentAmount);
    try {
      if (money(amountText, "USDC").units <= BigInt(0)) {
        return { ok: false, error: "semantic payment amount is not positive" };
      }
    } catch {
      return { ok: false, error: "semantic payment amount is not parseable" };
    }
    const grounded =
      sourceMentionsPaymentAmount(context.sourceText, amountText) ||
      evidenceValueMatches(context.pendingPayment, amountText, "USDC") ||
      evidenceValueMatches(context.taskPayment, amountText, "USDC") ||
      evidenceValueMatches(context.deterministicPayment, amountText, "USDC");
    if (!grounded) {
      return { ok: false, error: "semantic payment amount is not grounded" };
    }
    fields.paymentAmountText = amountText;
    fields.paymentAsset = asset;
  }
  if (proposal.serviceBudgetAmount) {
    const budgetAsset =
      proposal.serviceBudgetAsset?.trim().toUpperCase() ||
      context.deterministicServiceBudget?.asset.toUpperCase() ||
      context.pendingServiceBudget?.asset.toUpperCase() ||
      context.taskServiceBudget?.asset.toUpperCase();
    if (!budgetAsset) {
      return { ok: false, error: "semantic service budget needs an explicit asset" };
    }
    const amountText =
      normalizeMoneyPhrase(proposal.serviceBudgetAmount) ??
      normalizeDecimalText(proposal.serviceBudgetAmount);
    try {
      if (money(amountText, "USD").units <= BigInt(0)) {
        return { ok: false, error: "semantic service budget is not positive" };
      }
    } catch {
      return { ok: false, error: "semantic service budget is not parseable" };
    }
    const grounded =
      sourceMentionsBudgetAmount(context.sourceText, amountText) ||
      evidenceValueMatches(context.pendingServiceBudget, amountText, "USD") ||
      evidenceValueMatches(context.taskServiceBudget, amountText, "USD") ||
      evidenceValueMatches(context.deterministicServiceBudget, amountText, "USD");
    if (!grounded) {
      return { ok: false, error: "semantic service budget is not grounded" };
    }
    fields.serviceBudgetText = amountText;
  }

  return { ok: true, fields: Object.freeze(fields) };
}
export function semanticFieldsToIntentFields(
  fields: ValidatedSemanticFields,
): FinancialIntentFields {
  const out: {
    type?: FinancialIntentFields["type"];
    recipient?: string;
    paymentAmountText?: string;
    paymentAsset?: string;
    paymentAmount?: FinancialIntentFields["paymentAmount"];
    serviceBudget?: FinancialIntentFields["serviceBudget"];
  } = {};
  if (fields.type) out.type = fields.type;
  if (fields.recipient) out.recipient = fields.recipient;
  if (fields.paymentAmountText && fields.paymentAsset === "USDC") {
    out.paymentAmountText = fields.paymentAmountText;
    out.paymentAsset = fields.paymentAsset;
    try {
      out.paymentAmount = money(fields.paymentAmountText, "USDC");
    } catch {
      out.paymentAmount = undefined;
    }
  }
  if (fields.serviceBudgetText) {
    try {
      out.serviceBudget = money(fields.serviceBudgetText, "USD");
    } catch {
      out.serviceBudget = undefined;
    }
  }
  return Object.freeze(out);
}
