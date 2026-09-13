import type {
  FinancialTask,
  SerializedMoney,
  ServiceDescriptor,
  ServicePurchase,
  TaskPolicy,
} from "../domain";
import { serializeMoney } from "../domain/money";
import {
  discoverServices,
  type ServiceDiscoveryCandidate,
  type ServiceRegistry,
} from "../services";

// P9B bounded candidate DTO. The model may only see candidates produced by
// the trusted service registry, plus deterministic eligibility facts computed
// here. Payer keys, secrets, auth tokens, arbitrary URLs, client-supplied
// descriptors, and unrestricted internal metadata never leave this module:
// endpoint, input/output schemas, and purchase records are stripped.
export type BoundedServiceCandidate = Readonly<{
  serviceId: string;
  name: string;
  capability: string;
  category: string;
  description: string;
  price: SerializedMoney;
  paymentAsset: string;
  network: string;
  paymentProtocol: "x402";
  environment: ServiceDescriptor["environment"];
  status: ServiceDescriptor["status"];
  catalogOnly: boolean;
  // Deterministic eligibility facts. The model receives them; it never
  // calculates authoritative budget or eligibility.
  capabilityMatches: boolean;
  categoryAllowed: boolean;
  networkAllowed: boolean;
  serviceAvailable: boolean;
  policyCompatible: boolean;
  budgetFits: boolean;
  executable: boolean;
  projectedRemainingBudget: SerializedMoney | null;
}>;

export type RecommendationCandidateSet = Readonly<{
  requiredCapability: string;
  registryVersion: string;
  candidates: readonly BoundedServiceCandidate[];
}>;

export type BuildCandidateSetInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  registry: ServiceRegistry;
  requiredCapability: string;
  existingPurchases?: readonly ServicePurchase[];
  hasPendingClarification?: boolean;
}>;

function effectiveServiceNetworks(policy: TaskPolicy): readonly string[] {
  // Same fallback as the P2 policy engine: the newer service allowlist wins,
  // otherwise the legacy settlement allowlist applies.
  return policy.allowedServiceNetworks ?? policy.allowedNetworks;
}

function categoryAllowed(
  policy: TaskPolicy,
  descriptor: ServiceDescriptor,
): boolean {
  return policy.allowedServiceCategories.includes(
    descriptor.category.trim().toLowerCase(),
  );
}

function networkAllowed(
  policy: TaskPolicy,
  descriptor: ServiceDescriptor,
): boolean {
  const allowed = effectiveServiceNetworks(policy);
  if (allowed.length === 0) return true;
  return allowed.includes(descriptor.network.trim().toLowerCase());
}

function toBoundedCandidate(
  candidate: ServiceDiscoveryCandidate,
  hasPendingClarification: boolean,
  policy: TaskPolicy,
): BoundedServiceCandidate {
  const descriptor = candidate.descriptor;
  const capabilityMatches = candidate.capabilityMatch !== "none";
  const serviceAvailable = descriptor.status === "available";
  const budgetFits = candidate.budgetDecision === "ALLOW";
  const category = categoryAllowed(policy, descriptor);
  const network = networkAllowed(policy, descriptor);
  const policyCompatible =
    candidate.compatibility === "compatible" && category && network;
  const executable =
    capabilityMatches &&
    serviceAvailable &&
    !descriptor.catalogOnly &&
    descriptor.environment !== "development" &&
    policyCompatible &&
    budgetFits &&
    !hasPendingClarification;
  return Object.freeze({
    serviceId: descriptor.id,
    name: descriptor.name,
    capability: descriptor.capability,
    category: descriptor.category,
    description: descriptor.description,
    price: serializeMoney(descriptor.price),
    paymentAsset: descriptor.paymentAmount?.asset ?? descriptor.price.asset,
    network: descriptor.network,
    paymentProtocol: descriptor.paymentProtocol,
    environment: descriptor.environment,
    status: descriptor.status,
    catalogOnly: descriptor.catalogOnly,
    capabilityMatches,
    categoryAllowed: category,
    networkAllowed: network,
    serviceAvailable,
    policyCompatible,
    budgetFits,
    executable,
    projectedRemainingBudget: candidate.remainingBudget
      ? serializeMoney(candidate.remainingBudget)
      : null,
  });
}

// Deterministic eligibility first: every fact the model sees is computed from
// the trusted registry, the P2 verdicts on each candidate, and the task
// state. The projected remaining budget comes from deterministic code.
export function buildRecommendationCandidateSet(
  input: BuildCandidateSetInput,
): RecommendationCandidateSet {
  const requiredCapability = input.requiredCapability.trim().toLowerCase();
  if (!requiredCapability) {
    return Object.freeze({
      requiredCapability: "",
      registryVersion: input.registry.version,
      candidates: Object.freeze([]),
    });
  }
  const discovery = discoverServices({
    task: input.task,
    policy: input.policy,
    registry: input.registry,
    requiredCapability: input.requiredCapability,
    ...(input.existingPurchases
      ? { existingPurchases: input.existingPurchases }
      : {}),
  });
  const pending = input.hasPendingClarification === true;
  // Only capability-compatible trusted candidates reach the model. Entries
  // with no capability match (hidden or irrelevant capabilities) are never
  // serialized into the payload.
  return Object.freeze({
    requiredCapability: discovery.requiredCapability,
    registryVersion: input.registry.version,
    candidates: Object.freeze(
      discovery.candidates
        .filter((candidate) => candidate.capabilityMatch !== "none")
        .map((candidate) => toBoundedCandidate(candidate, pending, input.policy)),
    ),
  });
}

