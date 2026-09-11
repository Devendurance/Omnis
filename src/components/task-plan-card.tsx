import { FeatureCard, MetadataRows } from "./ui";
import type { IntentMissingField } from "@/lib/intent";
import type { TaskPlanView } from "@/lib/tasks";

function moneyLabel(value: { amount: string; asset: string }): string {
  return `${value.amount} ${value.asset}`;
}

function missingLabel(field: IntentMissingField): string {
  if (field === "recipient") return "recipient";
  if (field === "payment_amount") return "payment amount";
  if (field === "payment_asset") return "payment asset";
  if (field === "service_budget") return "service budget";
  return "task type";
}

export function TaskPlanCard({ plan }: { plan: TaskPlanView }) {
  const rows = [
    ...(plan.purpose
      ? [{ label: "purpose", value: plan.purpose }]
      : []),
    { label: "service requirement", value: plan.serviceRequirement },
    ...(plan.recipient
      ? [{ label: "recipient", value: plan.recipient }]
      : []),
    ...(plan.payment
      ? [{ label: "payment", value: moneyLabel(plan.payment) }]
      : []),
    ...(plan.serviceBudget
      ? [
          {
            label: plan.type === "delegate" ? "research budget" : "service budget",
            value: moneyLabel(plan.serviceBudget),
          },
        ]
      : []),
    ...(plan.perServiceCap
      ? [{ label: "per-service cap", value: moneyLabel(plan.perServiceCap) }]
      : []),
    { label: "final payment", value: plan.approvalBoundary },
    { label: "proposed next action", value: plan.nextAction },
    { label: "task status", value: plan.status },
  ];

  return (
    <div className="task-plan-card">
      <FeatureCard
        eyebrow={plan.status === "planned" ? "validated task plan" : "task draft"}
        title={plan.title}
      >
        <MetadataRows rows={rows} />
        {plan.missing.length > 0 && (
          <p className="task-plan-missing">
            waiting for: {plan.missing.map(missingLabel).join(", ")}
          </p>
        )}
      </FeatureCard>
    </div>
  );
}
