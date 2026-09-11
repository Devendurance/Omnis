# Submission evidence

Exact live-proven evidence for each sponsor track. Nothing here claims an integration that is not live-proven.

## Hedera: AI and agentic payments

- Service endpoint: `POST /api/services/wallet-activity`. Advertised by `GET /api/services` when the server Hedera configuration is valid.
- Protocol: x402 v2, `exact` scheme, network `hedera:testnet`, HTS USDC token `0.0.429274`, price `3000` atomic units ($0.003).
- Facilitator: Blocky402 testnet at `https://api.testnet.blocky402.com`. The payer reads the current `/supported` response and uses only the advertised `feePayer`.
- Real payment identifier: `0.0.7162784@1788995118.130839662` for the wallet-activity check on the flagship mandate.
- Discovery and budget flow: registry discovery selects `useomnis-wallet-activity-x402`, P2 policy reserves the quote against the $0.05 service budget, and the purchase ledger records quoted, paid, and result states. Catalog-only entries never touch the network.
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
- Amount semantics: 0.01 USDC (10,000 atomic units) infrastructure test transfer. The 50 USDC contractor mandate was not executed.
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
