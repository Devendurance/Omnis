"use client";

import { FeatureCard, MetadataRows } from "./ui";
import {
  formatMoney,
  type FinancialTask,
  type Money,
  type ServicePurchase,
  type TaskPolicy,
} from "@/lib/domain";
import { getTaskBudgetState } from "@/lib/tasks/runtime";

function budgetLabel(value: Money): string {
  const formatted = formatMoney(value);
  if (value.asset !== "USD") return `${formatted} ${value.asset}`;
  return `$${formatted}`;
}
function paymentLabel(task: FinancialTask): string {
  return task.paymentAmount
    ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
    : "the final payment";
}

export function TaskBudgetCard({
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

  return (
    <div className="task-budget-card">
      <FeatureCard eyebrow="bounded task budget" title="service spend boundary">
        <MetadataRows
          rows={[
            { label: "budget", value: budgetLabel(budget) },
            { label: "reserved", value: budgetLabel(state.reservedSpend) },
            { label: "spent", value: budgetLabel(state.confirmedSpend) },
            {
              label: "remaining",
              value: budgetLabel(state.remainingAvailable),
            },
          ]}
        />
        {task.type === "pay_with_check" && (
          <div className="task-budget-quote" role="status" aria-live="polite">
            <p className="eyebrow">execution boundary</p>
            <p>
              The selected wallet activity service reserves its exact quote
              before any x402 payment is created.
            </p>
            <p className="muted">
              Service spend is separate from the {paymentLabel(task)} contractor
              payment, which remains approval-only.
            </p>
          </div>
        )}
      </FeatureCard>
    </div>
  );
}
