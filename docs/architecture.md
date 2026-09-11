# useOmnis: Architecture

**Version:** V1 / ETHOnline 2026  
**Status:** Proposed implementation architecture  
**Architecture principle:** Agent reasoning is flexible; financial authority is deterministic.

---

# 1. System Overview

useOmnis is an intent-driven financial execution system with an interactive agent chat as its primary interface.

The architecture separates:

1. conversation and reasoning;
2. structured task state;
3. financial policy;
4. service discovery;
5. machine payments;
6. human approvals;
7. stablecoin settlement;
8. proof and recovery.

High-level flow:

```text
User
  ↓
Interactive Agent Chat
  ↓
Intent Parser
  ↓
Structured Financial Task
  ↓
Policy Engine
  ↓
Execution Planner
  ├── Service Discovery
  ├── x402 Machine Payments
  └── Stablecoin Settlement
  ↓
Proof / Activity Ledger
```

---

# 2. Core Architectural Rule

The LLM may interpret, reason, choose among policy-valid options, explain, ask, and summarize.

The LLM may not independently control:

- budgets;
- final recipients;
- transaction parameters;
- approval thresholds;
- wallet writes;
- chain IDs;
- token addresses;
- transaction recovery;
- receipt finalization.

All irreversible financial actions must pass deterministic validation.

---

# 3. Proposed Modules

```text
src/
  app/
    (auth)/
    app/
      page.tsx
      activity/
      agents/
      services/
      wallet/
    api/
      agent/
      tasks/
      services/
      payments/
      receipts/

  components/
    chat/
    cards/
    wallet/
    receipts/

  lib/
    agent/
      prompts/
      tools/
      runtime/
      schemas/

    intent/
      parser.ts
      schema.ts
      validators.ts

    tasks/
      store.ts
      state-machine.ts
      types.ts

    policy/
      engine.ts
      rules.ts
      types.ts

    services/
      registry.ts
      discovery.ts
      selectors.ts
      types.ts

    providers/
      hedera-x402/
      circle/
      privy/

    settlement/
      planner.ts
      execution.ts
      reconciliation.ts
      types.ts

    receipts/
      builder.ts
      store.ts
      idempotency.ts

    persistence/
      db.ts
      migrations/

    config/
      networks.ts
      assets.ts
      env.ts
```

Exact folder names may change, but the separation of responsibilities should remain.

---

# 4. Domain Model

## 4.1 FinancialTask

```ts
type FinancialTask = {
  id: string
  ownerId: string

  type:
    | "pay"
    | "pay_with_check"
    | "delegate"

  status:
    | "draft"
    | "planned"
    | "running"
    | "awaiting_approval"
    | "settling"
    | "completed"
    | "failed"
    | "cancelled"

  recipient?: string
  paymentAmount?: string
  paymentAsset?: "USDC"
  purpose?: string

  serviceBudget?: string
  perServiceCap?: string

  finalPaymentApprovalRequired: boolean

  createdAt: string
  updatedAt: string
}
```

## 4.2 TaskPolicy

```ts
type TaskPolicy = {
  taskId: string
  maxServiceSpend?: string
  maxPerService?: string
  allowedServiceCategories?: string[]
  allowedAssets: string[]
  allowedNetworks: string[]
  finalPaymentApprovalRequired: boolean
}
```

## 4.3 ServiceDescriptor

```ts
type ServiceDescriptor = {
  id: string
  name: string
  capability: string
  description: string
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

## 4.4 ServicePurchase

```ts
type ServicePurchase = {
  id: string
  taskId: string
  serviceId: string
  quotedAmount: string
  paidAmount?: string
  paymentIdentifier?: string
  status:
    | "quoted"
    | "approved"
    | "paying"
    | "paid"
    | "failed"
  resultDigest?: string
  createdAt: string
}
```

## 4.5 SettlementExecution

```ts
type SettlementExecution = {
  id: string
  taskId: string
  provider: "circle"
  asset: "USDC"
  amount: string
  recipient: string
  network: string

  status:
    | "prepared"
    | "awaiting_approval"
    | "submitting"
    | "submitted"
    | "confirming"
    | "confirmed"
    | "confirmation_delayed"
    | "reverted"
    | "failed"

  transactionHash?: string
  errorCode?: string
  createdAt: string
  updatedAt: string
}
```

---

# 5. Agent Layer

## 5.1 Responsibilities

The agent should:

- understand natural-language tasks;
- identify missing fields;
- propose a plan;
- search discoverable services;
- rank candidate services;
- explain spend decisions;
- summarize purchased outputs;
- decide whether further service calls are useful;
- ask for approval when policy requires it.

## 5.2 Tool boundary

The agent receives constrained tools such as:

```text
create_task
update_task
list_services
inspect_service
request_service_purchase
get_task_budget
request_final_payment_approval
prepare_settlement
get_task_receipt
```

The agent should not receive raw private keys or unrestricted transaction APIs.

---

# 6. Intent Layer

The intent parser converts user language into structured fields.

Example input:

> “Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”

Example output:

```json
{
  "type": "pay_with_check",
  "paymentAmount": "50",
  "paymentAsset": "USDC",
  "serviceBudget": "0.05",
  "purpose": "contractor payment",
  "finalPaymentApprovalRequired": true
}
```

Recipient is requested if missing.

All parser output must be schema-validated.

---

# 7. Policy Engine

The policy engine is deterministic.

Inputs:

- task;
- user constraints;
- requested action;
- remaining budget;
- service price;
- service category;
- settlement amount.

Outputs:

- `ALLOW`
- `REQUIRE_APPROVAL`
- `DENY`

Example:

```text
Agent wants to buy risk API for $0.003
Remaining task budget = $0.05
Per-service cap = $0.01
Category = wallet-risk

→ ALLOW
```

Example:

```text
Agent wants to send final 50 USDC payment
Final payment approval required = true

→ REQUIRE_APPROVAL
```

---

# 8. Service Discovery Layer

V1 may use a curated service registry.

Minimum:

- two services;
- at least one genuinely x402-gated;
- enough metadata for price/capability comparison.

The registry must be queryable by:

- capability;
- price;
- availability;
- network;
- payment protocol.

Potential public endpoint:

```text
GET /api/services
GET /api/services/:id
GET /.well-known/x402
```

This also makes useOmnis service discovery inspectable by other agents.

---

# 9. Hedera x402 Provider

Purpose:

> Machine-to-service micropayments.

Responsibilities:

- receive service quote/challenge;
- construct supported payment payload;
- settle through Blocky402;
- retry the paid request;
- capture payment identifier;
- return service response;
- write spend event to task ledger.

V1 requirement:

- one real service call paid end-to-end;
- ideally two service options for agent selection.

No payment is attempted unless policy authorizes it.

---

# 10. Privy Layer

Purpose:

> Human identity and wallet UX.

Responsibilities may include:

- user sign-in;
- wallet creation;
- wallet retrieval;
- wallet funding state;
- wallet actions;
- scoped policies/signers where useful.

Principle:

The user should not have to manually manage chain-provider details for the flagship happy path.

---

# 11. Arc + Circle Settlement Layer

Purpose:

> Final USDC settlement and financial home.

Core responsibilities:

- determine supported source/settlement path;
- prepare final payment;
- request human approval;
- submit;
- persist transaction identifier;
- reconcile confirmation;
- return proof.

Arc should be treated as primary settlement/treasury infrastructure.

Circle integrations may include:

- App Kit;
- Agent Stack;
- CCTP;
- Gateway;
- Unified Balance;
- nanopayments.

Only integrations that directly serve V1 should be included in the first build.

---

# 12. Settlement Planner

The planner should produce a deterministic execution plan.

```ts
type SettlementPlan = {
  taskId: string
  asset: "USDC"
  amount: string
  recipient: string
  sourceNetwork: string
  destinationNetwork: string
  provider: "circle"
  approvalRequired: true
}
```

The agent can explain the plan but must not modify contract/network parameters outside validated provider configuration.

---

# 13. Approval Architecture

Approval is a distinct state transition.

```text
Task ready
  ↓
Settlement plan created
  ↓
awaiting_approval
  ↓
User explicitly confirms
  ↓
approval record persisted
  ↓
transaction submission allowed
```

Approval record should include:

- task ID;
- user/wallet;
- amount;
- asset;
- recipient;
- network;
- timestamp;
- policy snapshot.

---

# 14. Transaction State Machine

Every write follows:

```text
prepared
  ↓
awaiting_approval
  ↓
submitting
  ↓
submitted
  ↓
confirming
  ├── confirmed
  ├── confirmation_delayed
  ├── reverted
  └── failed
```

Important:

- `submitted` means a transaction identifier exists;
- `confirmation_delayed` is recoverable;
- no automatic resubmission after a hash exists;
- refresh should restore execution state.

---

# 15. Read-Only Recovery

Recovery endpoints/functions must only:

- fetch transaction status;
- fetch receipt;
- reconcile against known task state;
- finalize proof if confirmed.

They must never:

- submit a second payment;
- construct a new authorization;
- mutate amount/recipient;
- repeat a service purchase.

Example helpers:

```text
checkSettlementStatus(hash)
checkServicePaymentStatus(paymentId)
reconcileTask(taskId)
```

---

# 16. Proof / Receipt Layer

The proof object is the durable end state.

It should include:

- original intent;
- policy snapshot;
- service purchases;
- service spend;
- agent-selected reasoning summary;
- human approval;
- final payment;
- transaction identifiers;
- timestamps;
- task status.

Receipt creation must be idempotent.

A confirmed task must map to one canonical receipt.

---

# 17. Persistence

Recommended V1 persistence:

- users;
- wallets;
- tasks;
- task policies;
- service purchases;
- settlement executions;
- approvals;
- receipts.

Suggested relational model:

```text
users
  └── tasks
        ├── task_policies
        ├── service_purchases
        ├── approvals
        ├── settlement_executions
        └── receipts
```

The exact database provider may be selected during implementation.

---

# 18. Security Principles

1. Never expose private keys to the LLM.
2. Never allow the LLM to choose arbitrary contract addresses.
3. Validate all amounts with decimal-safe arithmetic.
4. Validate recipients before execution.
5. Enforce budget server-side.
6. Enforce final approval server-side.
7. Persist transaction IDs before waiting for confirmation.
8. Make retries read-only.
9. Protect API routes against replay where relevant.
10. Make receipt finalization idempotent.
11. Keep service result data separate from trusted payment truth.
12. Never interpret an LLM statement as proof of settlement.

---

# 19. V1 Sequence Diagram

```text
User
 │
 │ "Pay contractor 50 USDC,
 │ check wallet, budget $0.05"
 ▼
Chat Agent
 │
 ▼
Intent Parser
 │
 ▼
Task + Policy
 │
 ▼
Service Discovery
 │
 ├── finds Risk API A ($0.003)
 └── finds Risk API B ($0.004)
 │
 ▼
Policy Engine
 │ ALLOW
 ▼
Hedera x402 Provider
 │
 ├── paid request
 └── result
 │
 ▼
Agent
 │ summarizes risk
 ▼
Settlement Planner
 │
 ▼
Policy Engine
 │ REQUIRE_APPROVAL
 ▼
User
 │ Confirm 50 USDC
 ▼
Privy Wallet
 │
 ▼
Circle / Arc Settlement
 │
 ▼
Confirmation Reconciler
 │
 ▼
Proof Builder
 │
 ▼
Chat Receipt
```

---

# 20. V1 Architecture Acceptance Criteria

The architecture is ready for implementation only if:

- LLM and financial authority are clearly separated;
- service-spend budget is enforceable outside the LLM;
- final payment is impossible without explicit approval;
- transaction IDs are durable immediately after submission;
- retries cannot double-submit;
- service purchase and final payment share one task ledger;
- receipt creation is idempotent;
- the flagship flow can complete without exposing chain complexity to the user.
