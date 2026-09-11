# useOmnis

One-sentence pitch: tell Omnis what needs to get paid, it handles the rest, inside a visible bounded mandate that ends in proof.

## What useOmnis is

useOmnis is a bounded financial execution agent. A user states a payment task in plain language. The agent parses it into a structured task, enforces a deterministic policy, discovers and purchases a machine service over x402 on Hedera, presents evidence, pauses for human approval, settles USDC on Arc Testnet through a Privy embedded wallet, reconciles onchain, and finalizes an OmnisProof bundle. The agent reasons flexibly; financial authority stays deterministic.

## The problem

AI agents can chat about money but cannot be trusted with it: open-ended wallets, hidden spend, silent retries after ambiguous payment outcomes, and no verifiable record of what moved, why, and who approved it. useOmnis makes every financial step explicit, capped, approved, and provable.

## Flagship flow

Mandate: "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking."

1. intent: composer parses the mandate into a structured task with recipient, 50 USDC amount, and service budget.
2. deterministic policy: P2 policy caps service spend and requires approval for the final payment. The 50 USDC mandate itself is never auto-executed.
3. service discovery: the agent selects the live wallet-activity service from `/api/services`.
4. Hedera x402 purchase: explicit `start wallet check` settles one $0.003 HTS USDC payment (token 0.0.429274) through Blocky402 on hedera:testnet. No retries after signing if the outcome is ambiguous.
5. evidence: observed wallet activity plus heuristic flags, with remaining budget shown.
6. human approval: the owner reviews exact amount, recipient, asset, and policy threshold, then approves.
7. Privy embedded wallet: the primaryExecutionWallet switches to Arc Testnet and signs.
8. Arc USDC settlement: 0.01 USDC test transfer of the USDC contract settles and reconciles onchain.
9. reconciliation and OmnisProof: the proof bundle links intent, plan, policy, service purchase, approval, settlement, and timestamp.

## Architecture diagram

```text
intent
-> deterministic policy (P2 caps, approval thresholds, owner isolation)
-> service discovery (/api/services registry)
-> Hedera x402/Blocky402 service purchase ($0.003 HTS USDC 0.0.429274)
-> evidence (observations, flags, remaining budget)
-> human approval (exact amount, recipient, asset)
-> Privy embedded wallet (primaryExecutionWallet, Arc Testnet switch)
-> Arc USDC settlement (testnet 5042002, USDC 0x3600...0000)
-> reconciliation (receipt and log verification, no resubmission)
-> OmnisProof (intent, plan, policy, purchase, approval, settlement)
```

Key modules: `src/lib/intent`, `src/lib/domain` (policy, tasks, settlement state machines, receipts), `src/lib/services` (registry, discovery, hedera-x402 payer, server guards), `src/lib/settlement` (Arc/Circle adapter, final service, reconciliation), `src/lib/auth` (Privy client and server verifier), `src/app/api` (services, tasks, dev routes).

## Why Hedera

The machine-economy leg runs on Hedera testnet over x402 v2 exact payments, facilitated by Blocky402. The paid wallet-activity service costs $0.003 in HTS USDC (token 0.0.429274). The payer validates the exact scheme, network, asset, service account, advertised fee payer, timeout, and atomic price before signing once, and never retries after signing when the outcome is unknown. Live evidence: Hedera payment identifier `0.0.7162784@1788995118.130839662`.

## Why Arc

Final settlement runs on Arc Testnet (chain ID 5042002) as a plain ERC-20 USDC transfer of contract `0x3600000000000000000000000000000000000000`. Reconciliation verifies the receipt status, transfer log topics, and 10,000 atomic units (0.01 USDC) before marking confirmation. Resubmission of an observed hash is forbidden. Live evidence: transaction `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d` in block `61303876`.

## Why Privy

Privy provides authentication and the embedded primaryExecutionWallet. Server routes verify the Privy access token and bind every task, settlement, approval, and proof to the token subject; a client-supplied owner that mismatches is rejected with 403. The client switches the embedded wallet to Arc Testnet before signing, never substitutes an external wallet for execution, and the server secret never leaves the server. Live evidence: the confirmed Arc transfer was wallet-approved by the task owner.

## Live transaction evidence

- Hedera x402 service payment: `0.0.7162784@1788995118.130839662`, $0.003 HTS USDC 0.0.429274, x402 v2 exact on hedera:testnet via Blocky402.
- Arc Testnet settlement: `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`, block `61303876`, 0.01 USDC test transfer on chain 5042002.
- Full per-sponsor map: `docs/submission-evidence.md`.

## Setup

```sh
npm ci
```

Copy the required public variables and create a local env file (values stay local, never commit):

```sh
cp .env.local.example .env.local
```

See Environment variables below for the full list.

## Environment variables

Public (safe for the browser bundle):

- `NEXT_PUBLIC_PRIVY_APP_ID`: Privy application ID.
- `NEXT_PUBLIC_ENABLE_P6B_TEST_MODE`: exposes the 0.01 USDC test-mode toggle in the client. Server authorization still required.

Server-only (never use a `NEXT_PUBLIC_` prefix, never commit values):

- `HEDERA_TESTNET_PAYER_ACCOUNT_ID`: Hedera testnet payer account for the $0.003 service payment.
- `HEDERA_TESTNET_PAYER_PRIVATE_KEY`: ECDSA key for the payer. Stays in `server-only` modules.
- `HEDERA_X402_SERVICE_ACCOUNT_ID`: receiver account paid by the x402 flow.
- `BLOCKY402_TESTNET_URL`: must be the hosted Blocky402 testnet facilitator.
- `OMNIS_P4A_SPIKE_TOKEN`: caller secret for the dev-only x402 entrypoint. Disabled in production.
- `PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `PRIVY_VERIFICATION_KEY`: server-side Privy verification.
- `ENABLE_P6B_TEST_MODE`: authorizes P6B test mode on a hosted deployment. Without it, test-mode requests get 403.
- `OMNIS_DEMO_PURCHASES_ENABLED`: set to `true` to allow live service purchases in production for allowlisted judges.
- `OMNIS_DEMO_ALLOWLIST`: comma-separated Privy subject DIDs permitted to trigger demo purchases.
- `OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT`: per-judge purchase cap, default 3, hard max 10.
- `OMNIS_PUBLIC_ORIGIN`: bare https origin of the deployment, used to allowlist the hosted x402 endpoint.
- `ARC_TESTNET_FALLBACK_API_URL` / `ARC_TESTNET_RPC_FALLBACK_URL`: optional Arc endpoints.
- `OMNIS_ALLOW_MOCK_AUTH`: test and local development only. Mock tokens are rejected in production unless this is explicitly `true`; a missing `PRIVY_APP_SECRET` never enables them in production.

## Local development

```sh
npm run dev
```

Open `http://localhost:3000` for the story page and `http://localhost:3000/app` for the workspace. Discovery works without secrets; the live wallet-activity descriptor appears only when the server Hedera variables are valid. P4B purchases require an authenticated Privy session and an explicit `start wallet check`. The final contractor payment is approval-only and never sent by this flow. The dev-only paid x402 entrypoint requires `OMNIS_P4A_SPIKE_TOKEN` and is disabled in production.

## Test commands

```sh
npm run lint
npm run typecheck
npm run build
npx playwright install chromium
npx playwright test
npm run check:no-em-dash
```
Focused suites: `npx playwright test tests/p8a-demo-guard.spec.ts tests/p8a-proof-copy.spec.ts` and the P7/P6B/P4B domain specs. Playwright starts the production server on port 3100, so run the build first. No test sends a real payment automatically.

## Security and deterministic boundaries

- P2 authorization is never weakened: policy caps, exact recipient matching, and owner-subject binding are enforced server-side on every purchase, approval, and settlement action.
- The Hedera payer key and Privy server secret are `server-only` and never reach the browser bundle.
- The x402 payer accepts exactly one payment option: v2 exact, hedera:testnet, HTS USDC 0.0.429274, 3000 atomic units, the configured service account, and the currently advertised Blocky402 fee payer.
- One-shot settlement semantics: no retries after signing on ambiguous outcomes, no resubmission of an observed transaction hash, receipt and log verification before confirmation.
- Hosted demo purchases require `OMNIS_DEMO_PURCHASES_ENABLED=true` plus an authenticated allowlisted judge subject, with a strict per-judge cap (default 3 purchases, about $0.009 total). The in-memory counter is documented non-authoritative; the durable controls are the allowlist, P2 caps, exact-price validation, and a demo payer funded with only a few cents.
- The dev-only x402 route returns 404 in production.

## Test-mode disclosure

P6B test mode executes a 0.01 USDC infrastructure check on Arc Testnet. The original 50 USDC contractor mandate is never executed in test mode. Test-mode proof pages say "demo verified. proof is ready.", show the 50 USDC mandate as NOT EXECUTED, and link the real 0.01 USDC transaction. Test mode is authorized by the server (`ENABLE_P6B_TEST_MODE` in production); a client query flag alone cannot enable it, and the wallet signs the server-authorized amount, never a client-chosen one.

## Start Fresh declaration

Start Fresh status cannot be verified from this workspace: no `.git` directory, remote, branch, or commit history is present here, so prior history cannot be audited. The project is presented as built fresh for ETHOnline 2026 with no forked code to the owner's knowledge. Before submitting, initialize the repository, keep the full history public from the first push, and confirm the Start Fresh evidence item in `docs/submission-checklist.md`.

## AI-assisted development disclosure

AI tools assisted research and coding under human direction; architecture, financial semantics, and live testing were human-directed, and every live financial action required explicit human execution. Details and pointers: `docs/ai-development.md`.
