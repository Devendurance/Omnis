export type Money = Readonly<{ amount: string; asset: string }>;

/** Unavailable is deliberately distinct from a connected source returning no records. */
export type PageState<T> =
  | { kind: "unavailable"; reason: string }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; moneyMovement: string };

export type TaskStatus =
  | "draft"
  | "planned"
  | "running"
  | "awaiting_approval"
  | "settling"
  | "completed"
  | "failed"
  | "cancelled";
export type SettlementStatus =
  | "prepared"
  | "awaiting_approval"
  | "submitting"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "confirmation_delayed"
  | "reverted"
  | "failed";
export type CheckpointState =
  | "inactive"
  | "active"
  | "complete"
  | "paid"
  | "waiting"
  | "approval"
  | "settling"
  | "submitted"
  | "blocked"
  | "retry";
export const checkpoints = [
  "intent",
  "policy",
  "service",
  "approval",
  "settlement",
  "proof",
] as const;
export type Checkpoint = (typeof checkpoints)[number];

export const previewMessage =
  "UI preview only. No wallet was connected. No service request or payment was submitted.";

export const navigation = [
  {
    label: "work",
    items: [
      { href: "/app", label: "start a task", icon: "plus" },
      { href: "/app/tasks", label: "tasks", icon: "tasks" },
      { href: "/app/activity", label: "activity", icon: "activity" },
    ],
  },
  {
    label: "control",
    items: [
      { href: "/app/policies", label: "policies", icon: "policies" },
      { href: "/app/agents", label: "agents", icon: "agents" },
      { href: "/app/services", label: "services", icon: "services" },
      { href: "/app/approvals", label: "approvals", icon: "approvals" },
    ],
  },
  {
    label: "records",
    items: [{ href: "/app/proof", label: "proof", icon: "proof" }],
  },
  {
    label: "account",
    items: [{ href: "/app/wallet", label: "wallet", icon: "wallet" }],
  },
] as const;

export const pageContent = {
  tasks: {
    eyebrow: "your work, with context",
    title: "Tasks",
    description:
      "Every financial task starts with an intention. Keep the conversation, the plan, and what happens next together.",
    empty: "Your next task starts here.",
    help: "Tell Omnis what needs to get paid. It will show the plan before it spends.",
    unavailable: "Task history is stored locally in this browser under your account.",
    action: "start a task",
    columns: ["task", "mode", "status", "last updated"],
    filters: ["all tasks", "pay", "delegate"],
    detailTitle: "One place for the whole task.",
    details: [
      {
        label: "the conversation",
        text: "Your original request and the context behind it.",
      },
      {
        label: "the plan",
        text: "Recipient, amount, service budget, and approval boundary.",
      },
      {
        label: "the outcome",
        text: "A visible route from the first instruction to the final proof.",
      },
    ],
  },
  activity: {
    eyebrow: "follow the financial work",
    title: "Activity",
    description:
      "An ordered record of service purchases, human decisions, and settlement. Every meaningful spend has a reason.",
    empty: "Nothing has moved yet.",
    help: "Service spending, human decisions, and settlement appear here as they happen.",
    unavailable: "The activity ledger is stored locally in this browser under your account.",
    action: "start a task",
    columns: ["event", "task", "amount", "status"],
    filters: ["all activity", "services", "approvals", "settlement"],
    detailTitle: "The details behind each action.",
    details: [
      {
        label: "what happened",
        text: "Each event belongs to a task, with a reason and a written status.",
      },
      {
        label: "what it cost",
        text: "Service purchases remain separate from the final payment.",
      },
      {
        label: "what comes next",
        text: "Waiting, approval, and recovery are visible steps in the record.",
      },
    ],
  },
  policies: {
    eyebrow: "delegation without surrendering control",
    title: "Policies",
    description:
      "This is what Omnis may do. Define the budget, allowed capabilities, and the point where your approval is required.",
    empty: "Your rules come first.",
    help: "Each task carries its own policy snapshot: budget, capabilities, and the approval boundary.",
    unavailable: "Task policies are stored locally in this browser under your account.",
    action: "explore policy controls",
    columns: ["policy", "task", "service budget", "approval rule"],
    filters: ["all policies"],
    detailTitle: "A boundary you can understand.",
    details: [
      {
        label: "budget",
        text: "Set a total service budget and a limit for each service purchase.",
      },
      {
        label: "capabilities",
        text: "Define the services, assets, and networks a task may use.",
      },
      {
        label: "approval",
        text: "Keep the final payment behind your explicit confirmation.",
      },
    ],
  },
  agents: {
    eyebrow: "bounded financial agency",
    title: "Agents",
    description:
      "Give an agent a task, a budget, and clear rules. Keep its allowance and permissions visible throughout the work.",
    empty: "A mandate before an agent acts.",
    help: "Delegated tasks and their budgets will appear here once agent execution is connected.",
    unavailable: "Agent execution is not connected in this preview.",
    action: "start a task",
    columns: ["delegated task", "allowance", "remaining", "permissions"],
    filters: ["all agents"],
    detailTitle: "Resourceful, within your rules.",
    details: [
      {
        label: "a defined task",
        text: "Delegate a specific outcome with a clear purpose.",
      },
      {
        label: "bounded allowance",
        text: "See what may be spent and what remains available.",
      },
      {
        label: "visible permissions",
        text: "Review the capabilities and actions inside the mandate.",
      },
    ],
  },
  services: {
    eyebrow: "capabilities with a purpose",
    title: "Services",
    description:
      "The right capability for the task. Inspect what a service does, what it costs, and why Omnis would use it.",
    empty: "No compatible services available.",
    help: "The directory includes the live Hedera testnet wallet activity service when configured, alongside catalog-only descriptors. Catalog entries are never purchased.",
    unavailable: "The service directory is not available.",
    action: "about service discovery",
    columns: ["service", "capability", "price", "availability"],
    filters: ["all capabilities", "wallet checks", "research"],
    detailTitle: "Every purchase should answer three questions.",
    details: [
      {
        label: "what is being bought?",
        text: "A clear capability and the result it is expected to return.",
      },
      {
        label: "why this service?",
        text: "A task-specific reason for selecting the capability.",
      },
      {
        label: "for how much?",
        text: "An explicit price checked against the remaining service budget.",
      },
    ],
  },
  approvals: {
    eyebrow: "your decision, at the right moment",
    title: "Approvals",
    description:
      "A deliberate pause before money moves. Review the amount, recipient, and reason before authorizing a payment.",
    empty: "No decisions waiting here.",
    help: "When a task reaches its approval boundary, the exact action and its financial effect appear here.",
    unavailable: "The approval queue is stored locally in this browser under your account.",
    action: "about the approval boundary",
    columns: ["action", "recipient", "amount", "reason"],
    filters: ["all approvals"],
    detailTitle: "Know exactly what you are approving.",
    details: [
      {
        label: "the payment",
        text: "Exact amount, asset, recipient, and settlement network.",
      },
      {
        label: "the boundary",
        text: "The policy rule that requires your decision.",
      },
      {
        label: "the full effect",
        text: "Previous service spending shown separately from the final payment.",
      },
    ],
  },
  proof: {
    eyebrow: "the record that closes the loop",
    title: "Proof",
    description:
      "One readable record connects the intention, the policy, the services, your approval, and the settlement.",
    empty: "The work ends with proof.",
    help: "Completed proof records will appear here when real task execution is connected.",
    unavailable: "The proof archive is not connected in this preview.",
    action: "start a task",
    columns: ["proof record", "task", "final status", "created"],
    filters: ["all proof"],
    detailTitle: "The complete financial story.",
    details: [
      {
        label: "intent & policy",
        text: "The original task, structured plan, and rules that applied.",
      },
      {
        label: "services & approval",
        text: "What was purchased, its result, and the human decision.",
      },
      {
        label: "settlement & evidence",
        text: "Transaction references, timestamps, and the final task status.",
      },
    ],
  },
} as const;
export type CollectionKind = keyof typeof pageContent;
