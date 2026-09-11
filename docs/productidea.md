# useOmnis: Product Idea

**Status:** Locked V1 product direction  
**Project:** useOmnis  
**Hackathon:** ETHOnline 2026  
**Category:** Agentic payments / stablecoin execution / machine commerce  
**Tagline:** **Tell Omnis what needs to get paid. It handles the rest.**

---

## 1. Product Thesis

**useOmnis turns financial intent into controlled, completed, and provable action.**

The user tells Omnis what needs to get done and under what rules. Omnis figures out the wallets, services, payment rails, settlement path, approvals, and proof required to complete it.

The core shift is:

> From **“I need to figure out how to do this.”**  
> To **“I need this done, under these rules.”**

Cross-chain routing is a capability inside useOmnis. It is not the product.

Wallets are infrastructure. Bridges are infrastructure. x402 is infrastructure. Arc, Hedera, Privy, and Circle are infrastructure.

The product is the **financial execution agent** that coordinates them.

---

## 2. Who It Is For

### Primary target user

> **Crypto-native individuals and small teams who hold stablecoins, use AI to get work done, and increasingly need payments to happen as part of those workflows.**

Examples include:

- solo builders;
- small startups;
- DAO/core contributors;
- researchers;
- creators;
- operators;
- developer teams.

The common behavior is more important than the job title:

1. They already use AI for work.
2. They already hold or receive stablecoins.
3. Their work increasingly includes payments, paid services, contributor payouts, research purchases, or other financial execution.

---

## 3. What Job Does useOmnis Do?

### Core job-to-be-done

> **When I need a financial task completed, I want to describe the outcome and constraints instead of manually coordinating wallets, networks, services, and payments, so I can get it done correctly while remaining in control of how my money is used.**

### Functional job

Turn an intent such as:

> “Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”

into:

- a structured task;
- an explicit research/service budget;
- service discovery;
- paid machine-to-machine calls;
- a decision;
- a human approval boundary;
- stablecoin settlement;
- one proof object.

### Emotional job

Replace:

> “I hope I didn’t mess something up.”

with:

> “I told Omnis what I wanted, saw what it planned to do, it stayed within my rules, and now I have proof.”

---

## 4. The Product Wedge

The broad company vision is:

> **Financial execution for humans and agents.**

The first product wedge is:

> **Controlled economic delegation.**

A user gives an agent:

- a task;
- a budget;
- rules;
- allowed capabilities;
- approval thresholds.

The agent can act autonomously **inside the economic sandbox**.

It must ask the human before crossing a boundary.

A simpler external phrase is:

> **Bounded financial agency.**

Formula:

**Task + Budget + Rules + Agent = Bounded financial agency**

---

## 5. Core Product Experiences

### A. Pay

For direct financial actions.

Examples:

- “Pay Alex 25 USDC.”
- “Send 50 USDC to alice.eth.”
- “Pay this contractor, but verify the wallet first.”
- “Settle this invoice.”

Omnis handles recipient resolution, funding source, supported settlement path, approval requirements, execution, and proof.

### B. Delegate

For tasks where an AI agent may need to spend money to finish the work.

Examples:

- “Research this wallet. Spend up to $0.05.”
- “Give my research agent a $5 budget for today.”
- “Find the cheapest service that can extract this document and use it.”
- “Spend up to $1 on data to complete this research.”

Omnis handles service discovery, capability matching, price comparison, budget enforcement, paid requests, service result consumption, approval escalation, spend tracking, and proof.

---

## 6. Flagship ETHOnline Scenario

The flagship V1 demo is intentionally narrow:

> **“Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”**

### Why this scenario

It demonstrates, in one flow:

- natural-language intent;
- structured task extraction;
- bounded agent spending;
- paid service discovery;
- x402 machine commerce;
- agent reasoning over purchased results;
- human approval;
- stablecoin settlement;
- proof and auditability.

It is specific enough for a judge to understand in seconds.

### Before useOmnis

A crypto-native operator may need to:

1. receive the contractor wallet;
2. open an explorer or risk tool;
3. find a risk-data source;
4. create an API account or buy credits;
5. run the check;
6. interpret the result;
7. check where their USDC is;
8. determine the correct settlement path;
9. switch wallets/networks;
10. execute the payment;
11. confirm settlement;
12. collect the transaction hash;
13. send proof.

### After useOmnis

The user says:

> “Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.”

Omnis coordinates the rest.

---

## 7. Why It Is Better Than ChatGPT + a Wallet

ChatGPT can understand the task.

A wallet can submit a transaction.

But neither one alone provides:

- structured financial intent;
- explicit spending constraints;
- paid capability discovery;
- autonomous service purchases;
- budget enforcement;
- permission boundaries;
- human approval escalation;
- settlement execution;
- unified proof.

useOmnis combines the conversational interface with a deterministic financial execution system.

The **chat is the interface**.

The **policy + execution system is the product**.

---

## 8. Core System Philosophy

### The agent may

- interpret user intent;
- ask clarifying questions;
- discover services;
- compare price and capability;
- recommend a plan;
- purchase services within policy;
- synthesize service results;
- explain progress;
- request approval.

### The deterministic system must control

- budget enforcement;
- allowed assets;
- permitted recipients;
- per-service limits;
- approval thresholds;
- wallet authorization;
- supported chains;
- execution parameters;
- settlement;
- transaction state;
- receipt creation.

The LLM should never have unrestricted authority to move funds.

---

## 9. Infrastructure Roles

### Privy: Human / Wallet Layer

Privy is intended to provide authentication, embedded self-custodial wallets, external-wallet support where useful, signer/policy infrastructure, and a cleaner UX than manual wallet-provider orchestration.

### Arc + Circle: Financial Home

Arc is intended to be the primary settlement and treasury layer.

Circle infrastructure may power USDC movement, App Kit, Agent Stack, Unified Balance, bridging, nanopayments, cross-chain funding, and agent wallets.

Arc should feel like the financial home, not “just another chain.”

### Hedera: Machine Commerce Layer

Hedera powers machine-to-service payments.

The useOmnis agent can discover x402-gated services, compare them, pay for them, consume the output, and remain inside the delegated budget.

The flagship implementation can use a small service directory with real x402-paid services.

---

## 10. Optional / Later Layers

### ENSv2

Potential future roles:

- human-readable recipients;
- agent identity;
- agent/service namespaces;
- permissioned records.

Examples: `alice.eth`, `research.useomnis.eth`, `risk.useomnis.eth`.

### World

Potential use: human-backed agent authorization, anti-abuse, and access/rate-limit signals.

### Ledger

Potential use: hardware approval for high-risk spending and escalation thresholds.

These are not V1 dependencies.

---

## 11. What useOmnis Is Not

useOmnis is not primarily a wallet, bridge, AI chatbot, x402 marketplace, DeFi terminal, chain dashboard, Arc frontend, or Hedera frontend.

Those are implementation layers or capabilities.

useOmnis is:

> **The orchestration layer between financial intent and financial completion.**

---

## 12. V1 Success Test

A first-time user should be able to complete one task and say:

> “I give the agent a task and a spending limit. It can pay for what it needs, but it asks me before doing anything outside the rules.”

If the user instead says:

> “It’s an AI crypto wallet.”

the framing is not clear enough.

---

## 13. Product Principles

1. Outcome first, infrastructure second.
2. The agent gets bounded authority, never unrestricted authority.
3. Every meaningful spend has a reason.
4. Every irreversible action has an explicit policy path.
5. Every execution can be proven afterward.
6. Cross-chain is invisible unless the user asks to inspect it.
7. The flagship flow stays narrow even if the architecture is extensible.
8. Sponsor technology must enable a core product behavior, not decorate it.
9. The chat is the primary interaction surface.
10. Failure and recovery are product states, not implementation details.

---

## 14. One-Sentence Pitch

> **useOmnis lets you give an AI agent a financial task, a spending limit, and rules, so it can buy what it needs, ask when approval is required, complete the payment, and keep the proof.**

## 15. Short Pitch

> **Tell Omnis what needs to get paid. It handles the rest.**
