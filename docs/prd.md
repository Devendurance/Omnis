# useOmnis: Product Requirements Document (PRD)

**Version:** V1 / ETHOnline 2026  
**Status:** Initial locked scope  
**Primary interface:** Interactive agent chat  
**Primary target user:** Crypto-native individuals and small teams who hold stablecoins, use AI to get work done, and increasingly need payments to happen as part of those workflows.

---

# 1. Product Summary

useOmnis is an intent-driven financial execution agent.

A user describes a task and constraints in natural language. Omnis converts that request into a structured financial task, discovers the capabilities/services needed, spends only within the delegated budget, asks for human approval when a policy boundary is reached, executes the payment through supported infrastructure, and produces a unified proof record.

The core product promise:

> **I need this done, under these rules.**

The flagship V1 experience:

> **“Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”**

---

# 2. Goals

## 2.1 Primary goals

V1 must prove that:

1. a human can describe a financial outcome conversationally;
2. Omnis can extract a structured task;
3. a user can delegate a bounded service-spending budget;
4. the agent can discover a paid service;
5. the agent can make at least one real x402-paid service request;
6. the service result can influence the next step;
7. the final payment remains behind explicit human approval;
8. the final stablecoin payment can execute successfully;
9. the user receives one coherent proof object;
10. the entire experience is understandable without needing to understand the underlying chains.

## 2.2 Non-goals

V1 does not need enterprise treasury management, payroll, recurring subscriptions, autonomous trading, generalized DeFi execution, arbitrary chain support, arbitrary service-provider onboarding, service reputation markets, a complex marketplace UI, mobile apps, World integration, Ledger integration, production-grade ENS identity, or unrestricted autonomous agents.

---

# 3. Personas

## 3.1 Primary Persona: Crypto-native Operator

Characteristics:

- holds stablecoins;
- uses AI tools frequently;
- pays contributors, contractors, creators, or services;
- may have funds across more than one chain;
- wants less wallet/network complexity;
- values proof and visibility;
- does not want to give an AI unrestricted wallet access.

Typical jobs:

- pay a contractor;
- verify a recipient before paying;
- buy a dataset;
- pay for an API;
- fund a research task;
- set a spending cap for an agent.

## 3.2 Secondary Persona: Small Team

Characteristics:

- multiple contributors;
- stablecoin-heavy operations;
- repeated payments;
- shared need for visibility and records.

V1 may support this persona through the same single-user workflow, but does not require team roles/quorum.

---

# 4. Core User Stories

## 4.1 Pay

As a user, I want to say:

> “Pay Alex 25 USDC.”

so Omnis can prepare the payment without making me manually choose infrastructure.

Acceptance:

- recipient is resolved or requested;
- amount and asset are extracted;
- plan is shown;
- human approval is required;
- payment executes;
- receipt appears in chat.

## 4.2 Pay with pre-check

As a user, I want to say:

> “Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”

so the agent can buy useful risk information without exceeding my budget, then ask before sending the actual 50 USDC.

Acceptance:

- payment amount = 50 USDC;
- service budget = $0.05;
- recipient is extracted;
- final payment requires approval;
- agent can buy one or more approved services;
- total service spend cannot exceed $0.05;
- service result is summarized;
- final payment is enabled only after required checks;
- payment executes only after explicit approval;
- unified proof includes service spend and final payment.

## 4.3 Delegate

As a user, I want to say:

> “Research this wallet. Spend up to $0.05.”

so the agent can choose and buy useful services autonomously inside the budget.

Acceptance:

- task is created;
- total budget is persisted;
- service-level spend is visible;
- service requests are paid;
- task stops if budget would be exceeded;
- final summary includes total spend.

---

# 5. Primary User Journey

## State 0: New conversation

User sees an input field, suggested examples, and a concise value proposition.

Suggested examples:

- “Pay a contractor.”
- “Check a wallet before paying.”
- “Give an agent a research budget.”

## State 1: Intent captured

User:

> “Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”

Omnis extracts:

- task type: pay-with-check;
- recipient;
- payment amount;
- asset;
- research budget;
- purpose;
- final-payment approval requirement.

If a required field is missing, Omnis asks one concise clarification.

## State 2: Plan

Omnis shows payment amount, recipient, research budget, expected checks, and approval boundary.

User can continue, edit constraints, or cancel.

## State 3: Service discovery

Omnis searches available services and may show service name, capability, price, network/payment protocol, and why it is useful.

## State 4: Bounded service spend

Omnis selects one or more services whose combined cost fits policy.

Before each paid call, deterministic policy checks:

- task budget;
- per-service cap;
- allowed category;
- service health;
- approved network/token.

The agent performs the paid call.

## State 5: Results

Omnis displays services used, amount spent, budget remaining, and risk/output summary.

## State 6: Human approval

If final payment is allowed to proceed, Omnis shows a clear payment card with recipient, amount, settlement network, source balance, research spend, and final payment amount.

User must explicitly confirm.

## State 7: Execution

Omnis prepares the wallet action, executes settlement, and tracks confirmation.

## State 8: Proof

Omnis returns service purchases, total delegated spend, final payment status, transaction identifier, timestamps, policy snapshot, and receipt link/view.

---

# 6. Functional Requirements

## 6.1 Conversational Agent

Must:

- accept natural-language tasks;
- maintain task context;
- ask for missing required fields;
- explain decisions;
- show structured cards inside chat;
- never execute final payment solely from LLM output.

## 6.2 Intent Parser

Must output a structured task object.

```ts
type FinancialTask = {
  id: string
  type: "pay" | "pay_with_check" | "delegate"
  recipient?: string
  paymentAmount?: string
  paymentAsset?: "USDC"
  purpose?: string
  serviceBudget?: string
  perServiceCap?: string
  finalPaymentApprovalRequired: boolean
}
```

Parser output must be validated deterministically.

## 6.3 Policy Engine

Must support:

- total service budget;
- per-service cap;
- allowed service categories;
- allowed assets;
- final payment approval requirement;
- supported settlement networks;
- task status.

Policy decisions must not be delegated to the LLM.

Minimum decision outcomes:

- `ALLOW`
- `REQUIRE_APPROVAL`
- `DENY`

## 6.4 Service Directory

V1 requires at least two service entries.

```ts
type ServiceDescriptor = {
  id: string
  name: string
  description: string
  capability: string
  endpoint: string
  price: string
  currency: string
  network: string
  paymentProtocol: "x402"
  inputSchema: object
  outputSchema: object
  status: "available" | "unavailable"
}
```

The directory may initially be curated.

The flagship path must use at least one real x402-gated service.

## 6.5 Service Selection

The agent may rank services, but deterministic checks must verify:

- cost <= remaining budget;
- service category allowed;
- service is available;
- payment token/network supported.

The agent must provide a reason for service selection.

## 6.6 Machine Payment

Requirements:

- service call is genuinely paid;
- payment amount is captured;
- tx/payment identifier is captured;
- paid request result is returned;
- failed service payment cannot silently consume budget;
- successful spend is added to task ledger.

## 6.7 Human Approval

The final contractor payment requires explicit human approval.

Approval UI must show amount, recipient, source, settlement network, prior research spend, and total expected financial effect.

No final payment may occur before this confirmation.

## 6.8 Stablecoin Settlement

V1 target:

- USDC;
- Arc-centered settlement;
- Circle infrastructure where applicable;
- Privy wallet as primary user wallet experience.

Requirements:

- correct recipient;
- correct amount;
- correct network;
- transaction hash/status retained;
- confirmation state tracked;
- no accidental resubmission;
- successful payment produces receipt.

## 6.9 Proof Object

```ts
type OmnisProof = {
  taskId: string
  owner: string
  createdAt: string
  intent: object
  policy: object
  servicePurchases: Array<{
    serviceId: string
    amount: string
    paymentId?: string
    resultDigest?: string
    status: string
  }>
  finalPayment?: {
    recipient: string
    amount: string
    asset: string
    network: string
    transactionHash: string
    status: string
  }
  totalServiceSpend: string
  status: "completed" | "failed" | "cancelled"
}
```

---

# 7. Transaction and Recovery Requirements

This is a V1 architectural requirement, not a later polish item.

## 7.1 Core states

Any transaction-capable flow must model:

- `prepared`
- `awaiting_approval`
- `submitting`
- `submitted`
- `confirming`
- `confirmed`
- `confirmation_delayed`
- `reverted`
- `failed`

## 7.2 Rules

1. Once a transaction hash/payment identifier exists, it must be persisted immediately.
2. Read-only recovery must never resubmit a write.
3. Reconciliation must be idempotent.
4. A delayed confirmation is not a failed submission.
5. A confirmed receipt must override stale local pending state.
6. Repeated receipt checks must not create duplicate proof records.
7. The UI must allow recovery after refresh.

---

# 8. UX Requirements

## 8.1 Primary surface

The chat is the product home.

Suggested navigation:

- Home
- Activity
- Agents
- Services
- Wallet

## 8.2 Chat cards

The conversation may render structured cards for:

- task plan;
- budget;
- discovered services;
- spend event;
- result;
- approval request;
- payment progress;
- receipt.

## 8.3 Principles

- no chain-heavy dashboard as the default;
- avoid jargon unless expanded;
- always show money clearly;
- keep approval boundaries obvious;
- show why the agent spent money;
- show remaining budget;
- never hide proof;
- expose technical details only when requested.

---

# 9. Sponsor / Infrastructure Requirements

## 9.1 Arc + Circle

Target uses:

- Arc as primary settlement/treasury home;
- USDC settlement;
- App Kit where appropriate;
- Agent Stack where useful;
- Circle infrastructure for cross-chain movement;
- nanopayment capability where it belongs.

## 9.2 Hedera

Target uses:

- live x402-gated service;
- Blocky402 facilitator;
- at least one real paid request;
- service discovery via Omnis directory;
- machine-to-service payment auditability.

## 9.3 Privy

Target uses:

- authentication;
- at least one Privy-created/managed wallet;
- human wallet action;
- policy/signer features where they strengthen the product;
- simplified financial UX.

## 9.4 Optional sponsor layers

Not V1 dependencies:

- ENSv2;
- World;
- Ledger;
- Bazantic;
- Chainlink;
- 1inch.

---

# 10. Success Metrics for Hackathon V1

A successful V1 must demonstrate:

1. one natural-language task;
2. one explicit delegated budget;
3. service discovery;
4. one real x402-paid service call;
5. budget enforcement;
6. agent result synthesis;
7. final human approval;
8. one real USDC settlement;
9. one complete proof object;
10. a demo where the user never manually coordinates underlying infrastructure.

---

# 11. Demo Acceptance Criteria

The flagship demo passes only if:

- a new user can understand the job in < 30 seconds;
- the service budget cannot be exceeded;
- the agent buys at least one service;
- the final payment cannot happen without approval;
- the USDC payment confirms;
- the proof object contains both service spending and final payment;
- the app remains recoverable if a confirmation is delayed;
- the same task cannot accidentally double-pay;
- the UI clearly distinguishes delegated spend from the final payment.

---

# 12. North-Star Statement

> **Give Omnis the task, the budget, and the rules. It handles the spending while you keep control.**
