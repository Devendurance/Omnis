import type { FinancialTask, Money, TaskPolicy } from "../domain";
import type {
  BoundedServiceCandidate,
  RecommendationCandidateSet,
} from "./dto";
import type { ServiceRecommendation } from "./schema";

// Stored recommendation. Historical metadata only: execution never reads the
// recommended id without re-verifying against the current candidate set.
// policyFingerprint binds the full deterministic policy context and
// candidateFingerprint binds the recommended candidate facts, so any policy,
// price, availability, or eligibility change invalidates the entry.
export type StoredServiceRecommendation = Readonly<{
  taskId: string;
  taskUpdatedAt: string;
  requiredCapability: string;
  recipient?: string;
  serviceBudgetLabel: string;
  policyTaskId: string;
  policyFingerprint: string;
  registryVersion: string;
  recommendedServiceId: string | null;
  candidateFingerprint: string | null;
  rationale: string;
  comparisons: readonly Readonly<{ serviceId: string; assessment: string }>[];
  provider: string;
  model: string;
  verified: boolean;
  fallback: boolean;
  createdAt: string;
}>;

export type RecommendationVerification =
  | Readonly<{ ok: true; candidate: BoundedServiceCandidate }>
  | Readonly<{ ok: false; reason: string }>;

function findCandidate(
  candidates: readonly BoundedServiceCandidate[],
  serviceId: string,
): BoundedServiceCandidate | undefined {
  return candidates.find((candidate) => candidate.serviceId === serviceId);
}

// Deterministic verifier. Every check re-derives from the supplied candidate
// set, which itself comes from the trusted registry and P2 verdicts. Unknown
// or stale ids, catalog-only entries, over-budget picks, and wrong
// network/capability candidates are rejected here, never executed.
export function verifyServiceRecommendation(
  recommendation: ServiceRecommendation,
  candidateSet: RecommendationCandidateSet,
): RecommendationVerification {
  const id = recommendation.recommendedServiceId;
  if (id === null) {
    return { ok: false, reason: "model recommended no executable candidate" };
  }
  const candidate = findCandidate(candidateSet.candidates, id);
  if (!candidate) {
    return { ok: false, reason: "recommended service is not in the candidate set" };
  }
  for (const comparison of recommendation.comparisons) {
    if (!findCandidate(candidateSet.candidates, comparison.serviceId)) {
      return { ok: false, reason: "comparison references an unknown service" };
    }
  }
  if (!candidate.capabilityMatches) {
    return { ok: false, reason: "recommended service does not match the required capability" };
  }
  if (!candidate.serviceAvailable) {
    return { ok: false, reason: "recommended service is not available" };
  }
  if (candidate.catalogOnly) {
    return { ok: false, reason: "catalog-only services are never executable" };
  }
  if (!candidate.executable) {
    return { ok: false, reason: "recommended service is not executable" };
  }
  if (!candidate.policyCompatible) {
    return { ok: false, reason: "recommended service is not policy compatible" };
  }
  if (!candidate.budgetFits) {
    return { ok: false, reason: "recommended service exceeds the budget" };
  }
  return { ok: true, candidate };
}

export type RecommendationFreshnessInput = Readonly<{
  stored: StoredServiceRecommendation;
  task: FinancialTask;
  policy: TaskPolicy;
  requiredCapability: string;
  registryVersion: string;
  candidateSet: RecommendationCandidateSet;
}>;

export function recommendationServiceBudgetLabel(task: FinancialTask): string {
  return task.serviceBudget
    ? `${task.serviceBudget.units.toString()}:${task.serviceBudget.asset}`
    : "none";
}

function moneyLabel(value: Money | undefined): string {
  if (!value) return "none";
  return `${value.units.toString()}:${value.asset}:${value.decimals}`;
}

// Canonical policy fingerprint. Every deterministic input the recommendation
// depends on is bound: task binding, budgets, allowlists, and approval.
export function fingerprintTaskPolicy(policy: TaskPolicy): string {
  return JSON.stringify({
    taskId: policy.taskId,
    maxServiceSpend: moneyLabel(policy.maxServiceSpend),
    maxPerService: moneyLabel(policy.maxPerService),
    allowedServiceCategories: [...policy.allowedServiceCategories].sort(),
    allowedServiceNetworks: [...(policy.allowedServiceNetworks ?? [])].sort(),
    allowedNetworks: [...policy.allowedNetworks].sort(),
    allowedAssets: [...policy.allowedAssets].sort(),
    finalPaymentApprovalRequired: policy.finalPaymentApprovalRequired,
  });
}

// Canonical candidate fingerprint. Binds every deterministic fact the model
// and the card use, including the projected remaining budget, so a ledger
// change that moves budget-after with all flags unchanged still invalidates.
// The DTO is constructed with stable key order and contains only JSON-safe
// values, so a direct serialization is the complete fingerprint.
export function fingerprintCandidate(candidate: BoundedServiceCandidate): string {
  return JSON.stringify(candidate);
}

// Invalidation. A recommendation becomes stale when any of these change: task
// id/version, required capability, recipient where service input depends on
// it, service budget, the full policy context, registry version, or the
// recommended candidate facts (price, availability, eligibility). Stale
// entries are never reused for execution. Entries stored before fingerprints
// existed are treated as stale.
export function isRecommendationStale(
  input: RecommendationFreshnessInput,
): boolean {
  const stored = input.stored;
  if (
    JSON.stringify(storedRecommendationContext(stored)) !==
    JSON.stringify(
      liveRecommendationContext({
        task: input.task,
        policy: input.policy,
        requiredCapability: input.requiredCapability,
        registryVersion: input.registryVersion,
      }),
    )
  ) {
    return true;
  }
  if (stored.registryVersion !== input.candidateSet.registryVersion) return true;
  if (stored.recommendedServiceId === null) return stored.candidateFingerprint !== null;
  const current = findCandidate(
    input.candidateSet.candidates,
    stored.recommendedServiceId,
  );
  if (!current) return true;
  if (!current.capabilityMatches) return true;
  return stored.candidateFingerprint !== fingerprintCandidate(current);
}

// Single invalidation identity (P9B.2). Every freshness path (the composer
// refresh key, isStoredRecommendationCurrent, and the context part of
// isRecommendationStale) reduces to one canonical context record, so a
// future freshness field cannot update one path but not the others.
// Candidate-level facts (price, availability, eligibility) stay in
// isRecommendationStale, which remains the authority for historical render.
export type RecommendationContextInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  requiredCapability: string;
  registryVersion: string;
}>;

export type RecommendationContextRecord = Readonly<{
  taskId: string;
  taskUpdatedAt: string;
  requiredCapability: string;
  recipient: string;
  serviceBudget: string;
  policyTaskId: string;
  policy: string;
  registryVersion: string;
}>;

export function liveRecommendationContext(
  input: RecommendationContextInput,
): RecommendationContextRecord {
  return Object.freeze({
    taskId: input.task.id,
    taskUpdatedAt: input.task.updatedAt,
    requiredCapability: input.requiredCapability,
    recipient: input.task.recipient ?? "",
    serviceBudget: recommendationServiceBudgetLabel(input.task),
    policyTaskId: input.policy.taskId,
    policy: fingerprintTaskPolicy(input.policy),
    registryVersion: input.registryVersion,
  });
}

export function storedRecommendationContext(
  stored: StoredServiceRecommendation,
): RecommendationContextRecord {
  return Object.freeze({
    taskId: stored.taskId,
    taskUpdatedAt: stored.taskUpdatedAt,
    requiredCapability: stored.requiredCapability,
    recipient: stored.recipient ?? "",
    serviceBudget: stored.serviceBudgetLabel,
    policyTaskId: stored.policyTaskId,
    policy: stored.policyFingerprint,
    registryVersion: stored.registryVersion,
  });
}

export function fingerprintRecommendationContext(
  input: RecommendationContextInput,
): string {
  return JSON.stringify(liveRecommendationContext(input));
}

// Light key check for render and refresh paths: stored entry is current
// exactly when its canonical context matches the live one.
export function isStoredRecommendationCurrent(
  stored: StoredServiceRecommendation,
  task: FinancialTask,
  policy: TaskPolicy,
  registryVersion: string,
  requiredCapability: string,
): boolean {
  return (
    JSON.stringify(storedRecommendationContext(stored)) ===
    fingerprintRecommendationContext({
      task,
      policy,
      requiredCapability,
      registryVersion,
    })
  );
}

export type RecommendationRefreshDecision = Readonly<{
  fetch: boolean;
  key: string;
}>;

// Exact fetch-decision predicate used by the composer effect (P9B.2): same
// key as last run suppresses; a current stored entry suppresses and adopts
// the key; otherwise the composer must fetch exactly once for this context.
export function decideRecommendationRefresh(input: {
  stored: StoredServiceRecommendation | undefined;
  task: FinancialTask;
  policy: TaskPolicy;
  requiredCapability: string;
  registryVersion: string;
  currentKey: string | null;
}): RecommendationRefreshDecision {
  const key = fingerprintRecommendationContext({
    task: input.task,
    policy: input.policy,
    requiredCapability: input.requiredCapability,
    registryVersion: input.registryVersion,
  });
  if (input.currentKey === key) return Object.freeze({ fetch: false, key });
  if (
    input.stored &&
    isStoredRecommendationCurrent(
      input.stored,
      input.task,
      input.policy,
      input.registryVersion,
      input.requiredCapability,
    )
  ) {
    return Object.freeze({ fetch: false, key });
  }
  return Object.freeze({ fetch: true, key });
}
