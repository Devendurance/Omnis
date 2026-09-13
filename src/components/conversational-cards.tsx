"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  Info,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type {
  FinancialTask,
  ServicePurchase,
  TaskBudgetState,
  TaskPolicy,
} from "@/lib/domain";
import { formatMoney } from "@/lib/domain";
import { getTaskBudgetState } from "@/lib/tasks/runtime";
import { isServiceExecutionOffered } from "@/lib/tasks/execution-gate";
import type { TaskPlanView } from "@/lib/tasks";
import type { TaskDiscoveryState } from "@/lib/tasks/session";
import type { StoredServiceRecommendation } from "@/lib/recommendation/verifier";
import {
  buildRecommendationCandidateSet,
  RECOMMENDATION_RATIONALE_ADVISORY,
  recommendationBadge,
  recommendationFacts,
} from "@/lib/recommendation";
import {
  ConversationalThinkingBubble,
  type MotionEntryState,
} from "./conversational-motion";
import {
  WALLET_ACTIVITY_SERVICE_ID,
  resolveRequiredCapability,
  selectServiceCandidate,
  type ServiceRegistry,
} from "@/lib/services";
import { HEDERA_TESTNET_NETWORK } from "@/lib/services/wallet-activity-descriptor";
import {
  ARC_TESTNET_EXPLORER_URL,
  P6B_TEST_MODE_AMOUNT,
  type SerializedFinalSettlementPreflight,
} from "@/lib/settlement";

function truncateAddress(address?: string): string {
  if (!address) return "unknown";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function InlineTaskPlanCard({
  plan,
  task,
  policy,
}: {
  plan: TaskPlanView;
  task?: FinancialTask;
  policy?: TaskPolicy;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const isPlanned = plan.status === "planned";
  const paymentAmount = plan.payment
    ? `${plan.payment.amount} ${plan.payment.asset}`
    : task?.paymentAmount
      ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
      : "unavailable";
  const serviceBudget = plan.serviceBudget
    ? `${plan.serviceBudget.amount} ${plan.serviceBudget.asset}`
    : policy?.maxServiceSpend
      ? `$${formatMoney(policy.maxServiceSpend)}`
      : "unavailable";
  const recipient = plan.recipient ?? task?.recipient;

  return (
    <div
      className="task-plan-card conversational-card"
      role="region"
      aria-label="Task Plan"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">
            {isPlanned ? "validated task plan" : "task draft"}
          </span>
          <span className="conversational-pill-tag">
            {isPlanned ? "plan ready" : "draft"}
          </span>
        </div>
        <h3 className="conversational-card-title">{plan.title}</h3>
      </div>

      <div className="conversational-plan-grid">
        <div className="conversational-plan-item">
          <span className="conversational-plan-label">PAYMENT</span>
          <div className="conversational-plan-value-group">
            <span className="conversational-plan-value">{paymentAmount}</span>
            {recipient && (
              <span className="conversational-plan-sub" title={recipient}>
                to {truncateAddress(recipient)}
              </span>
            )}
          </div>
        </div>

        <div className="conversational-plan-item">
          <span className="conversational-plan-label">SERVICE BUDGET</span>
          <div className="conversational-plan-value-group">
            <span className="conversational-plan-value">
              {policy?.maxServiceSpend
                ? `$${formatMoney(policy.maxServiceSpend)}`
                : serviceBudget}
            </span>
            <span className="conversational-plan-sub">{serviceBudget}</span>
          </div>
        </div>

        <div className="conversational-plan-item">
          <span className="conversational-plan-label">CONTROL</span>
          <div className="conversational-plan-value-group">
            <span className="conversational-plan-value">
              {plan.approvalBoundary.toLowerCase().includes("approval")
                ? "Final payment requires approval"
                : plan.approvalBoundary}
            </span>
            <span className="conversational-plan-sub">
              human approval required
            </span>
          </div>
        </div>
      </div>

      {plan.missing.length > 0 && (
        <div
          className="task-plan-missing conversational-alert-box"
          role="status"
        >
          <Info size={14} aria-hidden="true" />
          <span>
            waiting for: {plan.missing.join(", ").replaceAll("_", " ")}
          </span>
        </div>
      )}

      <div className="conversational-card-footer">
        <button
          type="button"
          className="conversational-text-toggle"
          onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
        >
          {showDetails ? (
            <>
              Hide details <ChevronUp size={14} aria-hidden="true" />
            </>
          ) : (
            <>
              Details <ChevronDown size={14} aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      {showDetails && (
        <div className="conversational-details-tray">
          {plan.purpose && (
            <div className="conversational-detail-row">
              <span className="muted">purpose:</span>
              <span>{plan.purpose}</span>
            </div>
          )}
          {recipient && (
            <div className="conversational-detail-row">
              <span className="muted">recipient:</span>
              <span className="conversational-mono-text">{recipient}</span>
            </div>
          )}
          {plan.perServiceCap && (
            <div className="conversational-detail-row">
              <span className="muted">per-service cap:</span>
              <span>
                {plan.perServiceCap.amount} {plan.perServiceCap.asset}
              </span>
            </div>
          )}
          <div className="conversational-detail-row">
            <span className="muted">service requirement:</span>
            <span>{plan.serviceRequirement}</span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">proposed next action:</span>
            <span>{plan.nextAction}</span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">task status:</span>
            <span>{plan.status}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function InlineTaskBudgetCard({
  task,
  policy,
  servicePurchases,
}: {
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
}) {
  const state = getTaskBudgetState(task, policy, servicePurchases);
  const budget = state.configuredServiceBudget;
  if (!budget) return null;
  const budgetStr = `$${formatMoney(budget)}`;
  const spentStr = `$${formatMoney(state.confirmedSpend)}`;
  const remainingStr = `$${formatMoney(state.remainingAvailable)}`;

  return (
    <div
      className="conversational-card bounded-budget-card"
      role="region"
      aria-label="Task Budget"
    >
      <div className="conversational-card-header">
        <span className="eyebrow conversational-eyebrow">
          bounded task budget
        </span>
        <h4 className="conversational-card-subtitle">
          service spend boundary
        </h4>
      </div>
      <div className="conversational-budget-summary">
        <div>
          <span className="muted">budget:</span>
          <span className="conversational-stat-num">{budgetStr}</span>
        </div>
        <div>
          <span className="muted">spent:</span>
          <span className="conversational-stat-num">{spentStr}</span>
        </div>
        <div>
          <span className="muted">remaining</span>:{" "}
          <span className="conversational-stat-num">{remainingStr}</span>
        </div>
      </div>
      <p className="conversational-budget-note muted">
        {servicePurchases.length === 0
          ? "Catalog-only. No service was purchased."
          : `Observed ${servicePurchases.length} service interaction(s).`}
      </p>
    </div>
  );
}

export function InlineServiceDiscoveryCard({
  task,
  policy,
  servicePurchases,
  discovery,
  registry,
  executionPending,
  executionError,
  hasPendingClarification = false,
  recommendation,
  recommendationHistorical = false,
  recommendationPending = false,
  recommendationMotion,
  onStartService,
  onReviewService,
}: {
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  discovery?: TaskDiscoveryState;
  registry: ServiceRegistry;
  executionPending: boolean;
  executionError?: string;
  hasPendingClarification?: boolean;
  recommendation?: StoredServiceRecommendation | null;
  recommendationHistorical?: boolean;
  recommendationPending?: boolean;
  recommendationMotion?: MotionEntryState | null;
  onStartService?: () => void;
  onReviewService: (serviceId: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const requiredCapability = resolveRequiredCapability(task);
  const result = requiredCapability
    ? selectServiceCandidate({
        task,
        policy,
        requiredCapability,
        registry,
        existingPurchases: servicePurchases,
      })
    : undefined;
  const selectedId =
    discovery?.selectedServiceId ??
    result?.selected?.descriptor.id ??
    WALLET_ACTIVITY_SERVICE_ID;
  const service =
    registry.getService(selectedId) ??
    result?.selected?.descriptor ??
    registry.getService(WALLET_ACTIVITY_SERVICE_ID);
  const price = service?.price ? `$${formatMoney(service.price)}` : "unavailable";
  const maxSpend = policy.maxServiceSpend
    ? Number(formatMoney(policy.maxServiceSpend))
    : 0;
  const priceNum = service?.price ? Number(formatMoney(service.price)) : 0;
  const remainingAfter = service?.price
    ? Math.max(0, maxSpend - priceNum)
    : null;
  const executable = isServiceExecutionOffered(task, hasPendingClarification);
  const canStart =
    executable &&
    service?.id === WALLET_ACTIVITY_SERVICE_ID &&
    service.status === "available" &&
    !service.catalogOnly &&
    Boolean(onStartService);
  // P9B.1: badge wording follows the provider (real Groq earns the Omnis
  // badge; mock output is a preview), and fact bullets come from the verified
  // candidate DTO rebuilt deterministically here, never from model prose.
  const badge = recommendation ? recommendationBadge(recommendation) : null;
  const recommendedCandidate =
    recommendation?.recommendedServiceId && requiredCapability
      ? (buildRecommendationCandidateSet({
          task,
          policy,
          registry,
          requiredCapability,
          existingPurchases: servicePurchases,
          ...(hasPendingClarification ? { hasPendingClarification: true } : {}),
        }).candidates.find(
          (candidate) => candidate.serviceId === recommendation.recommendedServiceId,
        ) ?? null)
      : null;
  const facts = recommendedCandidate
    ? recommendationFacts(recommendedCandidate)
    : null;

  return (
    <div
      className="conversational-card service-discovery-card"
      role="region"
      aria-label="Service Discovery"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">
            service discovery
          </span>
          <span className="conversational-pill-tag">{executable ? "ready to run" : "waiting for task details"}</span>
        </div>
        <h3 className="conversational-card-title">wallet activity check</h3>
        <p className="conversational-card-desc">
          Wallet activity summary and factual onchain interaction counts before
          settlement.
        </p>
      </div>
      {recommendationMotion?.phase === "thinking" && <ConversationalThinkingBubble />}
      {recommendationMotion &&
        recommendationMotion.phase !== "thinking" &&
        recommendationMotion.visibleText &&
        recommendation &&
        !recommendationHistorical &&
        recommendation.verified &&
        !recommendation.fallback &&
        recommendation.recommendedServiceId === service?.id && (
          <div className="conversational-recommendation">
            <span className="conversational-pill-tag">{badge}</span>
            <span className="conversational-recommendation-advisory">
              {RECOMMENDATION_RATIONALE_ADVISORY}
            </span>
            <p
              className="conversational-recommendation-text"
              data-testid={
                recommendationMotion.phase === "typing" ? "omnis-typing" : undefined
              }
              aria-hidden={recommendationMotion.phase === "typing" ? true : undefined}
            >
              {recommendationMotion.visibleText}
            </p>
            {recommendationMotion.phase === "complete" && facts && (
              <details className="conversational-recommendation-why">
                <summary>Why this service?</summary>
                <ul>
                  <li>{facts.capabilityLabel}</li>
                  <li>{facts.executableLabel}</li>
                  <li>{facts.networkLine}</li>
                  <li>{facts.costLabel}</li>
                  <li>{facts.budgetAfterLabel}</li>
                </ul>
              </details>
            )}
          </div>
        )}
      {recommendationPending && !recommendationMotion && (
        <p className="conversational-recommendation-pending" role="status">
          comparing matching services...
        </p>
      )}
      {(!recommendationMotion || !recommendationMotion.visibleText) &&
        recommendation &&
        !recommendationHistorical &&
        recommendation.verified &&
        !recommendation.fallback &&
        recommendation.recommendedServiceId === service?.id && (
          <div className="conversational-recommendation">
            <span className="conversational-pill-tag">{badge}</span>
            <span className="conversational-recommendation-advisory">
              {RECOMMENDATION_RATIONALE_ADVISORY}
            </span>
            <p className="conversational-recommendation-text">
              {recommendation.rationale}
            </p>
            {facts && (
              <details className="conversational-recommendation-why">
                <summary>Why this service?</summary>
                <ul>
                  <li>{facts.capabilityLabel}</li>
                  <li>{facts.executableLabel}</li>
                  <li>{facts.networkLine}</li>
                  <li>{facts.costLabel}</li>
                  <li>{facts.budgetAfterLabel}</li>
                </ul>
              </details>
            )}
          </div>
        )}
      {recommendation && recommendationHistorical && (
        <p className="conversational-recommendation-historical muted">
          previous recommendation (historical, not used): {recommendation.rationale}
        </p>
      )}

      <div className="conversational-service-meta-grid">
        <div className="conversational-meta-box">
          <span className="conversational-meta-label">SERVICE</span>
          <span className="conversational-meta-val">
            {service?.name ?? "Wallet activity check"}
          </span>
          <span className="conversational-meta-sub">
            <span>wallet risk</span> <span aria-hidden="true">·</span> <span>wallet activity</span>
          </span>
        </div>

        <div className="conversational-meta-box">
          <span className="conversational-meta-label">NETWORK</span>
          <span className="conversational-meta-val">
            {service?.network ?? "Hedera Testnet"}
          </span>
          <span className="conversational-meta-sub">rail: x402 micro-payment</span>
        </div>

        <div className="conversational-meta-box">
          <span className="conversational-meta-label">COST</span>
          <span className="conversational-meta-val">{price}</span>
          {(() => {
            const alt = result?.discovery.selectableCandidates.find(
              (c) => c.descriptor.id !== service?.id,
            );
            return alt?.price ? (
              <span className="conversational-meta-sub">
                <span>alternative:</span> <span>${formatMoney(alt.price)}</span>
              </span>
            ) : null;
          })()}
        </div>

        <div className="conversational-meta-box">
          <span className="conversational-meta-label">BUDGET AFTER PURCHASE</span>
          <span className="conversational-meta-val">
            {remainingAfter !== null ? `$${remainingAfter.toFixed(3)}` : "unavailable"}
          </span>
          <span className="conversational-meta-sub">
            <span>service budget</span>: <span>{policy.maxServiceSpend ? `$${formatMoney(policy.maxServiceSpend)}` : "not configured"}</span>
          </span>
        </div>
      </div>

      {result?.discovery.selectableCandidates && result.discovery.selectableCandidates.length > 0 && (
        <div className="conversational-candidate-list" style={{ margin: "14px 0", display: "grid", gap: "8px" }}>
          {result.discovery.selectableCandidates.map((cand) => (
            <div
              key={cand.descriptor.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#ffffff",
                padding: "10px 14px",
                borderRadius: "10px",
                border: "1px solid #e6dcf5",
              }}
            >
              <div>
                <strong>{cand.descriptor.name}</strong>
                <div style={{ display: "flex", gap: "8px", fontSize: "11px", color: "#666", marginTop: "2px" }}>
                  <span>{cand.descriptor.capability.replaceAll("-", " ")}</span>
                  <span aria-hidden="true">·</span>
                  <span>{cand.descriptor.category.replaceAll("-", " ")}</span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontFamily: "JetBrains Mono", fontSize: "13px", fontWeight: "bold" }}>
                  ${formatMoney(cand.price)}
                </span>
                <button
                  type="button"
                  className="button button-outline"
                  style={{ fontSize: "11px", padding: "4px 10px" }}
                  onClick={() => onReviewService(cand.descriptor.id)}
                >
                  review service
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {executionError && (
        <div className="conversational-alert-box error" role="alert">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{executionError}</span>
        </div>
      )}

      <div className="conversational-actions-row">
        {canStart && (
          <button
            type="button"
            className="button button-primary conversational-primary-btn"
            onClick={onStartService}
            disabled={executionPending}
            aria-label="start wallet check"
          >
            {executionPending
              ? "checking wallet..."
              : `Run wallet check · ${price}`}
          </button>
        )}

        <button
          type="button"
          className="conversational-text-toggle"
          onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
        >
          {showDetails ? (
            <>
              Details <ChevronUp size={14} aria-hidden="true" />
            </>
          ) : (
            <>
              Details <ChevronDown size={14} aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      {showDetails && (
        <div className="conversational-details-tray">
          <div className="conversational-detail-row">
            <span className="muted">service ID:</span>
            <span className="conversational-mono-text">
              {service?.id ?? WALLET_ACTIVITY_SERVICE_ID}
            </span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">payment rail:</span>
            <span>
              {service?.network ?? "Hedera Testnet"} (x402 protocol)
            </span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">policy reasoning:</span>
            <span>
              Task requires recipient wallet inspection prior to final payment
              authorization.
            </span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">exact quote:</span>
            <span>{price}</span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">catalog status:</span>
            <span>{service?.catalogOnly ? "catalog-only" : "available"}</span>
          </div>
          <div style={{ marginTop: "8px" }}>
            <button
              type="button"
              className="button button-outline"
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() =>
                onReviewService(service?.id ?? WALLET_ACTIVITY_SERVICE_ID)
              }
            >
              review service
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function InlineServiceResultCard({
  task,
  purchase,
  budget,
}: {
  task: FinancialTask;
  purchase: ServicePurchase;
  budget: TaskBudgetState;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const observations = (purchase.serviceResult?.observations ?? {}) as Record<
    string,
    unknown
  >;
  const flags = purchase.serviceResult?.heuristicFlags ?? [];
  const paidPrice = purchase.paidAmount
    ? `$${formatMoney(purchase.paidAmount)}`
    : purchase.quotedAmount
      ? `$${formatMoney(purchase.quotedAmount)}`
      : "unavailable";
  const remaining = `$${formatMoney(budget.remainingAvailable)}`;

  const addressValidity =
    typeof observations.addressValidity === "string"
      ? observations.addressValidity
      : null;
  const accountType =
    typeof observations.accountType === "string"
      ? observations.accountType.toUpperCase()
      : null;
  const txCount =
    typeof observations.transactionCount === "string"
      ? observations.transactionCount
      : typeof observations.transactionCount === "number"
        ? String(observations.transactionCount)
        : null;
  const activityObserved =
    typeof observations.transactionActivityObserved === "boolean"
      ? observations.transactionActivityObserved
      : typeof observations.activityObserved === "boolean"
        ? observations.activityObserved
        : null;

  const paymentIdentifier = purchase.paymentIdentifier ?? "unavailable";
  const finalPaymentName = task.paymentAmount
    ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
    : "50 USDC";

  const isPaid = purchase.status === "paid" && purchase.serviceResult;
  const isPendingUnresolved =
    purchase.status === "paying" || Boolean(purchase.recoveryState);
  const isFailed = purchase.status === "failed";

  if (isFailed) {
    return (
      <div
        className="conversational-card service-result-card"
        role="region"
        aria-label="Wallet check failed"
      >
        <div className="conversational-card-header">
          <div className="conversational-badge-row">
            <span className="eyebrow conversational-eyebrow">
              wallet check failed
            </span>
            <span className="conversational-pill-tag" style={{ background: "#A32945", color: "#FFFFFF" }}>
              <Ban size={12} aria-hidden="true" /> no payment confirmed
            </span>
          </div>
          <h3 className="conversational-card-title">Wallet activity</h3>
          <p className="conversational-card-desc">
            Wallet activity purchase is persisted for this task.
          </p>
        </div>
        <div className="conversational-alert-box error" role="status">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>
            The wallet check did not complete. No service payment was
            confirmed. The service budget reservation was released.
          </span>
        </div>
        {purchase.recoveryState?.message && (
          <p className="conversational-truth-note muted">
            {purchase.recoveryState.message}
          </p>
        )}
        <p className="conversational-truth-note muted">
          The {finalPaymentName} payment was not sent. Final payment remains
          blocked until a completed wallet check is on record.
        </p>
      </div>
    );
  }

  if (isPendingUnresolved) {
    return (
      <div
        className="conversational-card service-result-card"
        role="region"
        aria-label="Wallet check payment pending"
      >
        <div className="conversational-card-header">
          <div className="conversational-badge-row">
            <span className="eyebrow conversational-eyebrow">
              payment confirmation pending
            </span>
            <span className="conversational-pill-tag settling">
              <Clock3 size={12} aria-hidden="true" /> waiting
            </span>
          </div>
          <h3 className="conversational-card-title">Wallet activity</h3>
          <p className="conversational-card-desc">
            Wallet activity purchase is persisted for this task.
          </p>
        </div>
        <p>
          {purchase.recoveryState?.message ??
            "Payment confirmation is pending."}
        </p>
        {purchase.recoveryState?.paymentIdentifier && (
          <p className="conversational-mono-text">
            payment identifier: {purchase.recoveryState.paymentIdentifier}
          </p>
        )}
        <p className="conversational-truth-note muted">
          No payment is confirmed yet. No further retry is available until this
          attempt is reconciled read-only. The {finalPaymentName} payment was
          not sent.
        </p>
      </div>
    );
  }

  if (!isPaid) {
    return null;
  }

  return (
    <div
      className="conversational-card service-result-card"
      role="region"
      aria-label="Wallet check result"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">
            paid, read-only activity confirmed
          </span>
          <span className="conversational-pill-tag complete">
            <CheckCircle2 size={12} aria-hidden="true" /> verified
          </span>
        </div>
        <h3 className="conversational-card-title">Wallet activity</h3>
        <p className="conversational-card-desc">
          Wallet activity purchase is persisted for this task.
        </p>
      </div>

      <div className="conversational-observation-grid">
        {addressValidity && (
          <div className="conversational-obs-pill">
            <span className="obs-dot" />
            <span>{addressValidity === "valid" ? "Valid address" : addressValidity}</span>
          </div>
        )}
        {accountType && (
          <div className="conversational-obs-pill">
            <span className="obs-dot" />
            <span>{accountType}</span>
          </div>
        )}
        {txCount !== null && (
          <div className="conversational-obs-pill">
            <span className="obs-dot" />
            <span>{txCount} transactions observed</span>
          </div>
        )}
        {activityObserved !== null && (
          <div className="conversational-obs-pill">
            <span className="obs-dot" />
            <span>
              {activityObserved ? "Activity observed" : "No activity observed"}
            </span>
          </div>
        )}
        {!addressValidity && !accountType && txCount === null && activityObserved === null && (
          <div className="conversational-obs-pill">
            <span className="obs-dot" />
            <span>Activity observed</span>
          </div>
        )}
      </div>

      {flags.length > 0 && (
        <div className="conversational-heuristic-box">
          <span className="conversational-meta-label">
            HEURISTIC OBSERVATIONS (NON-FACTUAL SIGNALS)
          </span>
          <ul className="conversational-heuristic-list">
            {flags.map((flag, idx) => (
              <li key={idx}>
                {typeof flag === "object" && flag !== null && "code" in flag
                  ? String((flag as { code: unknown }).code)
                  : String(flag)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="conversational-result-footer">
        <div className="conversational-footer-stats">
          <span>
            Paid {paidPrice} via {purchase.settlementNetwork ?? "Hedera"}
          </span>
          <span className="conversational-bullet" aria-hidden="true">
            ·
          </span>
          <span>{remaining} service budget remaining</span>
        </div>
        {purchase.paymentIdentifier && (
          <div style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "#666", marginTop: "6px" }}>
            <span>payment identifier</span>:{" "}
            <span className="conversational-mono-text">
              {purchase.paymentIdentifier}
            </span>
          </div>
        )}

        <button
          className="conversational-text-toggle"
          onClick={() => setShowEvidence(!showEvidence)}
          aria-expanded={showEvidence}
        >
          {showEvidence ? (
            <>
              Hide evidence <ChevronUp size={14} aria-hidden="true" />
            </>
          ) : (
            <>
              View evidence <ChevronDown size={14} aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      <p className="conversational-truth-note muted">
        The {finalPaymentName} payment was not sent. Final payment remains
        blocked on human approval.
      </p>

      {showEvidence && (
        <div className="conversational-details-tray">
          <div className="conversational-detail-row">
            <span className="muted">payment identifier:</span>
            <span className="conversational-mono-text">
              {paymentIdentifier}
            </span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">settlement network:</span>
            <span>
              {purchase.settlementNetwork ?? HEDERA_TESTNET_NETWORK}
            </span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">target wallet:</span>
            <span className="conversational-mono-text">
              {task.recipient ?? "unknown"}
            </span>
          </div>
          <div className="conversational-detail-row">
            <span className="muted">status:</span>
            <span>{purchase.status}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function InlineApprovalCard({
  task,
  policy,
  activeWallet,
  preflight,
  preflightLoading,
  preflightError,
  executionError,
  testMode,
  setTestMode,
  onApprove,
  onCancel,
  isSubmitting,
  submitStep,
  manualRecoveryHash,
  setManualRecoveryHash,
  onRecoverLegacy,
  isRecovering,
}: {
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  activeWallet?: string;
  preflight: SerializedFinalSettlementPreflight | null;
  preflightLoading: boolean;
  preflightError: string | null;
  executionError: string | null;
  testMode: boolean;
  setTestMode: (mode: boolean) => void;
  onApprove: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitStep: string | null;
  manualRecoveryHash: string;
  setManualRecoveryHash: (hash: string) => void;
  onRecoverLegacy: (hash: string) => void;
  isRecovering: boolean;
}) {
  const [reviewed, setReviewed] = useState(false);
  const recipient = task.recipient ?? "unknown";
  const finalAmount = task.paymentAmount
    ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
    : "50 USDC";
  const testAmountStr = `${formatMoney(P6B_TEST_MODE_AMOUNT)} ${P6B_TEST_MODE_AMOUNT.asset}`;

  const approveButtonText = isSubmitting
    ? submitStep === "approving"
      ? "authorizing payment..."
      : submitStep === "switching_chain"
        ? "switching to Arc Testnet..."
        : submitStep === "signing"
          ? "signing transaction..."
          : submitStep === "submitting"
            ? "recording submission..."
            : submitStep === "confirming"
              ? "confirming onchain receipt..."
              : "processing..."
    : testMode
      ? `Approve & pay ${testAmountStr} (TEST MODE)`
      : `Approve & pay ${finalAmount}`;

  return (
    <div
      className="conversational-card final-payment-card"
      role="region"
      aria-label="Payment approval"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">final payment</span>
          <span className="conversational-pill-tag approval">
            <ShieldCheck size={12} aria-hidden="true" /> human approval required
          </span>
        </div>
        <h3 className="conversational-card-title">approval needed</h3>
        <p className="conversational-card-desc">
          Explicit human approval required before funds move onchain.
        </p>
      </div>

      <div className="conversational-approval-summary-grid">
        <div className="conversational-meta-box">
          <span className="conversational-meta-label">AMOUNT & RECIPIENT</span>
          <span className="conversational-meta-val">{finalAmount}</span>
          <span className="conversational-meta-sub" title={recipient}>
            to {truncateAddress(recipient)}
          </span>
        </div>

        <div className="conversational-meta-box">
          <span className="conversational-meta-label">SOURCE WALLET</span>
          <span className="conversational-meta-val" title={activeWallet}>
            {truncateAddress(activeWallet)}
          </span>
          <span className="conversational-meta-sub">Privy embedded wallet</span>
        </div>

        <div className="conversational-meta-box">
          <span className="conversational-meta-label">NETWORK</span>
          <span className="conversational-meta-val">Arc Testnet</span>
          <span className="conversational-meta-sub">Chain ID 5042002</span>
        </div>

        <div className="conversational-meta-box">
          <span className="conversational-meta-label">WALLET CHECK</span>
          <span className="conversational-meta-val complete">completed</span>
          <span className="conversational-meta-sub">Hedera x402 verified</span>
        </div>

        {policy?.maxServiceSpend && (
          <div className="conversational-meta-box">
            <span className="conversational-meta-label">SERVICE BUDGET</span>
            <span className="conversational-meta-val">
              ${formatMoney(policy.maxServiceSpend)}
            </span>
            <span className="conversational-meta-sub">max service allowance</span>
          </div>
        )}
        {preflight && (
          <div className="conversational-meta-box">
            <span className="conversational-meta-label">SERVICE SPEND</span>
            <span className="conversational-meta-val">
              ${formatMoney(preflight.serviceAmountSpent)}
            </span>
            <span className="conversational-meta-sub">
              remaining ${formatMoney(preflight.serviceBudgetRemaining)} of
              service budget
            </span>
          </div>
        )}
      </div>
      <p className="final-payment-truth muted" style={{ marginTop: "12px", fontSize: "13px" }}>
        Payment not sent.{" "}
        {preflightLoading
          ? "Checking wallet balance on Arc Testnet..."
          : `Execution wallet: ${activeWallet ?? "not connected"}. The wallet activity check is paid and confirmed. Explicit approval is required before funds move.`}
      </p>

      {!reviewed ? (
        <div className="conversational-actions-row" style={{ marginTop: "16px" }}>
          <button
            type="button"
            className="button button-primary conversational-primary-btn"
            onClick={() => setReviewed(true)}
          >
            Review payment
          </button>
        </div>
      ) : (
        <div
          className="conversational-expanded-approval"
          role="dialog"
          aria-label="Confirm payment"
        >
          {testMode ? (
            <div className="conversational-test-mode-banner" role="note">
              <div className="test-mode-badge-title">TEST MODE ACTIVE</div>
              <div className="test-mode-grid">
                <div className="test-mode-item not-executed">
                  <span className="test-mode-label">ORIGINAL MANDATE</span>
                  <span className="test-mode-val">{finalAmount}</span>
                  <span className="test-mode-status">NOT EXECUTED</span>
                </div>
                <div className="test-mode-arrow" aria-hidden="true">
                  →
                </div>
                <div className="test-mode-item test-settlement">
                  <span className="test-mode-label">TEST SETTLEMENT</span>
                  <span className="test-mode-val">{testAmountStr}</span>
                  <span className="test-mode-status">Arc Testnet</span>
                </div>
              </div>
              <p className="test-mode-explanation">
                Development verification only. Caps live execution to{" "}
                {testAmountStr} on Arc Testnet.
              </p>
            </div>
          ) : (
            <div className="conversational-standard-approval-notice">
              <p>
                <strong>Authorize contractor payment:</strong> You are
                authorizing <strong>{finalAmount}</strong> to{" "}
                <span className="conversational-mono-text">{recipient}</span> on
                Arc Testnet.
              </p>
            </div>
          )}

          {preflight?.blockers && preflight.blockers.length > 0 && (
            <div className="settlement-error-banner" role="alert">
              <ul>
                {preflight.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {preflightError && (
            <div className="settlement-error-banner" role="alert">
              <span>{preflightError}</span>
            </div>
          )}

          {executionError && (
            <div className="settlement-error-banner" role="alert">
              <span>{executionError}</span>
            </div>
          )}

          <p className="final-payment-truth muted">
            {preflightLoading
              ? "Checking wallet balance on Arc Testnet..."
              : `Payment not sent. Execution wallet: ${activeWallet ?? "not connected"}. The wallet activity check is paid and confirmed. Explicit approval is required before funds move.`}
          </p>

          <div className="conversational-actions-row">
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                setReviewed(false);
                onCancel();
              }}
              disabled={isSubmitting}
            >
              Cancel
            </button>

            <button
              type="button"
              className="button button-primary"
              onClick={onApprove}
              disabled={
                isSubmitting ||
                preflightLoading ||
                !preflight?.readyForApproval ||
                !activeWallet
              }
            >
              {approveButtonText}
            </button>

            {testMode && (
              <button
                type="button"
                className="button button-outline"
                style={{ fontSize: "11px", opacity: 0.8 }}
                onClick={() => setTestMode(!testMode)}
                disabled={isSubmitting}
              >
                disable test mode
              </button>
            )}
          </div>

          {testMode && process.env.NODE_ENV !== "production" && (
            <div className="conversational-dev-recovery">
              <span className="eyebrow">
                recover existing test settlement:
              </span>
              <div className="conversational-recovery-input-row">
                <input
                  type="text"
                  placeholder="0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d"
                  value={manualRecoveryHash}
                  onChange={(e) => setManualRecoveryHash(e.target.value.trim())}
                  className="conversational-recovery-input"
                />
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => {
                    if (manualRecoveryHash.startsWith("0x")) {
                      onRecoverLegacy(manualRecoveryHash);
                    }
                  }}
                  disabled={
                    !/^0x[0-9a-fA-F]{64}$/.test(manualRecoveryHash) ||
                    isRecovering
                  }
                >
                  {isRecovering
                    ? "recovering..."
                    : "recover existing test settlement"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function InlineSettlementProgressCard({
  submitStep,
  isSubmitting,
  isReconciling,
  txHash,
  onReconcile,
  executionError,
}: {
  task: FinancialTask;
  submitStep: string | null;
  isSubmitting: boolean;
  isReconciling: boolean;
  txHash: string | null;
  onReconcile: () => void;
  executionError: string | null;
}) {
  let stepLabel = "authorizing";
  if (submitStep === "switching_chain") stepLabel = "waiting for Privy";
  else if (submitStep === "signing") stepLabel = "signing transaction";
  else if (submitStep === "submitting") stepLabel = "submitted to Arc";
  else if (submitStep === "confirming" || isReconciling)
    stepLabel = "confirming onchain";

  return (
    <div
      className="conversational-card settlement-progress-card"
      role="status"
      aria-live="polite"
      aria-label="Settlement progress"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">settlement</span>
          <span className="conversational-pill-tag settling">{stepLabel}</span>
        </div>
        <h3 className="conversational-card-title">settling payment</h3>
      </div>

      <div className="conversational-progress-steps">
        <div className={`step-item ${submitStep ? "active" : "pending"}`}>
          <span className="step-circle" />
          <span>authorizing</span>
        </div>
        <div
          className={`step-item ${
            submitStep === "signing" ||
            submitStep === "submitting" ||
            submitStep === "confirming" ||
            txHash
              ? "active"
              : "pending"
          }`}
        >
          <span className="step-circle" />
          <span>submitted to Arc</span>
        </div>
        <div
          className={`step-item ${
            submitStep === "confirming" || txHash ? "active" : "pending"
          }`}
        >
          <span className="step-circle" />
          <span>confirming onchain</span>
        </div>
      </div>

      {txHash && (
        <div className="conversational-tx-link-box">
          <span className="muted">Submitted on Arc Testnet:</span>
          <a
            href={`${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="button button-outline conversational-explorer-btn"
          >
            <span>view on ArcScan</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
      )}

      {executionError && (
        <div className="settlement-error-banner" role="alert">
          <span>{executionError}</span>
        </div>
      )}

      <div className="conversational-actions-row" style={{ marginTop: "12px" }}>
        <button
          type="button"
          className="button button-primary"
          onClick={onReconcile}
          disabled={isReconciling || isSubmitting}
        >
          {isReconciling ? "checking onchain..." : "Reconcile onchain"}
        </button>
      </div>
    </div>
  );
}

export function InlineDemoVerifiedCard({
  task,
  txHash,
}: {
  task: FinancialTask;
  txHash?: string | null;
}) {
  const testAmountStr = `${formatMoney(P6B_TEST_MODE_AMOUNT)} ${P6B_TEST_MODE_AMOUNT.asset}`;
  const mandateAmountStr = task.paymentAmount
    ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
    : "50 USDC";

  return (
    <div
      className="conversational-card demo-verified-card"
      role="region"
      aria-label="Demo verification result"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">
            demo verification complete
          </span>
          <span className="conversational-pill-tag complete">
            <CheckCircle2 size={12} aria-hidden="true" /> confirmed
          </span>
        </div>
        <h3 className="conversational-card-title">Demo verification</h3>
      </div>

      <div className="conversational-demo-verified-grid">
        <div className="demo-box verified">
          <span className="demo-box-label">DEMO VERIFICATION</span>
          <span className="demo-box-val">PASSED</span>
        </div>

        <div className="demo-box settlement">
          <span className="demo-box-label">TEST SETTLEMENT</span>
          <span className="demo-box-val">{testAmountStr} confirmed</span>
          <span className="demo-box-sub">Arc Testnet (Chain ID 5042002)</span>
        </div>

        <div className="demo-box mandate">
          <span className="demo-box-label">ORIGINAL MANDATE</span>
          <span className="demo-box-val">{mandateAmountStr}</span>
          <span className="demo-box-status">NOT EXECUTED</span>
        </div>
      </div>

      {txHash && (
        <div className="conversational-tx-link-box">
          <a
            href={`${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="button button-outline conversational-explorer-btn"
          >
            <span>view on ArcScan</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
      )}

      <p className="conversational-truth-note muted">
        Infrastructure demo verified on Arc Testnet. Original contractor payment
        has not been executed.
      </p>

      <div className="conversational-actions-row">
        <Link
          href={`/app/proof/${task.id}`}
          className="button button-primary"
        >
          View proof
        </Link>
      </div>
    </div>
  );
}

export function InlinePaymentCompletedCard({
  task,
  txHash,
}: {
  task: FinancialTask;
  txHash?: string | null;
}) {
  const finalAmountStr = task.paymentAmount
    ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
    : "50 USDC";

  return (
    <div
      className="conversational-card payment-completed-card"
      role="region"
      aria-label="Payment completed"
    >
      <div className="conversational-card-header">
        <div className="conversational-badge-row">
          <span className="eyebrow conversational-eyebrow">
            payment completed
          </span>
          <span className="conversational-pill-tag complete">
            <CheckCircle2 size={12} aria-hidden="true" /> settled
          </span>
        </div>
        <h3 className="conversational-card-title">payment completed</h3>
      </div>

      <div className="conversational-approval-summary-grid">
        <div className="conversational-meta-box">
          <span className="conversational-meta-label">AMOUNT DELIVERED</span>
          <span className="conversational-meta-val">{finalAmountStr}</span>
        </div>
        <div className="conversational-meta-box">
          <span className="conversational-meta-label">RECIPIENT</span>
          <span className="conversational-meta-val">
            {truncateAddress(task.recipient)}
          </span>
        </div>
        <div className="conversational-meta-box">
          <span className="conversational-meta-label">NETWORK</span>
          <span className="conversational-meta-val">Arc Testnet</span>
        </div>
      </div>

      {txHash && (
        <div className="conversational-tx-link-box">
          <a
            href={`${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="button button-outline conversational-explorer-btn"
          >
            <span>view on ArcScan</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
      )}

      <div className="conversational-actions-row" style={{ marginTop: "16px" }}>
        <Link
          href={`/app/proof/${task.id}`}
          className="button button-primary"
        >
          View proof
        </Link>
      </div>
    </div>
  );
}
