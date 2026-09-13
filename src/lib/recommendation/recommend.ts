import type {
  FinancialTask,
  ServicePurchase,
  TaskPolicy,
} from "../domain";
import { formatMoney } from "../domain/money";
import {
  selectServiceCandidate,
  type ServiceRegistry,
  type ServiceSelectionResult,
} from "../services";
import {
  buildRecommendationCandidateSet,
  type RecommendationCandidateSet,
} from "./dto";
import type { RecommendationModel } from "./model";
import {
  fingerprintCandidate,
  fingerprintTaskPolicy,
  isRecommendationStale,
  recommendationServiceBudgetLabel,
  verifyServiceRecommendation,
  type RecommendationFreshnessInput,
  type StoredServiceRecommendation,
} from "./verifier";

export type RecommendServiceInput = Readonly<{
  task: FinancialTask;
  policy: TaskPolicy;
  registry: ServiceRegistry;
  requiredCapability: string;
  existingPurchases?: readonly ServicePurchase[];
  hasPendingClarification?: boolean;
  model: RecommendationModel;
  now: string;
}>;

export type ServiceRecommendationOutcome = Readonly<{
  candidateSet: RecommendationCandidateSet;
  stored: StoredServiceRecommendation;
  deterministic: ServiceSelectionResult;
  recommendationProvider: string;
  recommendationModel: string;
  recommendationVerified: boolean;
  fallback: boolean;
  fallbackReason?: string;
}>;

function storeRecommendation(
  input: RecommendServiceInput,
  candidateSet: RecommendationCandidateSet,
  outcome: Pick<
    ServiceRecommendationOutcome,
    "recommendationProvider" | "recommendationModel" | "recommendationVerified" | "fallback" | "fallbackReason"
  >,
  recommendedServiceId: string | null,
  rationale: string,
  comparisons: readonly Readonly<{ serviceId: string; assessment: string }>[],
): StoredServiceRecommendation {
  const recommended = recommendedServiceId
    ? candidateSet.candidates.find(
        (candidate) => candidate.serviceId === recommendedServiceId,
      )
    : undefined;
  return Object.freeze({
    taskId: input.task.id,
    taskUpdatedAt: input.task.updatedAt,
    requiredCapability: candidateSet.requiredCapability,
    ...(input.task.recipient ? { recipient: input.task.recipient } : {}),
    serviceBudgetLabel: recommendationServiceBudgetLabel(input.task),
    policyTaskId: input.policy.taskId,
    policyFingerprint: fingerprintTaskPolicy(input.policy),
    registryVersion: candidateSet.registryVersion,
    recommendedServiceId,
    candidateFingerprint: recommended ? fingerprintCandidate(recommended) : null,
    rationale,
    comparisons,
    provider: outcome.recommendationProvider,
    model: outcome.recommendationModel,
    verified: outcome.recommendationVerified,
    fallback: outcome.fallback,
    createdAt: input.now,
  });
}

function deterministicFallback(
  input: RecommendServiceInput,
  candidateSet: RecommendationCandidateSet,
  reason: string,
): ServiceRecommendationOutcome {
  const deterministic = selectServiceCandidate({
    task: input.task,
    policy: input.policy,
    requiredCapability: candidateSet.requiredCapability || input.requiredCapability,
    registry: input.registry,
    ...(input.existingPurchases
      ? { existingPurchases: input.existingPurchases }
      : {}),
  });
  const selected = deterministic.selected;
  return Object.freeze({
    candidateSet,
    stored: storeRecommendation(
      input,
      candidateSet,
      {
        recommendationProvider: input.model.name,
        recommendationModel: input.model.model,
        recommendationVerified: false,
        fallback: true,
        fallbackReason: reason,
      },
      selected ? selected.descriptor.id : null,
      selected
        ? `Deterministic selection: ${selected.descriptor.name} is the lowest-cost valid option.`
        : "No available service satisfies the required capability and task policy.",
      candidateSet.candidates.map((candidate) => ({
        serviceId: candidate.serviceId,
        assessment: candidate.executable
          ? "executable now within budget"
          : "not executable in this demo",
      })),
    ),
    deterministic,
    recommendationProvider: input.model.name,
    recommendationModel: input.model.model,
    recommendationVerified: false,
    fallback: true,
    fallbackReason: reason,
  });
}

// Orchestrator: validated task to required capability to deterministic
// registry candidates to deterministic eligibility facts to LLM comparison to
// structured recommendation to deterministic verifier to existing P2. The
// model recommends; it never authorizes or spends. Any model failure falls
// back safely to the existing deterministic candidate selection, which keeps
// the deterministic Run action available for a valid executable service.
export async function recommendService(
  input: RecommendServiceInput,
): Promise<ServiceRecommendationOutcome> {
  const candidateSet = buildRecommendationCandidateSet({
    task: input.task,
    policy: input.policy,
    registry: input.registry,
    requiredCapability: input.requiredCapability,
    ...(input.existingPurchases
      ? { existingPurchases: input.existingPurchases }
      : {}),
    ...(input.hasPendingClarification !== undefined
      ? { hasPendingClarification: input.hasPendingClarification }
      : {}),
  });
  const deterministic = selectServiceCandidate({
    task: input.task,
    policy: input.policy,
    requiredCapability: candidateSet.requiredCapability || input.requiredCapability,
    registry: input.registry,
    ...(input.existingPurchases
      ? { existingPurchases: input.existingPurchases }
      : {}),
  });
  if (candidateSet.candidates.length === 0) {
    return deterministicFallback(input, candidateSet, "no candidates to evaluate");
  }
  let generated;
  try {
    generated = await input.model.generate({
      candidates: candidateSet.candidates,
      requiredCapability: candidateSet.requiredCapability,
      serviceBudgetLabel: input.task.serviceBudget
        ? `$${formatMoney(input.task.serviceBudget)}`
        : "not configured",
    });
  } catch (error) {
    return deterministicFallback(
      input,
      candidateSet,
      error instanceof Error ? error.message : "recommendation provider failed",
    );
  }
  const verified = verifyServiceRecommendation(generated.recommendation, candidateSet);
  if (!verified.ok) {
    return deterministicFallback(input, candidateSet, verified.reason);
  }
  return Object.freeze({
    candidateSet,
    stored: storeRecommendation(
      input,
      candidateSet,
      {
        recommendationProvider: generated.provider,
        recommendationModel: generated.model,
        recommendationVerified: true,
        fallback: false,
      },
      verified.candidate.serviceId,
      generated.recommendation.rationale,
      generated.recommendation.comparisons.map((comparison) => ({
        serviceId: comparison.serviceId,
        assessment: comparison.assessment,
      })),
    ),
    deterministic,
    recommendationProvider: generated.provider,
    recommendationModel: generated.model,
    recommendationVerified: true,
    fallback: false,
  });
}

export type { RecommendationFreshnessInput, StoredServiceRecommendation };
export { isRecommendationStale };
