import {
  compareMoney,
  type FinancialTask,
  type Money,
  type PolicyReasonCode,
  type ServiceDescriptor,
  type ServicePurchase,
  type TaskPolicy,
} from "../domain";
import {
  matchServiceCapability,
  validateServiceCapability,
  type CapabilityMatch,
} from "./capabilities";
import type { ServiceRegistry } from "./registry";
import {
  evaluateServiceSpend,
  type ServiceSpendEvaluation,
} from "../domain/services/budget";

export const SERVICE_DISCOVERY_REASON_CODES = {
  CAPABILITY_MATCH_REQUIRED: "CAPABILITY_MATCH_REQUIRED",
  CAPABILITY_MATCH_SECONDARY: "CAPABILITY_MATCH_SECONDARY",
  CAPABILITY_MISMATCH: "CAPABILITY_MISMATCH",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  DEVELOPMENT_CATALOG_ONLY: "DEVELOPMENT_CATALOG_ONLY",
} as const;

export type ServiceDiscoveryReasonCode =
  | PolicyReasonCode
  | (typeof SERVICE_DISCOVERY_REASON_CODES)[keyof typeof SERVICE_DISCOVERY_REASON_CODES];

export type ServiceDiscoveryCandidate = Readonly<{
  descriptor: ServiceDescriptor;
  compatibility: "compatible" | "incompatible";
  capabilityMatch: CapabilityMatch;
  budgetDecision: "ALLOW" | "DENY" | "NOT_EVALUATED";
  budgetEvaluation?: ServiceSpendEvaluation;
  reasonCodes: readonly ServiceDiscoveryReasonCode[];
  price: Money;
  remainingBudget?: Money;
  selectable: boolean;
  order: number;
  rank?: number;
}>;

export type DiscoverServicesInput = Readonly<{
  task: FinancialTask;
  requiredCapability: string;
  registry: ServiceRegistry;
  policy: TaskPolicy;
  existingPurchases?: readonly ServicePurchase[];
}>;

export type ServiceDiscoveryResult = Readonly<{
  requiredCapability: string;
  candidates: readonly ServiceDiscoveryCandidate[];
  selectableCandidates: readonly ServiceDiscoveryCandidate[];
  rejectedCandidates: readonly ServiceDiscoveryCandidate[];
}>;

function compareText(left: string, right: string): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePrices(left: Money, right: Money): -1 | 0 | 1 {
  const assetOrder = compareText(left.asset, right.asset);
  if (assetOrder !== 0) return assetOrder;
  return compareMoney(left, right);
}

function capabilityRank(match: CapabilityMatch): number {
  if (match === "required") return 0;
  if (match === "secondary") return 1;
  return 2;
}

function candidateOrder(
  left: ServiceDiscoveryCandidate,
  right: ServiceDiscoveryCandidate,
): -1 | 0 | 1 {
  if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
  const capabilityOrder = capabilityRank(left.capabilityMatch) - capabilityRank(right.capabilityMatch);
  if (capabilityOrder < 0) return -1;
  if (capabilityOrder > 0) return 1;
  if (left.budgetDecision !== right.budgetDecision) {
    return left.budgetDecision === "ALLOW" ? -1 : 1;
  }
  const priceOrder = comparePrices(left.price, right.price);
  if (priceOrder !== 0) return priceOrder;
  return compareText(left.descriptor.id, right.descriptor.id);
}

function reasonForCapability(
  requiredCapability: string,
  match: CapabilityMatch,
): ServiceDiscoveryReasonCode {
  if (match === "required") {
    return SERVICE_DISCOVERY_REASON_CODES.CAPABILITY_MATCH_REQUIRED;
  }
  if (match === "secondary") {
    return SERVICE_DISCOVERY_REASON_CODES.CAPABILITY_MATCH_SECONDARY;
  }
  return validateServiceCapability(requiredCapability)
    ? SERVICE_DISCOVERY_REASON_CODES.CAPABILITY_MISMATCH
    : SERVICE_DISCOVERY_REASON_CODES.UNSUPPORTED_CAPABILITY;
}

function evaluateCandidate(
  input: DiscoverServicesInput,
  descriptor: ServiceDescriptor,
): ServiceDiscoveryCandidate {
  const capabilityMatch = matchServiceCapability(
    input.requiredCapability,
    descriptor.capability,
  );
  const reasonCodes: ServiceDiscoveryReasonCode[] = [
    reasonForCapability(input.requiredCapability, capabilityMatch),
  ];
  if (descriptor.catalogOnly || descriptor.environment === "development") {
    reasonCodes.push(SERVICE_DISCOVERY_REASON_CODES.DEVELOPMENT_CATALOG_ONLY);
  }

  if (capabilityMatch === "none") {
    return Object.freeze({
      descriptor,
      compatibility: "incompatible",
      capabilityMatch,
      budgetDecision: "NOT_EVALUATED",
      reasonCodes: Object.freeze(reasonCodes),
      price: descriptor.price,
      selectable: false,
      order: 0,
    });
  }

  const budgetEvaluation = evaluateServiceSpend({
    task: input.task,
    policy: input.policy,
    service: descriptor,
    quotedPrice: descriptor.price,
    existingPurchases: input.existingPurchases ?? [],
  });
  reasonCodes.push(budgetEvaluation.reasonCode);
  return Object.freeze({
    descriptor,
    compatibility: "compatible",
    capabilityMatch,
    budgetDecision: budgetEvaluation.decision,
    budgetEvaluation,
    reasonCodes: Object.freeze(reasonCodes),
    price: descriptor.price,
    ...(budgetEvaluation.decision === "ALLOW"
      ? { remainingBudget: budgetEvaluation.remainingAfter }
      : {}),
    selectable: budgetEvaluation.decision === "ALLOW",
    order: 0,
  });
}

export function discoverServices(
  input: DiscoverServicesInput,
): ServiceDiscoveryResult {
  const requiredCapability = input.requiredCapability.trim().toLowerCase();
  if (!requiredCapability) {
    return Object.freeze({
      requiredCapability,
      candidates: Object.freeze([]),
      selectableCandidates: Object.freeze([]),
      rejectedCandidates: Object.freeze([]),
    });
  }

  const evaluated = input.registry
    .listServices({ order: "price" })
    .map((descriptor) => evaluateCandidate(input, descriptor));
  evaluated.sort(candidateOrder);

  const selectableCandidates: ServiceDiscoveryCandidate[] = [];
  const candidates = evaluated.map((candidate, index) => {
    const rank = candidate.selectable
      ? selectableCandidates.push(candidate)
      : undefined;
    return Object.freeze({
      ...candidate,
      order: index + 1,
      ...(rank === undefined ? {} : { rank }),
    });
  });
  const selectable = candidates.filter((candidate) => candidate.selectable);
  const rejected = candidates.filter((candidate) => !candidate.selectable);

  return Object.freeze({
    requiredCapability,
    candidates: Object.freeze(candidates),
    selectableCandidates: Object.freeze(selectable),
    rejectedCandidates: Object.freeze(rejected),
  });
}
