import type { ReactNode } from "react";
import { FeatureCard, MetadataRows, MoneyValue, StatusLabel } from "./ui";
import { PreviewButton } from "./preview";
import type { CheckpointState, Money, SettlementStatus } from "@/lib/ui-model";

/** Presentation contracts only: rendered when a future real source supplies these values. */
export type TaskBrief = Readonly<{
  task: string;
  recipient: string;
  payment: Money;
  serviceRequirement: string;
  serviceBudget: Money;
  approvalRule: string;
  nextAction: string;
}>;
export function TaskBriefCard({ task }: { task: TaskBrief }) {
  return (
    <FeatureCard title="i understand the task">
      <p>{task.task}</p>
      <MetadataRows
        rows={[
          { label: "recipient", value: task.recipient },
          { label: "payment", value: <MoneyValue value={task.payment} /> },
          { label: "service required", value: task.serviceRequirement },
          {
            label: "service budget",
            value: <MoneyValue value={task.serviceBudget} />,
          },
          { label: "approval rule", value: task.approvalRule },
          { label: "next action", value: task.nextAction },
        ]}
      />
    </FeatureCard>
  );
}
export type PolicyBudget = Readonly<{
  serviceBudget: Money;
  spent: Money;
  remaining: Money;
  perServiceLimit: Money;
  capabilities: readonly string[];
  assets: readonly string[];
  networks: readonly string[];
  approvalRule: string;
}>;
export function PolicyBudgetCard({ policy }: { policy: PolicyBudget }) {
  return (
    <FeatureCard title="this is what omnis may do">
      <MetadataRows
        rows={[
          {
            label: "allocated",
            value: <MoneyValue value={policy.serviceBudget} />,
          },
          { label: "spent", value: <MoneyValue value={policy.spent} /> },
          {
            label: "remaining",
            value: <MoneyValue value={policy.remaining} />,
          },
          {
            label: "per-service limit",
            value: <MoneyValue value={policy.perServiceLimit} />,
          },
          {
            label: "allowed capabilities",
            value: policy.capabilities.join(", "),
          },
          { label: "permitted assets", value: policy.assets.join(", ") },
          { label: "permitted networks", value: policy.networks.join(", ") },
          { label: "approval rule", value: policy.approvalRule },
        ]}
      />
    </FeatureCard>
  );
}
export type ServiceView = Readonly<{
  name: string;
  capability: string;
  price: Money;
  reason: string;
  expectedResult: string;
  state: CheckpointState;
  moneyMovement: string;
  remaining: Money;
}>;
export function ServiceCard({ service }: { service: ServiceView }) {
  return (
    <FeatureCard title={service.name} eyebrow={service.capability}>
      <StatusLabel state={service.state} explanation={service.moneyMovement} />
      <MetadataRows
        rows={[
          { label: "price", value: <MoneyValue value={service.price} /> },
          { label: "reason for purchase", value: service.reason },
          { label: "expected result", value: service.expectedResult },
          {
            label: "budget remaining",
            value: <MoneyValue value={service.remaining} />,
          },
        ]}
      />
      <PreviewButton action="use this service">use this service</PreviewButton>
    </FeatureCard>
  );
}
export type ApprovalView = Readonly<{
  payment: Money;
  recipient: string;
  source: string;
  network: string;
  reason: string;
  threshold: string;
  serviceSpend: Money;
  totalEffect: string;
}>;
export function ApprovalGate({ approval }: { approval: ApprovalView }) {
  return (
    <FeatureCard title="approval needed">
      <StatusLabel state="approval" />
      <MetadataRows
        rows={[
          { label: "payment", value: <MoneyValue value={approval.payment} /> },
          { label: "recipient", value: approval.recipient },
          { label: "source", value: approval.source },
          { label: "settlement network", value: approval.network },
          { label: "reason", value: approval.reason },
          { label: "policy boundary", value: approval.threshold },
          {
            label: "prior service spending",
            value: <MoneyValue value={approval.serviceSpend} />,
          },
          { label: "total financial effect", value: approval.totalEffect },
        ]}
      />
      <div className="card-actions">
        <PreviewButton>approve payment</PreviewButton>
        <PreviewButton variant="outline">edit task</PreviewButton>
        <PreviewButton variant="outline">cancel</PreviewButton>
      </div>
    </FeatureCard>
  );
}
const settlementLabels: Record<
  SettlementStatus,
  { label: string; state: CheckpointState }
> = {
  prepared: { label: "payment ready", state: "inactive" },
  awaiting_approval: { label: "approval needed", state: "approval" },
  submitting: { label: "payment submitting", state: "settling" },
  submitted: { label: "payment submitted", state: "submitted" },
  confirming: { label: "payment settling", state: "settling" },
  confirmed: { label: "settled", state: "complete" },
  confirmation_delayed: { label: "confirmation delayed", state: "waiting" },
  reverted: { label: "settlement reverted", state: "blocked" },
  failed: { label: "settlement blocked", state: "blocked" },
};
export function SettlementCard({
  status,
  moneyMovement,
  network,
  transactionHash,
  recovery,
}: {
  status: SettlementStatus;
  moneyMovement: string;
  network: string;
  transactionHash?: string;
  recovery?: string;
}) {
  const display = settlementLabels[status];
  return (
    <FeatureCard title={display.label}>
      <StatusLabel state={display.state} explanation={moneyMovement} />
      <details className="technical-details">
        <summary>settlement details</summary>
        <MetadataRows
          rows={[
            { label: "network", value: network },
            ...(transactionHash
              ? [{ label: "transaction", value: transactionHash }]
              : []),
          ]}
        />
      </details>
      {recovery && <p>{recovery}</p>}
      {status === "confirmation_delayed" && (
        <PreviewButton action="check settlement status" variant="outline">
          check status
        </PreviewButton>
      )}
    </FeatureCard>
  );
}
export type ProofView = Readonly<{
  intent: string;
  plan: string;
  policy: string;
  servicePurchases: ReactNode;
  serviceResults: ReactNode;
  approval: string;
  settlement: string;
  timestamp: string;
  finalStatus: string;
}>;
export function ProofBundle({ proof }: { proof: ProofView }) {
  return (
    <FeatureCard title="proof record">
      <MetadataRows
        rows={[
          { label: "original task", value: proof.intent },
          { label: "structured plan", value: proof.plan },
          { label: "policy", value: proof.policy },
          { label: "service purchases", value: proof.servicePurchases },
          { label: "service results", value: proof.serviceResults },
          { label: "human approval", value: proof.approval },
          { label: "settlement", value: proof.settlement },
          { label: "timestamp", value: proof.timestamp },
          { label: "final status", value: proof.finalStatus },
        ]}
      />
    </FeatureCard>
  );
}
