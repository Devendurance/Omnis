# useOmnis: Project Plan

**Project:** useOmnis  
**Hackathon:** ETHOnline 2026  
**Build style:** New repo, new brand, from scratch  
**Primary goal:** Ship one memorable, fully working bounded-financial-agency flow before expanding sponsor integrations.

---

# 1. Build Strategy

The project should be built around one flagship user journey first:

> **“Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”**

This flow must work end-to-end before secondary features are added.

The build should optimize for:

1. specificity;
2. reliability;
3. visible sponsor value;
4. demo clarity;
5. idempotent payment execution;
6. recoverability;
7. one memorable product behavior.

---

# 2. Build Priorities

## P0: Foundation

Goal: Create a clean repo and deterministic domain model before wallet or payment writes.

Deliverables:

- new useOmnis repo;
- Next.js + TypeScript;
- linting;
- test runner;
- environment validation;
- domain types;
- task state machine;
- transaction state machine;
- policy engine skeleton;
- service registry schema;
- proof schema;
- no live payment execution yet.

Exit criteria:

- tests pass;
- task states are deterministic;
- policy unit tests exist;
- no financial write can happen from raw LLM output.

---

## P1: Conversational Task Layer

Goal: Make the chat the primary interface.

Deliverables:

- home = chat;
- natural-language task input;
- structured task extraction;
- schema validation;
- clarification flow for missing recipient/amount/budget;
- task-plan card;
- budget card;
- chat persistence.

Example supported tasks:

- `Pay 50 USDC to 0x...`
- `Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.`
- `Research this wallet. Spend up to $0.05.`

Exit criteria:

- flagship prompt becomes a deterministic FinancialTask;
- missing fields trigger concise clarification;
- no payment happens yet.

---

## P2: Policy + Budget Engine

Goal: Implement bounded financial agency before service purchases.

Deliverables:

- total service budget;
- per-service cap;
- allowed service categories;
- final-payment approval requirement;
- `ALLOW / REQUIRE_APPROVAL / DENY`;
- budget ledger;
- decimal-safe spend accounting;
- tests for over-budget attempts.

Critical tests:

- service price below budget → allowed;
- service price above remaining budget → denied;
- final 50 USDC payment → requires approval;
- repeated service result cannot double-charge ledger.

Exit criteria:

- agent cannot bypass budget via prompt behavior;
- policy enforcement is server-side/deterministic.

---

## P3: Service Directory

Goal: Give the agent real paid capabilities.

Deliverables:

- curated service registry;
- at least two service descriptors;
- service search;
- service inspection;
- price/capability metadata;
- health/availability state;
- optional `/.well-known/x402` or equivalent discovery endpoint.

Suggested first capabilities:

- wallet risk score;
- wallet activity/transaction summary.

Exit criteria:

- agent can find at least two valid candidates;
- UI can explain why a service was selected.

---

## P4: Hedera x402 Machine Commerce

Goal: Complete at least one real paid service request end-to-end.

Deliverables:

- Blocky402 integration;
- x402 payment challenge handling;
- Hedera testnet settlement;
- successful paid request;
- payment identifier persisted;
- result captured;
- service spend added to task ledger;
- failure states;
- read-only reconciliation.

Optional enhancement:

- two real x402 services so the agent can compare and choose.

Exit criteria:

- real paid request proven;
- no API key/subscription required for the user flow;
- spend appears in chat;
- total budget updates correctly.

---

## P5: Privy Wallet Layer

Goal: Create the primary human wallet experience.

Deliverables:

- authentication;
- Privy wallet creation/use;
- wallet state page;
- Arc network support;
- USDC balance display;
- funding guidance;
- external wallet support only if needed.

Optional:

- policy/signer controls where they strengthen the V1 story.

Exit criteria:

- user can sign in;
- wallet exists;
- wallet can participate in final payment flow;
- no manual provider juggling is needed in the flagship path.

---

## P6: Arc + Circle Settlement

Goal: Execute the final human-approved USDC payment.

Deliverables:

- Arc-centered settlement adapter;
- Circle integration selected for V1;
- settlement plan;
- approval card;
- explicit user confirmation;
- transaction submission;
- immediate tx hash persistence;
- confirmation reconciliation;
- confirmation-delayed state;
- read-only retry;
- final confirmed payment.

Decision to make before coding this phase:

Choose the smallest Circle surface that reliably completes the flagship payment. Avoid integrating every Circle product just because it exists.

Exit criteria:

- final payment executes once;
- no duplicate send on retry;
- confirmed status survives refresh.

---

## P7: Unified Proof / Activity

Goal: Make the whole task auditable.

Deliverables:

- canonical proof object;
- service purchases;
- delegated spend total;
- agent summary;
- approval record;
- final transaction;
- timestamps;
- receipt view;
- Activity page.

Exit criteria:

- one task = one canonical receipt;
- repeated checks do not duplicate receipts;
- receipt survives refresh/session.

---

## P8: Flagship Flow Integration

Goal: Connect P1–P7 into one seamless conversation.

Target flow:

1. user submits flagship prompt;
2. Omnis extracts task;
3. Omnis shows plan;
4. Omnis discovers services;
5. policy allows bounded spend;
6. Omnis buys risk service;
7. Omnis summarizes result;
8. Omnis asks for final payment approval;
9. user approves;
10. Arc USDC payment executes;
11. status reconciles;
12. receipt appears in chat.

Exit criteria:

- entire flow works from a clean session;
- no developer console/manual intervention;
- no fake transaction state;
- every spend is real or clearly labeled simulated.

---

# 3. Secondary Feature Order

Only after the flagship flow is stable:

## S1: Second Service

Add another paid service and let the agent select/compose.

## S2: Cross-chain Funding

Allow Omnis to fund Arc settlement from a supported external chain through Circle/App Kit.

Keep chain complexity behind the UI.

## S3: Agents Page

Show active delegated budgets, remaining spend, task history, and permissions.

## S4: Services Page

Show available paid capabilities, price, network, payment protocol, and health.

## S5: ENSv2

Add recipient/agent identity only if core flow is stable.

## S6: Additional Sponsor Extensions

Potential:

- World;
- Ledger;
- Bazantic;
- Chainlink.

Do not add these if they weaken the core demo.

---

# 4. Explicit Non-Goals Before Submission

Do not build before the flagship path is stable:

- general-purpose DeFi execution;
- arbitrary swaps;
- autonomous trading;
- payroll;
- full team permissions;
- mobile;
- huge marketplace;
- ten chains;
- arbitrary smart-contract execution;
- recursive agent swarms;
- complicated multi-agent negotiation;
- elaborate onchain identity;
- enterprise accounting.

---

# 5. Engineering Guardrails

## 5.1 Payment writes

Every payment write must:

1. persist intent;
2. pass policy;
3. pass validation;
4. capture approval where required;
5. submit once;
6. persist identifier immediately;
7. reconcile read-only.

## 5.2 Retry rule

After a transaction/payment identifier exists:

> **Retry means read again, not submit again.**

## 5.3 Receipt rule

Receipt finalization must be idempotent.

## 5.4 LLM rule

LLM output is never trusted as transaction truth.

## 5.5 Scope rule

Do not add an integration unless it improves the flagship job, a sponsor qualification, reliability, proof, or demo clarity.

---

# 6. Test Plan

## P0–P2

Unit tests:

- task parsing;
- policy decisions;
- budget arithmetic;
- state transitions.

## P3–P4

Integration tests:

- service discovery;
- x402 challenge;
- paid request;
- service spend ledger;
- service failure;
- retry behavior.

## P5–P6

Integration tests:

- wallet session;
- settlement preparation;
- approval;
- submission;
- confirmation;
- delayed confirmation;
- confirmed revert;
- no duplicate write.

## P7–P8

End-to-end tests:

- full flagship flow;
- refresh during pending service payment;
- refresh during pending final payment;
- repeated status checks;
- receipt idempotency.

---

# 7. Demo Plan

The demo should be < 5 minutes and show the product before architecture.

## 0:00–0:30: Problem

“I’m a crypto-native operator. I need to pay a contractor, but I want to verify the destination wallet first. Today I’d have to find the service, pay for it, interpret it, then manage the actual stablecoin payment.”

## 0:30–1:00: Task

Type:

> “Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”

## 1:00–2:00: Agent budget + service discovery

Show extracted task, $0.05 budget, discovered x402 service, and real paid request.

## 2:00–2:45: Result

Show service output, amount spent, and budget remaining.

## 2:45–3:30: Approval

Show final 50 USDC payment and human approval boundary.

## 3:30–4:15: Settlement

Execute the Arc USDC payment.

## 4:15–4:45: Proof

Show service purchase, delegated spend, approval, final transaction, and receipt.

## 4:45–5:00: Architecture / sponsor summary

Explain:

- Privy = human/wallet layer;
- Hedera = machine-commerce layer;
- Arc/Circle = settlement layer;
- Omnis = orchestration and bounded financial agency.

---

# 8. Submission Checklist

Before submission:

- [ ] public GitHub repo;
- [ ] clear README;
- [ ] architecture diagram;
- [ ] setup instructions;
- [ ] environment variable template;
- [ ] real x402 payment proof;
- [ ] real USDC settlement proof;
- [ ] sponsor-specific sections;
- [ ] demo video;
- [ ] live deployment;
- [ ] screenshots;
- [ ] tests passing;
- [ ] no exposed secrets;
- [ ] no fake live states;
- [ ] no duplicate transaction risks;
- [ ] clear distinction between implemented vs planned features.

---

# 9. Definition of Done

V1 is done when a new user can:

1. sign in;
2. type the flagship task;
3. see Omnis understand it;
4. give the agent a bounded service budget;
5. watch the agent pay for a useful service;
6. see the result affect the plan;
7. approve the final stablecoin payment;
8. see the payment confirm;
9. open one proof record showing the complete financial story.

Anything else is secondary until this works reliably.
