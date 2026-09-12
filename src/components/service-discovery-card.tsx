import type { ReactNode } from "react";
import {
  formatMoney,
  type FinancialTask,
  type ServicePurchase,
  type TaskBudgetState,
  type TaskPolicy,
} from "@/lib/domain";
import {
  resolveRequiredCapability,
  selectServiceCandidate,
  type ServiceRegistry,
  type ServiceSelectionResult,
} from "@/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_SERVICE_ID,
} from "@/lib/services/wallet-activity-descriptor";
import type {
  PersistedServiceResult,
  ServiceDescriptor,
} from "@/lib/domain";
import { getTaskBudgetState } from "@/lib/tasks/runtime";
import type { TaskDiscoveryState } from "@/lib/tasks/session";
import { FeatureCard, MetadataRows, StatusLabel } from "./ui";

function capabilityLabel(value: string): string {
  return value.replaceAll("-", " ");
}

function priceLabel(amount: {
  asset: string;
  units: bigint;
  decimals: number;
}): string {
  const formatted = formatMoney(amount);
  return amount.asset === "USD" ? `$${formatted}` : `${formatted} ${amount.asset}`;
}

function budgetLabel(
  amount: { asset: string; units: bigint; decimals: number } | undefined,
): string {
  return amount ? priceLabel(amount) : "not configured";
}
function taskPaymentLabel(task: FinancialTask): string {
  return task.paymentAmount
    ? priceLabel(task.paymentAmount)
    : "final payment amount unavailable";
}

function valueLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "unavailable";
  }
}

function EvidenceRows({
  label,
  values,
}: {
  label: string;
  values: Readonly<Record<string, unknown>>;
}) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return (
      <div className="service-evidence">
        <p className="eyebrow">{label}</p>
        <p className="muted">none reported</p>
      </div>
    );
  }
  return (
    <div className="service-evidence">
      <p className="eyebrow">{label}</p>
      <MetadataRows
        rows={entries.map(([key, value]) => ({
          label: key,
          value: valueLabel(value),
        }))}
      />
    </div>
  );
}

function PaidServiceResult({
  task,
  purchase,
  budget,
  result,
}: {
  task: FinancialTask;
  purchase: ServicePurchase;
  budget: TaskBudgetState;
  result: PersistedServiceResult;
}) {
  return (
    <div className="service-purchase-result" role="status" aria-live="polite">
      <StatusLabel state="paid" explanation="read-only activity confirmed" />
      <MetadataRows
        rows={[
          {
            label: "service spend",
            value: budgetLabel(purchase.paidAmount ?? purchase.quotedAmount),
          },
          {
            label: "payment",
            value: purchase.paymentAmount
              ? `${purchase.paymentAmount.units.toString()} atomic units (${priceLabel(
                  purchase.paymentAmount,
                )})`
              : "payment amount unavailable",
          },
          { label: "reserved", value: budgetLabel(budget.reservedSpend) },
          { label: "confirmed", value: budgetLabel(budget.confirmedSpend) },
          {
            label: "remaining",
            value: budgetLabel(budget.remainingAvailable),
          },
          {
            label: "settlement network",
            value: purchase.settlementNetwork ?? HEDERA_TESTNET_NETWORK,
          },
          {
            label: "payment identifier",
            value: purchase.paymentIdentifier ?? "unavailable",
          },
        ]}
      />
      <EvidenceRows label="observations" values={result.observations} />
      <div className="service-evidence">
        <p className="eyebrow">heuristic flags</p>
        {result.heuristicFlags.length > 0 ? (
          <ul>
            {result.heuristicFlags.map((flag, index) => (
              <li key={`${index}-${valueLabel(flag)}`}>{valueLabel(flag)}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">none reported</p>
        )}
      </div>
      {result.disclaimer && (
        <p className="muted service-result-disclaimer">{result.disclaimer}</p>
      )}
      <p className="service-result-truth">
        The service result is separate from the final contractor payment. The{" "}
        {taskPaymentLabel(task)} payment was not sent.
      </p>
    </div>
  );
}

function PurchaseState({
  task,
  purchase,
  budget,
}: {
  task: FinancialTask;
  purchase: ServicePurchase;
  budget: TaskBudgetState;
}) {
  if (purchase.status === "paid" && purchase.serviceResult) {
    return (
      <PaidServiceResult
        task={task}
        purchase={purchase}
        budget={budget}
        result={purchase.serviceResult}
      />
    );
  }
  if (purchase.status === "paying" && purchase.recoveryState) {
    return (
      <div className="service-purchase-result" role="status" aria-live="polite">
        <StatusLabel state="waiting" explanation="payment confirmation pending" />
        <p>{purchase.recoveryState.message}</p>
        {purchase.recoveryState.paymentIdentifier && (
          <p className="money">
            payment identifier: {purchase.recoveryState.paymentIdentifier}
          </p>
        )}
        <p className="muted">
          No retry is available. Reconcile this attempt read-only before any
          further action.
        </p>
      </div>
    );
  }
  if (purchase.status === "failed") {
    const detail = purchase.recoveryState?.message;
    return (
      <div className="service-purchase-result" role="status" aria-live="polite">
        <StatusLabel state="blocked" explanation="no payment was confirmed" />
        <p>
          The wallet activity service failed before a confirmed payment
          {detail ? `: ${detail}` : "."}
        </p>
        <p className="muted">
          The service budget reservation has been released. You may safely retry the check.
        </p>
      </div>
    );
  }
  if (purchase.status === "paying") {
    return (
      <div className="service-purchase-result" role="status" aria-live="polite">
        <StatusLabel state="waiting" explanation="payment in progress" />
        <p>Payment outcome is being recorded. Do not retry this purchase.</p>
      </div>
    );
  }
  return null;
}

function CandidateRow({
  result,
  onReview,
}: {
  result: ServiceSelectionResult;
  onReview?: (serviceId: string) => void;
}) {
  return (
    <div className="service-candidate-list">
      {result.discovery.selectableCandidates.map((candidate) => (
        <article className="service-candidate" key={candidate.descriptor.id}>
          <div>
            <strong>{candidate.descriptor.name}</strong>
            <span>{capabilityLabel(candidate.descriptor.capability)}</span>
            <span>
              {candidate.descriptor.catalogOnly ? "catalog only" : "live testnet"}
            </span>
          </div>
          <span className="money">{priceLabel(candidate.price)}</span>
          {onReview ? (
            <button
              className="button button-outline service-review-button"
              type="button"
              onClick={() => onReview(candidate.descriptor.id)}
            >
              review service
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
        </article>
      ))}
    </div>
  );
}

function DiscoveryEmptyState({ result }: { result: ServiceSelectionResult }) {
  const rejected = result.discovery.rejectedCandidates[0];
  return (
    <div className="service-discovery-empty" role="status">
      <strong>No compatible service is selectable.</strong>
      <span>
        {rejected?.reasonCodes[rejected.reasonCodes.length - 1] ??
          "service discovery returned no eligible candidates"}
      </span>
    </div>
  );
}

export function ServiceDiscoveryCard({
  task,
  policy,
  servicePurchases,
  discovery,
  registry,
  executionPending = false,
  executionError,
  onReviewService,
  onStartService,
}: {
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  discovery?: TaskDiscoveryState;
  registry: ServiceRegistry;
  executionPending?: boolean;
  executionError?: string;
  onReviewService?: (serviceId: string) => void;
  onStartService?: () => void;
}) {
  const requiredCapability = resolveRequiredCapability(task);
  if (
    task.type !== "pay_with_check" ||
    !requiredCapability ||
    !["planned", "running", "awaiting_approval"].includes(task.status)
  ) {
    return null;
  }

  const result = selectServiceCandidate({
    task,
    policy,
    requiredCapability,
    registry,
    existingPurchases: servicePurchases,
  });
  const budgetState = getTaskBudgetState(task, policy, servicePurchases);
  const budget = budgetState.configuredServiceBudget ?? task.serviceBudget;
  const persistedServiceId = servicePurchases.find((entry) =>
    ["approved", "paying", "paid"].includes(entry.status),
  )?.serviceId;
  const selectedId =
    discovery?.selectedServiceId ??
    result.selected?.descriptor.id ??
    persistedServiceId;
  const selectedDescriptor: ServiceDescriptor | undefined =
    (selectedId ? registry.getService(selectedId) : undefined) ??
    result.selected?.descriptor;
  const purchase = selectedId
    ? servicePurchases.find((entry) => entry.serviceId === selectedId)
    : undefined;
  const selectedCandidate = result.selected;
  const selectedService = selectedDescriptor ?? selectedCandidate?.descriptor;
  const selectedServiceName =
    selectedService?.name ?? (purchase ? "Wallet activity check" : "selected service");
  const selectedServicePrice = selectedService?.price ?? purchase?.quotedAmount;
  const hasSelectedService = Boolean(selectedService || purchase);
  const selectedCandidateMatches =
    selectedCandidate !== undefined &&
    selectedId === selectedCandidate.descriptor.id;
  const canStart =
    selectedDescriptor?.id === WALLET_ACTIVITY_SERVICE_ID &&
    selectedDescriptor.status === "available" &&
    !selectedDescriptor.catalogOnly &&
    (!purchase || purchase.status === "failed") &&
    Boolean(onStartService);
  const content: ReactNode = hasSelectedService ? (
    <>
      <p className="service-discovery-summary">
        {purchase
          ? "Wallet activity purchase is persisted for this task."
          : `Found ${result.discovery.selectableCandidates.length} compatible services`}
      </p>
      <CandidateRow result={result} onReview={onReviewService} />
      <div className="service-discovery-recommendation">
        <strong>{selectedServiceName}</strong>
        <span>
          {selectedService?.catalogOnly
            ? "Catalog entry only. No payment action is available."
            : "Live wallet activity service on Hedera testnet."}
        </span>
        <span>
          {selectedCandidateMatches
            ? `Reason: ${result.selectionReason}.`
            : purchase
              ? "This persisted purchase is the service used for the task."
              : "Choose review service to set the service used for this task."}
        </span>
      </div>
      <MetadataRows
        rows={[
          { label: "service budget", value: budgetLabel(budget) },
          {
            label: "selected quote",
            value: selectedServicePrice
              ? budgetLabel(selectedServicePrice)
              : "not selected",
          },
          {
            label: purchase ? "remaining" : "remaining before purchase",
            value: purchase
              ? budgetLabel(budgetState.remainingAvailable)
              : budgetLabel(
                  selectedCandidateMatches && selectedCandidate?.remainingBudget
                    ? selectedCandidate.remainingBudget
                    : budget,
                ),
          },
        ]}
      />
      {canStart && (
        <button
          className="button button-primary"
          type="button"
          onClick={onStartService}
          disabled={executionPending}
        >
          {executionPending
            ? "checking wallet..."
            : purchase?.status === "failed"
              ? "retry wallet check"
              : "start wallet check"}
        </button>
      )}
      {selectedDescriptor?.catalogOnly && (
        <p className="service-not-purchased">
          Catalog-only. No service was purchased.
        </p>
      )}
      {executionError && (
        <p className="service-execution-error" role="alert">
          {executionError}
        </p>
      )}
      {executionPending && (
        <p className="service-execution-status" role="status" aria-live="polite">
          P2 authorization passed. Reserving{" "}
          {selectedDescriptor ? budgetLabel(selectedDescriptor.price) : "the quoted amount"}{" "}
          before the x402 request.
        </p>
      )}
      {purchase && (
        <PurchaseState task={task} purchase={purchase} budget={budgetState} />
      )}
    </>
  ) : (
    <>
      <p className="service-discovery-summary">No compatible services found</p>
      <DiscoveryEmptyState result={result} />
      <p className="service-not-purchased">No service was purchased.</p>
    </>
  );

  return (
    <div className="service-discovery-card">
      <FeatureCard eyebrow="service discovery" title="wallet activity check">
        {content}
      </FeatureCard>
    </div>
  );
}
