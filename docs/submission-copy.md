# ETHOnline 2026 submission copy

## A. Main submission

- Project name: useOmnis
- Positioning: **Delegate the financial task, not your wallet.**
- Core description: useOmnis is a bounded financial execution agent. A user
  gives Omnis a financial task, budget and rules. Groq interprets natural
  language and recommends bounded machine services, but deterministic
  validation and P2 remain authoritative over recipients, amounts, service
  eligibility, budgets, approval and execution.
- Problem: AI agents can discuss money without having bounded authority to
  act. Hidden spend, open-ended wallet access, silent retries after
  ambiguous payment outcomes, and missing proof keep agents away from real
  financial work.
- Solution: useOmnis turns a natural-language task into a bounded mandate,
  buys an eligible machine service over Hedera x402, shows deterministic
  evidence and budget facts, pauses for explicit human approval, settles USDC
  on Arc Testnet through a Privy embedded wallet, reconciles onchain, and
  produces proof.
- Flagship example: final payment `0.10 USDC`, wallet-check service price
  `$0.003`, service budget `$0.05`, and `$0.047` remaining after the service.
  The machine payment uses Hedera Testnet x402 and HTS USDC; the final
  settlement rail is Arc Testnet.
- How it works: Groq semantically extracts intent from the user's language.
  Deterministic evidence/value validation grounds the extracted recipient,
  amount, asset, budget, and rules. Capability discovery produces bounded
  service candidates. Groq recommends at most one candidate, and deterministic
  verification checks the recommendation. P2 authorizes service spend. The
  user explicitly presses `Run` or `start wallet check`, the service purchase
  settles, evidence returns, and a human approves the final payment. The
  embedded `primaryExecutionWallet` signs on Arc Testnet, reconciliation
  verifies the result, and OmnisProof records the sequence.
- Recommendation boundary: `Recommended by Omnis` is earned only by a
  verified Groq recommendation. The rationale is advisory, deterministic
  `Why this service` facts are rendered separately, and a recommendation has
  zero spend authority.
- Model boundary: the model may interpret, clarify, recommend or compare, and
  explain. It may not sign, authorize spend, bypass P2, invent financial
  truth, mark settlement complete, or create proof.
- What is live-proven: the Hedera wallet-activity x402 payment with payment
  identifier `0.0.7162784@1788995118.130839662`; the Arc Testnet USDC path
  with confirmed transaction
  `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d` in
  block `61303876`; and Privy authentication, embedded-wallet signing, and
  chain switching. The public `/evidence` route is implemented and verified
  against the local production build. Hosted deployment and hosted smoke
  remain human submission actions.
- Test mode: the Arc test mode records a 0.01 USDC infrastructure transfer on Arc Testnet.
  The 0.10 USDC flagship mandate is NOT EXECUTED in test mode, and proof
  pages say `demo verified. proof is ready.`
- Scope boundary: useOmnis does not claim universal cross-chain routing or
  production multichain settlement. Those remain future product work.

## B. Hedera prize answer

The machine-economy leg runs on Hedera Testnet over x402 v2 exact payments,
facilitated by Blocky402 at `https://api.testnet.blocky402.com`. The paid
wallet-activity service (`POST /api/services/wallet-activity`, advertised by
`GET /api/services` when the server Hedera configuration is valid) costs
`$0.003` in HTS USDC, token `0.0.429274`, or 3000 atomic units. A real paid
request settled with payment identifier
`0.0.7162784@1788995118.130839662`. Discovery selects
`useomnis-wallet-activity-x402`; P2 reserves the quote against the `$0.05`
service budget, and the purchase ledger records quoted, paid, and result
states. The payer validates scheme, network, asset, service account,
advertised fee payer, timeout, and atomic price before signing once. It never
retries after signing when the outcome is unknown. The demo spends `$0.003`
and leaves `$0.047` in the service budget.

## C. Arc prize answer

Final settlement runs on Arc Testnet, chain ID `5042002`, as an ERC-20 USDC
transfer using contract
`0x3600000000000000000000000000000000000000`. Settlement is human-gated:
preflight checks balance and policy, the owner approves the exact amount and
recipient, the embedded wallet signs, submission records the observed hash
once, and reconciliation verifies receipt status plus ERC-20 transfer log
topics before confirmation. Resubmission of an observed hash is forbidden.
The confirmed test-mode transaction is a 0.01 USDC transfer, hash
`0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`, in
block `61303876`. It is infrastructure evidence only; the 0.10 USDC
flagship mandate was NOT EXECUTED. Verify it on
[ArcScan](https://testnet.arcscan.app/tx/0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d).

## D. Privy prize answer

Privy provides authentication and the embedded `primaryExecutionWallet`.
Server routes verify the Privy access token and bind every task, settlement,
approval, and proof to the token subject. A mismatched client owner is
rejected. External wallets are listed separately and never substituted for
execution. Before signing, the client switches the embedded wallet to Arc
Testnet and obtains a fresh provider. Every financial write waits for an
explicit user action: `Run` for the machine service and approval for the
final payment. The server secret stays server-only, mock tokens are rejected
in production, and no model output can authorize, sign, settle, or create
proof. The confirmed Arc transfer was wallet-approved by the task owner.
