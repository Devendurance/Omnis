# Submission evidence

Exact live-proven evidence for each sponsor track. Nothing here claims an integration that is not live-proven.

## Conversation and recommendation implementation

The shipped conversational path uses Groq for semantic extraction and service
comparison inside bounded contracts. Deterministic intent, evidence/value
validation, P2 policy, recommendation verification, execution gates, and
settlement reconciliation remain authoritative.

- Conversation implementation: `src/lib/conversation/*`
- Recommendation implementation: `src/lib/recommendation/*`
- Interpretation route: `/api/conversation` (`src/app/api/conversation`)
- Recommendation route: `/api/services/recommendation`
  (`src/app/api/services/recommendation`)
- Groq production default: `openai/gpt-oss-20b`; strict-output opt-in:
  `openai/gpt-oss-120b`
- GPT-OSS transport: `max_completion_tokens 2048`, `reasoning_effort low`,
  `include_reasoning false`, and strict JSON Schema output
- Recommendation authority: the model may recommend or compare bounded
  candidates, but its recommendation has zero spend authority. Deterministic
  verification and P2 authorize any service spend.

Conversation and recommendation regression coverage is retained in the repository:

- Conversation and interpretation coverage: `tests/p9a-conversational-intelligence.spec.ts`,
  `tests/p9a1-groq-provider.spec.ts`, `tests/p9a2-conversation-route.spec.ts`,
  `tests/p9a2-hermetic.spec.ts`, `tests/p9a3-response-motion.spec.ts`,
  `tests/p9a4-authority-bypass.spec.ts`,
  `tests/p9a5-groq-structured-output.spec.ts`,
  `tests/p9a6-reset-eligibility.spec.ts`, `tests/p9a6-task-actions.spec.ts`,
  `tests/p9a7-task-history-browser.spec.ts`,
  `tests/p9a7-task-history.spec.ts`,
  `tests/p9a8-semantic-extraction.spec.ts`,
  `tests/p9a9-groq-120b-structured-output.spec.ts`,
  `tests/p9a10-gaps.spec.ts`, `tests/p9a11-groq-reliability.spec.ts`, and
  `tests/p9a11-1-provider-isolation.spec.ts`
- Recommendation coverage: `tests/p9b-service-recommendation.spec.ts`,
  `tests/p9b1-recommendation-presentation.spec.ts`, and
  `tests/p9b2-recommendation-refresh.spec.ts`

## Hedera: AI and agentic payments

- Service endpoint: `POST /api/services/wallet-activity`. Advertised by `GET /api/services` when the server Hedera configuration is valid.
- Protocol: x402 v2, `exact` scheme, network `hedera:testnet`, HTS USDC token `0.0.429274`, price `3000` atomic units ($0.003).
- Facilitator: Blocky402 testnet at `https://api.testnet.blocky402.com`. The payer reads the current `/supported` response and uses only the advertised `feePayer`.
- Real payment identifier: `0.0.7162784@1788995118.130839662` for the wallet-activity check on the flagship mandate.
- Discovery and budget flow: registry discovery selects
  `useomnis-wallet-activity-x402`, P2 policy reserves the quote against the
  $0.05 service budget, and the purchase ledger records quoted, paid, and
  result states. Catalog-only entries never touch the network.
- Safety: one-shot signing, no retry after signing on ambiguous outcomes, exact allowlist validation of scheme, network, asset, payTo, feePayer, timeout, and atomic amount.
- Relevant source files:
  - `src/lib/services/hedera-x402/payer.ts`
  - `src/lib/services/hedera-x402/requirements.ts`
  - `src/lib/services/hedera-x402/resource.ts`
  - `src/lib/services/hedera-x402/facilitator.ts`
  - `src/lib/services/hedera-x402/preflight.ts`
  - `src/lib/services/hedera-x402/http.ts`
  - `src/lib/services/hedera-x402/config.ts`
  - `src/lib/services/hedera-x402/dev-route.ts`
  - `src/lib/services/server/p4a.ts`
  - `src/lib/services/server/runtime-registry.ts`
  - `src/lib/services/server/demo-guard.ts`
  - `src/lib/services/wallet-activity-descriptor.ts`
  - `src/lib/services/registry.ts`
  - `src/lib/services/discovery.ts`
  - `src/app/api/services/route.ts`
  - `src/app/api/services/wallet-activity/route.ts`
  - `src/app/api/tasks/service-purchase/route.ts`
  - `src/lib/tasks/service-execution.ts`

## Arc: best DeFi and onchain finance application

- Network: Arc Testnet, chain ID `5042002`, RPC `https://rpc.testnet.arc.network/`, explorer `https://testnet.arcscan.app`.
- Asset: USDC contract `0x3600000000000000000000000000000000000000`, 6 decimals.
- Real confirmed transaction: `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`, confirmed in block `61303876`.
- Amount semantics: the flagship intent requests a final payment of 0.10
  USDC. The confirmed transaction is a 0.01 USDC (10,000 atomic units)
  infrastructure test transfer. The 0.10 USDC contractor mandate was not
  executed in test mode.
- Policy, approval, and settlement flow: preflight checks balance and policy, the owner approves the exact amount and recipient, the embedded wallet signs, submission records the observed hash once, and reconciliation verifies receipt status plus ERC-20 transfer log topics before confirming. Resubmission is forbidden.
- Relevant source files:
  - `src/lib/settlement/arc/config.ts`
  - `src/lib/settlement/arc/fallback.ts`
  - `src/lib/settlement/circle/adapter.ts`
  - `src/lib/settlement/final/service.ts`
  - `src/lib/settlement/final/types.ts`
  - `src/app/api/tasks/final-settlement/route.ts`
  - `src/app/api/dev/circle-settlement/preflight/route.ts`
  - `src/app/api/dev/circle-settlement/reconcile/route.ts`
  - `src/components/composer.tsx`
  - `src/components/circle-settlement-card.tsx`
  - `src/components/conversational-cards.tsx`

## Privy: best financial flow

- Authentication: Privy access tokens verified server-side on every purchase, approval, settlement, and reconcile action. Missing or invalid tokens get 401.
- Embedded primaryExecutionWallet: settlements execute only through the wallet with role `primaryExecutionWallet`. External connected wallets are listed separately and never substituted.
- Chain switching: the client switches the embedded wallet to Arc Testnet (5042002) and obtains a fresh EIP-1193 provider after switching, before signing.
- Real wallet-approved transfer: the confirmed Arc transaction above was approved by the authenticated task owner and signed by the owner embedded wallet.
- Owner isolation: every session, task, policy snapshot, approval, settlement, and proof is bound to the token subject. Client-supplied owner fields that mismatch the verified subject are rejected, and persisted sessions hydrate only under the expected owner subject.
- Relevant source files:
  - `src/lib/auth/config.ts`
  - `src/lib/auth/context.tsx`
  - `src/lib/auth/verifier.ts`
  - `src/lib/auth/server.ts`
  - `src/lib/auth/types.ts`
  - `src/lib/settlement/circle/adapter.ts`
  - `src/lib/tasks/persistence.ts`
  - `src/lib/settlement/circle/persistence.ts`
  - `src/app/app/proof/[id]/client.tsx`
