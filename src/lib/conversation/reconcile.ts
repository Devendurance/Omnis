import { parseMoney } from "../domain/money";
import type { ValidatedSemanticFields } from "../intent/semantic";
import type { FinancialIntentParseResult } from "../intent/types";
import type { ConversationalProposal } from "./schema";

export type ReconciliationOutcome =
  | { readonly outcome: "agree" }
  | { readonly outcome: "no_hints" }
  | { readonly outcome: "disagree"; readonly clarification: string };

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAsset(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeAmountText(value: string): string | undefined {
  const cleaned = value.replace(/,/g, "").trim();
  const match = cleaned.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return match ? match[1] : undefined;
}

function amountsEqual(hint: string, asset: string, units: bigint): boolean {
  const numeric = normalizeAmountText(hint);
  if (!numeric) return false;
  try {
    return parseMoney(numeric, asset).units === units;
  } catch {
    return false;
  }
}

function hintMentionsCheck(text: string): boolean {
  return /\b(check|verify|vet|screen|look into|research|due diligence)\b/i.test(text);
}

export function reconcileProposalWithDeterministicParse(
  proposal: ConversationalProposal,
  deterministic: FinancialIntentParseResult,
  sourceText: string,
): ReconciliationOutcome {
  const hints = proposal.extractedHints;
  const hasHints =
    hints.recipient !== undefined ||
    hints.paymentAmount !== undefined ||
    hints.asset !== undefined ||
    hints.serviceBudget !== undefined;
  if (!hasHints) return { outcome: "no_hints" };

  const fields = deterministic.fields;

  if (hints.recipient !== undefined) {
    if (!fields.recipient) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a recipient in your message, but I could not verify the wallet address safely. Which exact wallet address should I use?",
      };
    }
    if (normalizeAddress(hints.recipient) !== normalizeAddress(fields.recipient)) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a different recipient than I could verify safely. Which exact wallet address should I use?",
      };
    }
  }

  if (hints.paymentAmount !== undefined) {
    if (!fields.paymentAmount || !fields.paymentAsset) {
      return {
        outcome: "disagree",
        clarification:
          "I understood the payment as " +
          hints.paymentAmount +
          ", but I could not verify the amount safely. How much should I send?",
      };
    }
    const hintAsset = hints.asset ? normalizeAsset(hints.asset) : fields.paymentAsset;
    if (hintAsset !== fields.paymentAsset) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a different asset than I could verify safely. Which asset should I send?",
      };
    }
    if (!amountsEqual(hints.paymentAmount, fields.paymentAsset, fields.paymentAmount.units)) {
      return {
        outcome: "disagree",
        clarification:
          "I understood the payment as " +
          hints.paymentAmount +
          ", but I could not verify the amount safely. How much should I send?",
      };
    }
  } else if (hints.asset !== undefined && fields.paymentAsset) {
    if (normalizeAsset(hints.asset) !== fields.paymentAsset) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a different asset than I could verify safely. Which asset should I send?",
      };
    }
  }

  if (hints.serviceBudget !== undefined) {
    if (!fields.serviceBudget) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a service budget of " +
          hints.serviceBudget +
          ", but I could not verify it safely. What is the most I may spend checking?",
      };
    }
    if (
      !amountsEqual(hints.serviceBudget, fields.serviceBudget.asset, fields.serviceBudget.units)
    ) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a different checking budget than I could verify safely. What is the most I may spend checking?",
      };
    }
  }

  if (
    proposal.intent === "pay_with_check" &&
    deterministic.intentType !== undefined &&
    deterministic.intentType !== "pay_with_check" &&
    hintMentionsCheck(sourceText)
  ) {
    return {
      outcome: "disagree",
      clarification:
        "I heard you want a wallet check before paying, but I could not verify that plan safely. Should I check the wallet first?",
    };
  }

  return { outcome: "agree" };
}
export function reconcileSemanticWithDeterministicParse(
  semantic: ValidatedSemanticFields,
  deterministic: FinancialIntentParseResult,
): ReconciliationOutcome {
  const fields = deterministic.fields;
  if (semantic.recipient !== undefined && fields.recipient !== undefined) {
    if (semantic.recipient.toLowerCase() !== fields.recipient.toLowerCase()) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a different recipient than I could verify safely. Which exact wallet address should I use?",
      };
    }
  }
  if (
    semantic.paymentAmountText !== undefined &&
    fields.paymentAmount !== undefined
  ) {
    let matches = false;
    try {
      matches =
        parseMoney(semantic.paymentAmountText, "USDC").units === fields.paymentAmount.units;
    } catch {
      matches = false;
    }
    if (!matches) {
      return {
        outcome: "disagree",
        clarification:
          "I understood the payment as " +
          semantic.paymentAmountText +
          ", but I could not verify the amount safely. How much should I send?",
      };
    }
  }
  if (
    semantic.serviceBudgetText !== undefined &&
    fields.serviceBudget !== undefined
  ) {
    let matches = false;
    try {
      matches =
        parseMoney(semantic.serviceBudgetText, "USD").units === fields.serviceBudget.units;
    } catch {
      matches = false;
    }
    if (!matches) {
      return {
        outcome: "disagree",
        clarification:
          "I understood a different checking budget than I could verify safely. What is the most I may spend checking?",
      };
    }
  }
  return { outcome: "agree" };
}

export type InterpretationGate = "plan" | "clarify" | "reject_authority_bypass";

export type InterpretationGateInput = Readonly<{
  locked?: boolean;
  fallback: boolean;
  reconcileOutcome?: string;
}>;

export function resolveInterpretationGate(input: InterpretationGateInput): InterpretationGate {
  if (input.locked) return "clarify";
  // P9A.4: security rejections are typed distinctly from ordinary
  // clarification so downstream code can short-circuit before any
  // financial parser or orchestrator runs on the rejected turn.
  if (
    input.reconcileOutcome === "authority_bypass" ||
    input.reconcileOutcome === "narrative_rejected"
  ) {
    return "reject_authority_bypass";
  }
  if (
    input.reconcileOutcome === "disagree" ||
    input.reconcileOutcome === "schema_rejected" ||
    input.reconcileOutcome === "promotion_rejected"
  ) {
    return "clarify";
  }
  return "plan";
}
