# ETHOnline 2026 submission copy

## A. Main submission

- Project name: useOmnis
- One-liner: tell Omnis what needs to get paid; it handles the rest inside
  a visible bounded mandate that ends in proof.
- Problem: AI agents can chat about money but cannot be trusted with it.
  Open-ended wallets, hidden spend, silent retries after ambiguous payment
  outcomes, and no verifiable record of what moved, why, and who approved
  it keep agents away from real financial work.
- Solution: useOmnis turns a plain-language payment task into a structured
  mandate with deterministic policy caps, pays for machine services over
  x402 on Hedera, shows the evidence, pauses for explicit human approval,
  settles USDC on Arc Testnet through a Privy embedded wallet, reconciles
  onchain, and finalizes an OmnisProof bundle linking every step.
- How it works: the composer parses the mandate into recipient, amount,
  and service budget. P2 policy caps service spend and requires approval
  for the final payment. Discovery selects the live wallet-activity
  service. An explicit `start wallet check` settles one $0.003 HTS USDC
  x402 payment on hedera:testnet via Blocky402. Returned observations and
  flags appear with the remaining budget. The owner reviews the exact
  amount, recipient, asset, and threshold, then approves. The embedded
  primaryExecutionWallet switches to Arc Testnet and signs. Reconciliation
  verifies receipt and transfer logs before confirmation, and the proof
  bundle records intent, plan, policy, purchase, approval, settlement, and
  timestamp.
- Technical highlights: deterministic P2 policy boundary (the conversation
  never sets payment parameters); x402 v2 exact payer with allowlisted
  scheme, network, asset, payTo, fee payer, timeout, and atomic price;
  one-shot signing with no retry after signing on ambiguous outcomes and
  no resubmission of an observed hash; Privy token verification with
  owner-subject binding on every financial action; receipt plus ERC-20
  log verification before confirmation.
- What is live: the wallet-activity service purchase over x402 on
  hedera:testnet (payment `0.0.7162784@1788995118.130839662`); the Arc
  Testnet USDC settlement path with a confirmed transaction
  (`0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`,
  block `61303876`); Privy auth plus embedded wallet signing with chain
  switching. These are live-proven historical testnet transactions,
  verifiable on their explorers today. The public `/evidence` route that
  renders this record is implemented and verified against the local
  production build; it serves judges publicly after the pending hosted
  deployment is configured.
- What is test mode: P6B test mode executes a 0.01 USDC infrastructure
  check on Arc Testnet. The original 50 USDC contractor mandate is never
  executed in test mode. Proof pages say "demo verified. proof is ready."
  and mark the 50 USDC mandate NOT EXECUTED.
- What is next: allowlist more judge identities after the demo payer is
  sized accordingly; keep the per-subject caps; add durable (non-memory)
  demo spend accounting; extend the service registry beyond the
  wallet-activity check.

## B. Hedera prize answer

The machine-economy leg runs on Hedera testnet over x402 v2 exact
payments, facilitated by Blocky402 at
`https://api.testnet.blocky402.com`. The paid wallet-activity service
(`POST /api/services/wallet-activity`, advertised by
`GET /api/services` when the server Hedera configuration is valid) costs
$0.003 in HTS USDC (token 0.0.429274, 3000 atomic units). A real paid
request settled with payment identifier
`0.0.7162784@1788995118.130839662`. Service discovery selects
`useomnis-wallet-activity-x402` from the registry, P2 policy reserves the
quote against the bounded $0.05 service budget, and the purchase ledger
records quoted, paid, and result states. The payer validates the exact
scheme, network, asset, service account, advertised fee payer, timeout,
and atomic price before signing once, and never retries after signing
when the outcome is unknown. The demo spends $0.003 of the $0.05 budget.

## C. Arc prize answer

Arc is the settlement layer. Final settlement runs on Arc Testnet (chain
ID 5042002) as a plain ERC-20 USDC transfer of contract
`0x3600000000000000000000000000000000000000`. Settlement is
human-gated and programmable: preflight checks balance and policy, the
owner approves the exact amount and recipient, the embedded wallet signs,
submission records the observed hash once, and reconciliation verifies
receipt status plus ERC-20 transfer log topics before confirming.
Resubmission of an observed hash is forbidden. A confirmed testnet
transaction settled and reconciled: hash
`0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`
in block `61303876`, a 0.01 USDC TEST MODE transfer (10,000 atomic
units). The original 50 USDC contractor mandate was NOT EXECUTED.
Proof and reconciliation link the settlement to the intent, policy,
service purchase, and approval; verify it on ArcScan at
`https://testnet.arcscan.app/transaction/0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`.

## D. Privy prize answer

Privy provides authentication and the embedded primaryExecutionWallet.
Server routes verify the Privy access token and bind every task,
settlement, approval, and proof to the token subject; a client-supplied
owner that mismatches is rejected with 403. Users never handle private
keys: the embedded wallet signs, external connected wallets are listed
separately and never substituted for execution. The client switches the
embedded wallet to Arc Testnet (5042002) and obtains a fresh provider
after switching, before signing. Every financial step waits for explicit
user action: `start wallet check` for the service purchase and an
approval gate showing exact amount, recipient, asset, and threshold for
settlement. The server secret never leaves the server, mock tokens are
rejected in production, and the financial flow stays hidden behind the
intent UX: the user states what needs to get paid, and the mandate line
(intent, policy, service, approval, settlement, proof) makes the
authority visible. The confirmed Arc transfer was wallet-approved by the
task owner.
