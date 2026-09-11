# Demo runbook (3 to 3.5 minutes)

Target: one continuous flagship recording with cuts only to remove waiting. Never fake a success state; if a step fails, show the error surface and its recovery.

## 0:00-0:20 problem and thesis

Say: agents can chat about money but cannot be trusted with it. useOmnis bounds every financial step in a visible mandate that ends in proof. Show the landing hero and the mandate line.

## 0:20-0:45 submit the flagship mandate

In `/app`, submit: "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking." Show the parsed task, the policy card with caps, and the approval requirement. State that the 50 USDC mandate itself will not move.

## 0:45-1:30 agent discovers and buys the $0.003 service on Hedera

Show service discovery selecting the wallet-activity service, then click `start wallet check` explicitly. The $0.003 HTS USDC x402 payment settles on hedera:testnet via Blocky402. Pre-record the facilitator wait if needed and cut the idle gap; keep the paid confirmation and payment identifier on screen.

## 1:30-2:05 evidence and bounded budget

Show the returned observations, heuristic flags, remaining service budget, and total spend. Point at the $0.05 cap and the $0.003 charge.

## 2:05-2:40 human approval and Privy

Open the approval gate. Show the exact amount, recipient, asset, and threshold crossed. Log in with Privy, show the embedded primaryExecutionWallet, and approve. The wallet switches to Arc Testnet before signing.

## 2:40-3:05 Arc settlement and reconciliation

Show the 0.01 USDC test transfer submitting, the observed transaction hash, and reconciliation confirming receipt and transfer logs. Open the ArcScan page for `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`.

## 3:05-3:30 proof bundle and closing line

Open `/app/proof/<task>`. Show "demo verified. proof is ready.", the NOT EXECUTED 50 USDC mandate, and the linked 0.01 USDC evidence. Closing line: "Bounded spend, human approval, verifiable proof."

## What may be pre-recorded or cut

- Facilitator and confirmation waiting time.
- Page loads and wallet-switch latency.
- Retakes of individual segments spliced in order, as long as every shown state is real.

## What must never be faked

- Payment confirmations, balances, transaction hashes, block numbers, or approval states.
- Test mode must stay visibly labeled; never present the demo as the 50 USDC mandate completing.
