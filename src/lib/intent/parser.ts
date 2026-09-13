import {
  formatMoney,
  money,
  type FinancialTaskType,
} from "../domain";
import {
  declinesWalletCheck,
  normalizeServiceBudgetReply,
  pendingFieldFor,
  type PendingField,
} from "./semantic";
import { readPendingField } from "../conversation/request";
import type {
  ConversationContext,
  FinancialIntentFields,
  FinancialIntentParseResult,
  IntentMissingField,
} from "./types";

type MutableFinancialIntentFields = {
  -readonly [Key in keyof FinancialIntentFields]?: FinancialIntentFields[Key];
};

const KNOWN_ASSETS: Readonly<Record<string, true>> = {
  USDC: true,
  USDT: true,
  DAI: true,
  ETH: true,
  USD: true,
  EUR: true,
  WBTC: true,
  MATIC: true,
  SOL: true,
};
const ASSET_STOP_WORDS: Readonly<Record<string, true>> = {
  A: true,
  AN: true,
  AND: true,
  BUT: true,
  FOR: true,
  NO: true,
  OR: true,
  THE: true,
  TO: true,
  CHECK: true,
  CHECKING: true,
  BUDGET: true,
  SERVICE: true,
  RESEARCH: true,
  CAP: true,
  CAPPED: true,
  SPEND: true,
  SPENDING: true,
  MORE: true,
  LESS: true,
  THAN: true,
  AFTER: true,
  BEFORE: true,
  FIRST: true,
  THEN: true,
  WALLET: true,
  CONTRACTOR: true,
  VERIFY: true,
  INSPECT: true,
  CENT: true,
  CENTS: true,
  DOLLAR: true,
  DOLLARS: true,
};

const RECIPIENT_STOP_WORDS: Readonly<Record<string, true>> = {
  a: true,
  an: true,
  another: true,
  contractor: true,
  person: true,
  someone: true,
  somebody: true,
  the: true,
  their: true,
  them: true,
  this: true,
  vendor: true,
};
const STANDALONE_AMOUNT_PATTERN = /^\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)\s*$/;
const STANDALONE_ASSET_PATTERN =
  /^\s*([A-Za-z][A-Za-z0-9._-]*)\s*[.!?]?\s*$/;
const TOKEN_AMOUNT_PATTERN =
  /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*([A-Za-z][A-Za-z0-9._-]*)\b/g;


const PAYMENT_VERB_SOURCE = "pay(?:ing)?|send(?:ing)?|transfer(?:ring)?|payment";
const PAYMENT_VERB_PATTERN = new RegExp(`\\b(?:${PAYMENT_VERB_SOURCE})\\b`, "i");

const BUDGET_KEYWORD_PATTERN =
  /\b(?:spend|budget|allowance|cap|capped(?:\s+at)?|max(?:imum)?|up to|no more than|at most)\b[^0-9$,;.]{0,48}\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/gi;
const BUDGET_SUFFIX_PATTERN =
  /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:USD|dollars?)?\s*(?:service|research|check(?:ing)?)?\s+(?:budget|cap|allowance|max)\b/gi;
const EXPLICIT_CAP_PATTERN =
  /\b(?:per\s+service|each\s+service|per\s+check|service\s+cap|checking\s+cap|capped\s+at)\b[^0-9$]{0,48}\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/gi;
const NUMBER_PATTERN = /(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)/g;
const ZERO_PAYMENT_AMBIGUITY = "payment amount must be greater than zero";

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
const WORD_CENTS_PATTERN = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join("|")})(?:[\\s-]+(one|two|three|four|five|six|seven|eight|nine))?\\s*cents?\\b`,
  "gi",
);
const WORD_BUDGET_CONTEXT_PATTERN =
  /\b(?:at most|up to|no more than|max(?:imum)?|spend|spending|budget|allowance|cap|capped|use|using|give|over|under|within)\b/i;
const CENT_AFTER_CONTEXT_PATTERN =
  /^\s*(?:for|doing|to|on|with|in)\b[\s\S]{0,32}\b(?:services?|check(?:ing)?|inspect(?:ion|ing)?|research|verif\w*|screen(?:ing)?)\b/i;
const NUMERIC_CENTS_PATTERN = /\b(\d{1,3})\s*cents?\b/gi;

function wordCountToNumber(text: string): number | undefined {
  const tokens = text.toLowerCase().split(/[\s-]+/);
  if (tokens.length === 1) {
    return WORD_NUMBERS[tokens[0]];
  }
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

function centBudgetApplies(input: string, index: number, end: number): boolean {
  const before = input.slice(Math.max(0, index - 28), index);
  if (WORD_BUDGET_CONTEXT_PATTERN.test(before)) return true;
  return CENT_AFTER_CONTEXT_PATTERN.test(input.slice(end, end + 48));
}

function extractWordCentBudgets(input: string): string[] {
  const amounts: string[] = [];
  const pushCents = (cents: number | undefined) => {
    if (cents === undefined) return;
    const text = (cents / 100).toFixed(2);
    amounts.push(text.replace(/0$/, "").replace(/\.$/, ".0"));
  };
  for (const match of input.matchAll(WORD_CENTS_PATTERN)) {
    const phrase = match[2] ? `${match[1]} ${match[2]}` : match[1];
    const end = (match.index ?? 0) + match[0].length;
    if (!centBudgetApplies(input, match.index ?? 0, end)) continue;
    pushCents(wordCountToNumber(phrase));
  }
  for (const match of input.matchAll(NUMERIC_CENTS_PATTERN)) {
    const end = (match.index ?? 0) + match[0].length;
    if (!centBudgetApplies(input, match.index ?? 0, end)) continue;
    pushCents(Number(match[1]));
  }
  return amounts;
}
function normalizeAssetToken(
  token: string,
  allowUnknownLowercase: boolean,
): string | undefined {
  const normalized = token.toUpperCase();
  if (ASSET_STOP_WORDS[normalized]) return undefined;
  if (
    KNOWN_ASSETS[normalized] ||
    token === normalized ||
    allowUnknownLowercase
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeNumber(value: string): string {
  const stripped = value.replace(/,/g, "");
  return stripped.startsWith(".") ? `0${stripped}` : stripped;
}

function isZeroAmountText(value: string | undefined): boolean {
  return value !== undefined && /^0+(?:\.0+)?$/.test(normalizeNumber(value));
}

function parseUsdAmount(value: string) {
  try {
    return money(normalizeNumber(value), "USD");
  } catch {
    return undefined;
  }
}

function parseUsdcAmount(value: string) {
  try {
    return money(normalizeNumber(value), "USDC");
  } catch {
    return undefined;
  }
}

const GETS_PAYMENT_PATTERN = /\b(?:gets?|receives?)\s+(?:\$\s*)?(?:\d|\.\d)/i;

function hasPaymentSignal(input: string): boolean {
  if (PAYMENT_VERB_PATTERN.test(input)) return true;
  return GETS_PAYMENT_PATTERN.test(input);
}

function extractBudgetSpans(input: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const collect = (pattern: RegExp) => {
    for (const match of input.matchAll(pattern)) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length });
    }
  };
  collect(BUDGET_KEYWORD_PATTERN);
  collect(BUDGET_SUFFIX_PATTERN);
  collect(EXPLICIT_CAP_PATTERN);
  collect(WORD_CENTS_PATTERN);
  collect(NUMERIC_CENTS_PATTERN);
  return spans;
}

function extractPaymentCandidates(input: string): Array<{
  amountText: string;
  asset: string;
  index: number;
}> {
  const candidates: Array<{
    amountText: string;
    asset: string;
    index: number;
  }> = [];
  const command = PAYMENT_VERB_PATTERN.exec(input);
  const paymentStart = command
    ? command.index + command[0].length
    : 0;
  const paymentSuffix = input.slice(paymentStart);
  const boundary = command
    ? paymentSuffix.search(
        /\b(?:for|because|but|spend|budget|allowance|cap)\b/i,
      )
    : -1;
  const paymentEnd =
    boundary >= 0 ? paymentStart + boundary : input.length;
  const budgetSpans = extractBudgetSpans(input);
  for (const match of input.matchAll(TOKEN_AMOUNT_PATTERN)) {
    const amountText = match[0].match(NUMBER_PATTERN)?.[0];
    const token = match[2];
    const index = match.index ?? 0;
    const startsHexAddress =
      input[index] === "0" && input[index + 1]?.toLowerCase() === "x";
    if (startsHexAddress) continue;
    const asset = token
      ? normalizeAssetToken(token, Boolean(command))
      : undefined;
    if (!amountText || !asset) continue;
    if (budgetSpans.some((span) => index >= span.start && index < span.end)) continue;
    if (command && (index < paymentStart || index >= paymentEnd)) continue;
    const before = input.slice(Math.max(0, index - 36), index);
    const budgetMatch =
      /\b(?:spend|budget|allowance|cap|checking|research)\b/i.exec(before);
    const paymentAfterBudget = budgetMatch
      ? PAYMENT_VERB_PATTERN.test(before.slice(budgetMatch.index))
      : false;
    const budgetContext =
      input[index - 1] === "$" ||
      (Boolean(budgetMatch) && !paymentAfterBudget);
    if (budgetContext) continue;
    candidates.push({
      amountText,
      asset,
      index,
    });
  }
  return candidates;
}

function extractNumericPayment(
  input: string,
  knownBudgetAmounts: Set<string> = new Set(),
): string[] {
  const command = PAYMENT_VERB_PATTERN.exec(input);
  if (!command || command.index === undefined) return [];
  const suffix = input.slice(command.index + command[0].length);
  const limitStart = suffix.search(
    /\b(?:spend|budget|allowance|up\s+to|no\s+more\s+than|for|because|but|cap(?:ped)?|after|with)\b/i,
  );
  const rawPaymentPart = limitStart >= 0 ? suffix.slice(0, limitStart) : suffix;
  const paymentPart = rawPaymentPart.replace(/\b0x[a-fA-F0-9]+\b/g, "");
  return Array.from(paymentPart.matchAll(NUMBER_PATTERN))
    .map((match) => match[0])
    .filter((num) => !knownBudgetAmounts.has(num));
}
const RECIPIENT_COUNT_WORDS: Readonly<Record<string, true>> = {
  hundred: true,
  thousand: true,
  few: true,
  several: true,
};

function extractRecipients(input: string): string[] {
  const values: string[] = [];
  const add = (value: string) => {
    const normalized = value.trim().replace(/[.,!?]+$/, "");
    if (!normalized || RECIPIENT_STOP_WORDS[normalized.toLowerCase()]) return;
    if (!values.includes(normalized)) values.push(normalized);
  };

  for (const match of input.matchAll(/\b0x[a-fA-F0-9]{4,}\b/g)) add(match[0]);
  for (const match of input.matchAll(
    /\b(?:recipient|address|wallet)\s*(?::?\s*is\s*:?|:)\s*([A-Za-z0-9][A-Za-z0-9._-]{2,})\b/gi,
  )) {
    add(match[1]);
  }
  for (const match of input.matchAll(
    /\bto\s+(0x[a-fA-F0-9]{4,}|[A-Za-z0-9][A-Za-z0-9._-]{2,})\b/gi,
  )) {
    const before = input.slice(0, match.index ?? 0);
    if (/\bup\s*$/i.test(before)) continue;
    const candidateWord = match[1].toLowerCase();
    if (WORD_NUMBERS[candidateWord] !== undefined || RECIPIENT_COUNT_WORDS[candidateWord]) continue;
    add(match[1]);
  }
  const hasAddress = values.some((value) => /^0x[a-fA-F0-9]{40}$/.test(value));
  if (hasAddress) {
    return values.filter((value) => /^0x[a-fA-F0-9]{40}$/.test(value));
  }
  return values;
}

function detectType(input: string): FinancialTaskType | undefined {
  const hasPaymentVerb = hasPaymentSignal(input);
  const hasSequentialCheckThenPay =
    /\bcheck\b[\s\S]{0,80}\bthen\s+(?:pay|send|transfer|sending|transferring|paying)\b/i.test(
      input,
    ) ||
    /\bcheck\s+0x[a-fA-F0-9]{4,}\b[\s\S]{0,80}\b(?:pay|send|transfer|sending|transferring|paying)\b/i.test(
      input,
    );
  const hasWalletCheck =
    hasSequentialCheckThenPay ||
    /\b(?:check|checking|verify|inspect|screen|risk)\b[\s\S]{0,48}\b(?:wallet|address|recipient)\b/i.test(
      input,
    ) ||
    /\b(?:wallet|address|recipient)\b[\s\S]{0,48}\b(?:check|checking|verify|inspect|screen|risk)\b/i.test(
      input,
    ) ||
    /\b(?:wallet\s+check|check\s+budget|checking\s+budget|check\s+first)\b/i.test(
      input,
    ) ||
    /\b(?:check|checking|verify|inspect|screen|risk)\b[\s\S]{0,48}\b0x[a-fA-F0-9]{4,}\b/i.test(
      input,
    ) ||
    /\b(?:spend|budget|allowance|cap|capped)\b[\s\S]{0,48}\bcheck(?:ing)?\b/i.test(
      input,
    ) ||
    /\bcheck(?:ing)?\b[\s\S]{0,48}\b(?:spend|budget|allowance|cap|capped)\b/i.test(
      input,
    );
  if (hasPaymentVerb && hasWalletCheck) return "pay_with_check";
  if (!hasPaymentVerb && /\b(?:research|delegate|investigate|analy[sz]e|look into)\b/i.test(input)) {
    return "delegate";
  }
  if (hasPaymentVerb) return "pay";
  return undefined;
}

function detectPurpose(
  input: string,
  type: FinancialTaskType | undefined,
): string | undefined {
  if (/\bcontractor\b/i.test(input)) return "contractor payment";
  if (
    type === "pay_with_check" &&
    /\b(?:wallet|address|recipient)\b/i.test(input)
  ) {
    return "wallet check before payment";
  }
  if (type === "delegate" && /\bwallet\b/i.test(input)) {
    return "wallet research";
  }
  const purposeMatch = /\bfor\s+(?:the\s+)?([^.!?]+)/i.exec(input);
  if (!purposeMatch) return undefined;
  const purpose = purposeMatch[1]
    .replace(/\b(?:spend|budget|allowance|up to|no more than)\b[\s\S]*$/i, "")
    .trim()
    .replace(/[.,]+$/, "");
  return purpose && purpose.length <= 80 ? purpose : undefined;
}

function maskAddresses(input: string): string {
  return input.replace(/\b0x[a-fA-F0-9]+\b/g, "WALLETADDR");
}

function extractBudgetAmounts(input: string): string[] {
  const amounts = new Set<string>();
  const masked = maskAddresses(input);
  for (const match of masked.matchAll(BUDGET_KEYWORD_PATTERN)) {
    if (/\b(?:pay|send|transfer|then)\b/i.test(match[0])) continue;
    amounts.add(match[1]);
  }
  for (const match of masked.matchAll(BUDGET_SUFFIX_PATTERN)) {
    amounts.add(match[1]);
  }
  for (const wordAmount of extractWordCentBudgets(masked)) {
    amounts.add(wordAmount);
  }
  return [...amounts];
}

function extractExplicitCap(input: string): string | undefined {
  return maskAddresses(input).match(EXPLICIT_CAP_PATTERN)?.[1];
}

function clarificationFor(
  type: FinancialTaskType | undefined,
  fields: FinancialIntentFields,
  missing: readonly IntentMissingField[],
  ambiguities: readonly string[],
  unsupportedAsset: string | undefined,
): string | undefined {
  if (unsupportedAsset) {
    return `Omnis supports USDC payments only. No payment was created for ${unsupportedAsset}. Specify the amount in USDC.`;
  }
  if (ambiguities.includes(ZERO_PAYMENT_AMBIGUITY)) {
    return "Payment amount must be greater than zero. What amount should Omnis pay?";
  }
  if (ambiguities.includes("payment asset is ambiguous")) {
    const candidate = fields.paymentAmountText?.trim();
    if (candidate) return `Do you mean ${candidate} USDC?`;
    return "Which supported asset should Omnis use? P1 supports USDC only.";
  }
  if (ambiguities.includes("recipient is ambiguous")) {
    return "I found more than one possible recipient. Which exact wallet address should Omnis use?";
  }
  if (ambiguities.includes("service budget is ambiguous")) {
    return "I found more than one possible checking budget. What is the most Omnis may spend checking?";
  }
  if (ambiguities.length > 0) {
    return "I found more than one possible payment amount. Which amount should Omnis use?";
  }
  const firstMissing = missing[0];
  if (firstMissing === "task_type") {
    return "Should Omnis pay, check a wallet before paying, or delegate research?";
  }
  if (firstMissing === "payment_amount") {
    return "What amount should Omnis pay?";
  }
  if (firstMissing === "payment_asset") {
    return "Which supported asset should Omnis use? P1 supports USDC only.";
  }
  if (firstMissing === "recipient") {
    const amount = fields.paymentAmount
      ? `${formatMoney(fields.paymentAmount)} ${fields.paymentAmount.asset}`
      : "the payment";
    return `Who should receive ${amount}?`;
  }
  if (firstMissing === "service_budget") {
    if (type === "pay_with_check") {
      return "What service budget may Omnis use for the wallet check?";
    }
    return "What research budget may Omnis use?";
  }

  return undefined;
}
function extractFollowupFields(
  input: string,
  pending: FinancialIntentFields,
  pendingFieldOverride?: string,
): {
  fields: MutableFinancialIntentFields;
  ambiguities: string[];
} {
  const fields: MutableFinancialIntentFields = {};
  const ambiguities: string[] = [];
  const missing = buildMissingFields(pending);
  const pendingPaymentAsset = pending.paymentAsset ?? pending.paymentAmount?.asset;
  const amountMatch = STANDALONE_AMOUNT_PATTERN.exec(input);
  const needsPaymentAmount = missing.includes("payment_amount");
  const needsServiceBudget = missing.includes("service_budget");
  const pendingField =
    readPendingField(pendingFieldOverride) ?? pendingFieldFor(missing);
  const trimmed = input.trim();

  if (pendingField === "recipient") {
    const address = trimmed.match(/\b0x[a-fA-F0-9]{40}\b/)?.[0];
    if (address) {
      fields.recipient = address;
      return { fields, ambiguities };
    }
  }

  if (pendingField === "serviceBudget") {
    const mentionsPayment =
      /\bpay(?:ment|ing)?\b/i.test(trimmed) &&
      !/\b(?:budget|cap|allowance|spend|service|check(?:ing)?|cents?|dollars?|\$)\b/i.test(trimmed);
    if (!mentionsPayment) {
      const budgetText = normalizeServiceBudgetReply(trimmed);
      if (budgetText) {
        const serviceBudget = parseUsdAmount(budgetText);
        if (serviceBudget) {
          fields.serviceBudget = serviceBudget;
          return { fields, ambiguities };
        }
      }
    }
  }

  if (amountMatch && needsServiceBudget && !needsPaymentAmount) {
    const serviceBudget = parseUsdAmount(amountMatch[1]);
    if (serviceBudget) fields.serviceBudget = serviceBudget;
  }

  const assetMatch = STANDALONE_ASSET_PATTERN.exec(input);
  const asset = assetMatch
    ? normalizeAssetToken(assetMatch[1], false)
    : undefined;
  const needsAssetCorrection =
    missing.includes("payment_asset") ||
    (pending.paymentAsset !== undefined && pending.paymentAsset !== "USDC");
  if (assetMatch && needsAssetCorrection && asset) {
    fields.paymentAsset = asset;
    if (asset === "USDC" && pending.paymentAmountText) {
      const paymentAmount = parseUsdcAmount(pending.paymentAmountText);
      if (paymentAmount) fields.paymentAmount = paymentAmount;
      fields.unsupportedAsset = undefined;
    } else if (asset !== "USDC") {
      fields.unsupportedAsset = asset;
    }
  }

  if (amountMatch && needsPaymentAmount) {
    fields.paymentAmountText = amountMatch[1];
    if (input.trimStart().startsWith("$")) {
      fields.paymentAsset = "USD";
      fields.unsupportedAsset = "USD";
    } else if (pendingPaymentAsset === "USDC") {
      const paymentAmount = parseUsdcAmount(amountMatch[1]);
      if (paymentAmount) fields.paymentAmount = paymentAmount;
    }
  }

  if (!amountMatch && needsPaymentAmount === false && pending.paymentAmount !== undefined) {
    const correctionAmount =
      input.match(
        /\b(?:actually|make (?:that|it)|change (?:that |it )?to|instead)\b[^\d$]{0,24}(\d+(?:\.\d+)?|\.\d+)/i,
      )?.[1] ?? input.match(/(\d+(?:\.\d+)?|\.\d+)[^\d$]{0,24}\binstead\b/i)?.[1];
    if (
      correctionAmount !== undefined &&
      pendingPaymentAsset === "USDC" &&
      !/\b(?:USD|USDC|dollars?|budget|cap|allowance|spend|service|check(?:ing)?|cents?)\b/i.test(input)
    ) {
      if (pending.type !== undefined) fields.type = pending.type;
      if (correctionAmount.includes(".")) {
        const paymentAmount = parseUsdcAmount(correctionAmount);
        if (paymentAmount) {
          fields.paymentAmountText = correctionAmount;
          fields.paymentAmount = paymentAmount;
        }
      } else {
        fields.paymentAmountText = correctionAmount;
        ambiguities.push("payment asset is ambiguous");
      }
    }
  }
  return { fields, ambiguities };
}

function mergeDefinedFields(
  context: FinancialIntentFields | undefined,
  extracted: MutableFinancialIntentFields,
): MutableFinancialIntentFields {
  const merged: MutableFinancialIntentFields = { ...(context ?? {}) };
  for (const [key, value] of Object.entries(extracted) as Array<
    [keyof FinancialIntentFields, FinancialIntentFields[keyof FinancialIntentFields]]
  >) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

function extractFields(input: string): {
  fields: MutableFinancialIntentFields;
  ambiguities: string[];
} {
  const type = detectType(input);
  const fields: MutableFinancialIntentFields = {
    ...(type ? { type } : {}),
  };
  const ambiguities: string[] = [];
  const budgetAmounts = extractBudgetAmounts(input);
  const explicitCap = extractExplicitCap(input);
  const knownBudgetNumbers = new Set([
    ...budgetAmounts,
    ...(explicitCap ? [explicitCap] : []),
  ]);
  const paymentCandidates = extractPaymentCandidates(input).filter(
    (candidate) => !knownBudgetNumbers.has(candidate.amountText),
  );
  const numericCandidates = extractNumericPayment(input, knownBudgetNumbers);
  const amountCandidates = [
    ...new Set([
      ...paymentCandidates.map((candidate) => candidate.amountText),
      ...numericCandidates,
    ]),
  ];
  const paymentCandidateKeys = new Set(
    paymentCandidates.map((candidate) => `${candidate.amountText}:${candidate.asset}`),
  );
  const paymentAmountIsAmbiguous =
    paymentCandidateKeys.size > 1 || amountCandidates.length > 1;

  if (paymentAmountIsAmbiguous) {
    ambiguities.push("payment amount is ambiguous");
  } else if (amountCandidates.length === 1) {
    const amountText = amountCandidates[0];
    const asset = paymentCandidates[0]?.asset;
    if (asset) {
      fields.paymentAsset = asset;
      fields.paymentAmountText = amountText;
      if (asset === "USDC") {
        const paymentAmount = parseUsdcAmount(amountText);
        if (paymentAmount) fields.paymentAmount = paymentAmount;
        else ambiguities.push("payment amount precision is unsupported");
      } else {
        fields.unsupportedAsset = asset;
      }
    } else {
      fields.paymentAmountText = amountText;
      const commandIndex = input.search(/\b(?:pay|send|transfer)\b/i);
      const amountIndex = input.indexOf(amountText);
      if (amountIndex > commandIndex && input[amountIndex - 1] === "$") {
        fields.paymentAsset = "USD";
        fields.unsupportedAsset = "USD";
      }
    }
  }

  const recipients = extractRecipients(input);
  if (recipients.length > 1) {
    ambiguities.push("recipient is ambiguous");
  } else if (recipients.length === 1) {
    fields.recipient = recipients[0];
  }

  if (budgetAmounts.length > 1) {
    ambiguities.push("service budget is ambiguous");
  } else if (budgetAmounts.length === 1) {
    const serviceBudget = parseUsdAmount(budgetAmounts[0]);
    if (serviceBudget) fields.serviceBudget = serviceBudget;
    else ambiguities.push("service budget precision is unsupported");
  }

  if (explicitCap) {
    const perServiceCap = parseUsdAmount(explicitCap);
    if (perServiceCap) fields.perServiceCap = perServiceCap;
    else ambiguities.push("per-service cap precision is unsupported");
  } else if (
    fields.serviceBudget &&
    type === "pay_with_check" &&
    /\bcheck(?:ing)?\b/i.test(input)
  ) {
    fields.perServiceCap = fields.serviceBudget;
  }

  if (type) {
    fields.finalPaymentApprovalRequired = type !== "delegate";
  }
  const purpose = detectPurpose(input, type);
  if (purpose) fields.purpose = purpose;
  return { fields, ambiguities };
}

function buildMissingFields(
  fields: FinancialIntentFields,
): IntentMissingField[] {
  const missing: IntentMissingField[] = [];
  if (!fields.type) missing.push("task_type");
  if (fields.type === "pay" || fields.type === "pay_with_check") {
    const zeroPayment =
      fields.paymentAmount?.units === BigInt(0) ||
      isZeroAmountText(fields.paymentAmountText);
    if (zeroPayment) {
      missing.push("payment_amount");
    } else if (!fields.paymentAmount && !fields.paymentAmountText) {
      missing.push("payment_amount");
    } else if (!fields.paymentAmount && !fields.paymentAsset) {
      missing.push("payment_asset");
    }
    if (!fields.recipient) missing.push("recipient");
  }
  if (
    (fields.type === "pay_with_check" || fields.type === "delegate") &&
    !fields.serviceBudget
  ) {
    missing.push("service_budget");
  }
  return missing;
}

export function pendingFieldForIntent(
  pending: FinancialIntentFields | undefined,
): PendingField | null {
  if (!pending) return null;
  return pendingFieldFor(buildMissingFields(pending));
}

export function parseFinancialIntent(
  input: string,
  conversationContext: ConversationContext = {},
): FinancialIntentParseResult {
  const sourceText = typeof input === "string" ? input.trim() : "";
  const extracted = extractFields(sourceText);
  const pending = conversationContext.pendingIntent;
  const pendingField = pending
    ? (readPendingField(conversationContext.pendingField) ??
      pendingFieldFor(buildMissingFields(pending)))
    : null;
  const followup = pending
    ? extractFollowupFields(sourceText, pending, pendingField ?? undefined)
    : { fields: {}, ambiguities: [] as string[] };
  let mergedExtracted = mergeDefinedFields(extracted.fields, followup.fields);
  let ambiguities = [...extracted.ambiguities, ...followup.ambiguities];
  if (pendingField === "serviceBudget" && followup.fields.serviceBudget) {
    const { paymentAmount, paymentAmountText, paymentAsset, unsupportedAsset, ...rest } =
      mergedExtracted;
    void paymentAmount;
    void paymentAmountText;
    void paymentAsset;
    void unsupportedAsset;
    mergedExtracted = rest;
    ambiguities = ambiguities.filter(
      (ambiguity) =>
        ambiguity !== "payment amount is ambiguous" &&
        ambiguity !== "payment asset is ambiguous" &&
        ambiguity !== "payment amount precision is unsupported",
    );
  }
  const bareAmountWithoutAsset =
    pending?.paymentAmount !== undefined &&
    mergedExtracted.paymentAmount === undefined &&
    mergedExtracted.paymentAmountText !== undefined &&
    mergedExtracted.paymentAsset === undefined &&
    mergedExtracted.unsupportedAsset === undefined &&
    PAYMENT_VERB_PATTERN.test(sourceText);
  if (bareAmountWithoutAsset) {
    if (!ambiguities.includes("payment asset is ambiguous")) {
      ambiguities.push("payment asset is ambiguous");
    }
    if (pending?.type !== undefined) mergedExtracted.type = pending.type;
  }
  if (
    pending?.type === "pay_with_check" &&
    mergedExtracted.type === "pay" &&
    !declinesWalletCheck(sourceText)
  ) {
    mergedExtracted.type = "pay_with_check";
  }
   let fields = mergeDefinedFields(pending, mergedExtracted);

  if (fields.paymentAsset === "USDC" && fields.unsupportedAsset) {
    fields = { ...fields, unsupportedAsset: undefined };
  }
  if (
    !fields.paymentAmount &&
    fields.paymentAmountText &&
    fields.paymentAsset === "USDC"
  ) {
    const parsed = parseUsdcAmount(fields.paymentAmountText);
    if (parsed) fields = { ...fields, paymentAmount: parsed };
    else ambiguities.push("payment amount precision is unsupported");
  }
  const zeroPayment =
    fields.paymentAmount?.units === BigInt(0) ||
    isZeroAmountText(fields.paymentAmountText);
  if (zeroPayment) {
    fields = { ...fields, paymentAmount: undefined };
    if (!ambiguities.includes(ZERO_PAYMENT_AMBIGUITY)) {
      ambiguities.push(ZERO_PAYMENT_AMBIGUITY);
    }
  }
  const unsupportedAsset = fields.unsupportedAsset;
  const missing = buildMissingFields(fields);
  const status = unsupportedAsset
    ? "unsupported"
    : ambiguities.includes(ZERO_PAYMENT_AMBIGUITY)
      ? "needs_clarification"
      : ambiguities.length > 0
        ? "ambiguous"
        : missing.length > 0
          ? "needs_clarification"
          : "ready";
  const confidence =
    status === "ready"
      ? conversationContext.pendingIntent
        ? "medium"
        : "high"
      : conversationContext.pendingIntent
        ? "medium"
        : "low";
  const clarification = clarificationFor(
    fields.type,
    fields,
    missing,
    ambiguities,
    unsupportedAsset,
  );
  return Object.freeze({
    status,
    ...(fields.type ? { intentType: fields.type } : {}),
    fields: Object.freeze(fields),
    missing: Object.freeze(missing),
    ambiguities: Object.freeze(ambiguities),
    confidence,
    ...(clarification ? { clarification } : {}),
    sourceText,
  });
}
export function buildAuthoritativeParseResult(
  fields: FinancialIntentFields,
  options: { sourceText?: string; hadPending?: boolean } = {},
): FinancialIntentParseResult {
  const missing = buildMissingFields(fields);
  const ambiguities: string[] = [];
  const unsupportedAsset = fields.unsupportedAsset;
  const status = unsupportedAsset
    ? "unsupported"
    : missing.length > 0
      ? "needs_clarification"
      : "ready";
  const confidence =
    status === "ready"
      ? options.hadPending
        ? "medium"
        : "high"
      : options.hadPending
        ? "medium"
        : "low";
  const clarification = clarificationFor(
    fields.type,
    fields,
    missing,
    ambiguities,
    unsupportedAsset,
  );
  return Object.freeze({
    status,
    ...(fields.type ? { intentType: fields.type } : {}),
    fields: Object.freeze({ ...fields }),
    missing: Object.freeze(missing),
    ambiguities: Object.freeze(ambiguities),
    confidence,
    ...(clarification ? { clarification } : {}),
    sourceText: options.sourceText ?? "",
  });
}
