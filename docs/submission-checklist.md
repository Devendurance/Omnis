# Submission checklist

- [ ] Public repo: `git init`, first commit, push to a public GitHub repository. The workspace currently has no `.git`, no remote, and no history.
- [ ] Public deployment: deploy to a hosted URL, set `OMNIS_PUBLIC_ORIGIN` to the bare https origin, and configure the server-only variables from the README.
- [ ] README: finalized for judges with pitch, flagship flow, architecture diagram, sponsor sections, live evidence, env categories, and disclosures.
- [ ] Architecture diagram: present in README and matching the implementation order intent, policy, discovery, Hedera purchase, evidence, approval, Privy wallet, Arc settlement, reconciliation, OmnisProof.
- [ ] Video (2-4 minutes): recorded per `docs/demo-runbook.md`, under 4 minutes, no faked success states.
- [ ] Hedera criteria: x402 v2 exact payment on hedera:testnet via Blocky402, HTS USDC 0.0.429274, $0.003, payment `0.0.7162784@1788995118.130839662`.
- [ ] Arc criteria: Arc Testnet 5042002 USDC settlement, transaction `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`, block `61303876`.
- [ ] Privy criteria: auth-gated flow, embedded primaryExecutionWallet, Arc chain switch, owner-bound records.
- [ ] Start Fresh evidence: manually verify after the first push that the public repo shows full history from project start with no forks or prior commits, then confirm the README declaration matches what judges can see.
- [ ] Live links: deployment URL, repo URL, video URL, ArcScan link for the settlement, proof route for the demo task.
- [ ] Transaction identifiers: both identifiers above visible in the submission form and the video.
- [ ] Final smoke test: production-mode pass over `/app`, `/app/wallet`, `/app/proof/<fixture>`, `/api/services`, the x402 402 challenge, auth gating, refresh persistence, mobile 375px, and a clean console on the flagship path. No new real payment.
