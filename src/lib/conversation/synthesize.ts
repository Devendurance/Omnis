import { formatMoney, serializeMoney, type Money, type SerializedMoney } from "../domain/money";

export type SynthesisPurchaseSummary = Readonly<{
  paidAmount?: Money;
  paymentAmount: Money;
  status: string;
  serviceResult?: Readonly<{
    observations?: Readonly<Record<string, unknown>>;
    heuristicFlags?: ReadonlyArray<unknown>;
  }>;
}>;

export type ServiceSynthesisFacts = Readonly<{
  spent: Money;
  serviceBudget?: Money;
  paymentText?: string;
  approvalStillRequired: boolean;
  observations: Readonly<Record<string, unknown>>;
  heuristicFlags: ReadonlyArray<Readonly<{ code: string; severity: string; interpretation?: string }>>;
  purchaseStatus: string;
}>;

function observationText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function buildServiceSynthesisFacts(
  purchase: SynthesisPurchaseSummary,
  serviceBudget?: Money,
  paymentText?: string,
  approvalStillRequired = true,
): ServiceSynthesisFacts {
  const result = purchase.serviceResult;
  const observations =
    result && typeof result.observations === "object" && result.observations !== null
      ? result.observations
      : {};
  const rawFlags = result && Array.isArray(result.heuristicFlags) ? result.heuristicFlags : [];
  const flags = rawFlags.flatMap((flag: unknown) => {
    if (typeof flag !== "object" || flag === null) return [];
    if (!("code" in flag)) return [];
    const code = flag.code;
    if (typeof code !== "string" || code.trim().length === 0) return [];
    const severity = "severity" in flag && typeof flag.severity === "string" ? flag.severity : "info";
    const interpretation =
      "interpretation" in flag && typeof flag.interpretation === "string" ? flag.interpretation : undefined;
    return [{ code, severity, ...(interpretation ? { interpretation } : {}) }];
  });
  return Object.freeze({
    spent: purchase.paidAmount ?? purchase.paymentAmount,
    ...(serviceBudget ? { serviceBudget } : {}),
    ...(paymentText ? { paymentText } : {}),
    approvalStillRequired,
    observations: Object.freeze({ ...observations }),
    heuristicFlags: Object.freeze(flags.map((flag) => Object.freeze(flag))),
    purchaseStatus: purchase.status,
  });
}

export function renderServiceSynthesisFallback(facts: ServiceSynthesisFacts): string {
  const parts: string[] = [];
  const addressValidity = observationText(facts.observations.addressValidity);
  const accountType = observationText(facts.observations.accountType);
  const txObserved = facts.observations.transactionActivityObserved;
  if (addressValidity === "valid" && accountType) {
    parts.push("It is a valid " + accountType.toUpperCase() + ".");
  } else if (addressValidity) {
    parts.push("Address validity: " + addressValidity + ".");
  }
  if (txObserved === false || facts.observations.transactionCount === "0") {
    parts.push(
      "No transaction history was observed. That is a heuristic signal, not proof that the wallet is unsafe.",
    );
  } else if (txObserved === true) {
    parts.push("Transaction activity was observed.");
  }
  for (const flag of facts.heuristicFlags) {
    if (flag.interpretation) {
      parts.push("Heuristic " + flag.code + ": " + flag.interpretation);
    } else {
      parts.push("Heuristic signal " + flag.code + " was observed.");
    }
  }
  if (
    facts.heuristicFlags.length > 0 &&
    !parts.some((part) => /heuristic/i.test(part))
  ) {
    parts.push("These observations include heuristic signals, not proof of safety or risk.");
  }
  const spentText = formatMoney(facts.spent) + " " + facts.spent.asset;
  const budgetText = facts.serviceBudget
    ? " of your " +
      formatMoney(facts.serviceBudget) +
      " " +
      facts.serviceBudget.asset +
      " service budget"
    : "";
  parts.push("I have spent " + spentText + budgetText + ".");
  if (facts.paymentText) {
    parts.push(
      facts.approvalStillRequired
        ? "The " + facts.paymentText + " payment is ready, but I still need your approval."
        : "The " + facts.paymentText + " payment is ready.",
    );
  }
  return "I checked the wallet using the service. " + parts.join(" ");
}

export function validateSynthesisNarrative(
  narrative: string,
  facts: ServiceSynthesisFacts,
): boolean {
  const spentText = formatMoney(facts.spent);
  if (!narrative.includes(spentText)) return false;
  if (facts.heuristicFlags.length > 0 && !/heuristic/i.test(narrative)) return false;
  const lower = narrative.toLowerCase();
  const textOf = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.toLowerCase() : undefined;
  const validity = textOf(facts.observations.addressValidity);
  if (validity !== undefined) {
    if (/valid (eoa|address|wallet)/.test(lower) && validity !== "valid") return false;
    if (/\binvalid\b/.test(lower) && validity === "valid") return false;
  }
  const accountType = textOf(facts.observations.accountType);
  if (accountType !== undefined) {
    if (/\beoa\b/.test(lower) && accountType !== "eoa") return false;
    if (/contract (address|code|status|wallet)/.test(lower) && accountType !== "contract") {
      return false;
    }
  }
  const activityObserved = facts.observations.transactionActivityObserved;
  const countText = textOf(facts.observations.transactionCount);
  const noActivityObserved = activityObserved === false || countText === "0";
  if (typeof activityObserved === "boolean" || countText !== undefined) {
    if (/no .*transaction history|no .*activity observed/i.test(lower) && !noActivityObserved) {
      return false;
    }
    if (/transaction activity was observed|activity was observed/i.test(lower) && noActivityObserved) {
      return false;
    }
  }
  const knownCodes = new Set(facts.heuristicFlags.map((flag) => flag.code));
  for (const code of ["no_observed_transaction_history", "contract_address"]) {
    if (lower.includes(code) && !knownCodes.has(code)) return false;
  }
  if (facts.observations.transactionActivityObserved === false) {
    if (
      /proof that the wallet is (safe|unsafe)/i.test(narrative) &&
      !/not proof/i.test(narrative)
    ) {
      return false;
    }
  }
  if (/0x[0-9a-fA-F]{6,}/.test(narrative) && !/moved|success|settled|confirmed/i.test(narrative)) {
    return true;
  }
  if (/(moved|settled|confirmed|successfully paid)/i.test(narrative)) return false;
  return true;
}

export type SerializedServiceSynthesisFacts = Readonly<{
  spent: SerializedMoney;
  serviceBudget?: SerializedMoney;
  paymentText?: string;
  approvalStillRequired: boolean;
  observations: Readonly<Record<string, unknown>>;
  heuristicFlags: ReadonlyArray<Readonly<{ code: string; severity: string; interpretation?: string }>>;
  purchaseStatus: string;
}>;

export function serializeServiceSynthesisFacts(
  facts: ServiceSynthesisFacts,
): SerializedServiceSynthesisFacts {
  return Object.freeze({
    spent: serializeMoney(facts.spent),
    ...(facts.serviceBudget ? { serviceBudget: serializeMoney(facts.serviceBudget) } : {}),
    ...(facts.paymentText ? { paymentText: facts.paymentText } : {}),
    approvalStillRequired: facts.approvalStillRequired,
    observations: facts.observations,
    heuristicFlags: facts.heuristicFlags,
    purchaseStatus: facts.purchaseStatus,
  });
}

export function isSynthesisWriteStale(
  current: Readonly<{ approval?: unknown; settlement?: unknown }>,
  snapshot: Readonly<{ approval?: unknown; settlement?: unknown }>,
): boolean {
  return current.approval !== snapshot.approval || current.settlement !== snapshot.settlement;
}
