# Demo runbook (3 to 3.5 minutes)

Target: one continuous flagship recording with cuts only to remove waiting.
Never fake a success state. If a step fails, show the error surface and its
recovery.

## 0:00-0:20 problem and thesis

Say: agents can chat about money but cannot be trusted with it. useOmnis
bounds every financial step in a visible mandate that ends in proof. Show
the landing hero and the mandate line.

## 0:20-0:50 natural-language flagship prompt

In `/app`, submit the natural-language prompt:

> Pay this contractor `0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7` 0.10 USDC,
> but check the wallet first. Spend no more than $0.05 checking.

Show the conversation turn and plan. Groq extracts the semantic intent and
Omnis grounds it against deterministic evidence and value validation. Show
the final payment amount as 0.10 USDC, the $0.05 service budget, and the
approval requirement.

## 0:50-1:20 bounded service recommendation

Show capability discovery and the bounded candidate set. The recommendation
beat must include:

- `Recommended by Omnis` as the verified Groq recommendation label;
- the advisory rationale marker, `advisory · model suggestion`;
- deterministic `Why this service` facts: wallet-activity capability,
  Hedera Testnet x402, cost `$0.003`, and budget after `$0.047`;
- the visible boundary that the recommendation has zero spend authority.

Refresh the recommendation once to show the same context does not create a
duplicate request and that a changed task or policy context invalidates the
stored recommendation.

## 1:20-1:55 explicit Run gate and Hedera service payment

Click `Run` or `start wallet check` explicitly. The recommendation only
selects a bounded candidate; P2 authorizes the service spend before this
manual action. The `$0.003` HTS USDC x402 payment settles on Hedera Testnet
through Blocky402. Keep the paid confirmation and payment identifier on
screen. Pre-record or cut facilitator waiting time only when the shown
states are real.

## 1:55-2:20 service evidence and budget

Show the returned factual wallet observations separately from heuristic flags.
Point at the `$0.05` service cap, `$0.003` spend, and `$0.047` remaining
budget. The service result is evidence, not final-payment approval.

## 2:20-2:50 human final-payment approval

Open the approval gate. Show the exact 0.10 USDC amount, recipient, asset,
and approval threshold. The human explicitly approves the final payment.
Privy resolves the embedded `primaryExecutionWallet`, switches it to Arc
Testnet, and presents the wallet action.

## 2:50-3:15 Arc settlement and reconciliation

Show the 0.01 USDC test-mode transfer, the observed transaction hash, and
reconciliation confirming receipt and transfer logs. Open the ArcScan page
for `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`.
Keep the test-mode label visible: this recorded transfer is infrastructure
evidence, not execution of the 0.10 USDC flagship mandate.

## 3:15-3:30 proof bundle and closing line

Open `/app/proof/<task>`. Show `demo verified. proof is ready.`, the
NOT EXECUTED 0.10 USDC mandate, and the linked 0.01 USDC evidence. Closing
line: "Bounded spend, human approval, verifiable proof."

## What may be pre-recorded or cut

- Facilitator and confirmation waiting time.
- Page loads and wallet-switch latency.
- Retakes of individual segments spliced in order, as long as every shown
  state is real.

## What must never be faked

- Payment confirmations, balances, transaction hashes, block numbers, or
  approval states.
- Recommendation labels or rationale presented as model output when the
  recommendation was not verified.
- Test mode must stay visibly labeled; never present the demo as the 0.10
  USDC flagship mandate completing.
