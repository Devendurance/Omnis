# Submission checklist

Status is split between work completed in this repository and actions that
still require the human submitter. No payment, deployment, commit, or push is
performed by this packaging task.

## Completed in the workspace

- [RECORDED] Latest observed repository-wide run: `732 passed`, `1 failed`
  response-motion timing test, and `1 flaky` screenshot test. The
  response-motion test passes 8/8 in isolation. This is not represented as a
  perfectly green full suite, and the full suite is not rerun during packaging.
- [PASS] Lint passed (`npm run lint`).
- [PASS] Typecheck passed (`npm run typecheck`).
- [PASS] Production build passed (`npm run build`).
- [PASS] No em dashes found (`npm run check:no-em-dash`).
- [PASS] Local conversation coverage includes semantic extraction, deterministic
  evidence validation, Groq transport, authority guards, history, and
  response motion.
- [PASS] Local recommendation coverage includes bounded candidate construction, verified
  presentation, recommendation refresh invalidation, and zero-spend-authority
  behavior.
- [PASS] Hosted-smoke commands are documented in `docs/deployment.md`; the
  local production-build smoke covered services, the unpaid x402 challenge,
  `/evidence`, and unauthenticated service purchase.
- [PASS] Start Fresh provenance is grounded in the repository history: the
  first commit is `first commit` on 2026-09-11, followed by the ETHOnline MVP
  history. README wording distinguishes this repository from earlier
  conceptual experiments without inventing lineage or dates.
- [PASS] `.gitignore` covers dependencies, build output, test output,
  agent state, environment files, and `*.log`; `.env.local.example` carries
  no secret values.
- [PASS] Hedera evidence: x402 v2 exact on `hedera:testnet`, HTS USDC
  `0.0.429274`, `$0.003`, payment
  `0.0.7162784@1788995118.130839662`.
- [PASS] Arc evidence: Arc Testnet chain `5042002`, confirmed transaction
  `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`,
  block `61303876`, and 0.01 USDC test-mode transfer. The 0.10 USDC
  flagship mandate is NOT EXECUTED.
- [PASS] README includes the conversation versus deterministic execution
  trust boundary, shipped flow, model authority limits, and major libraries
  and SDKs.
- [PASS] AI disclosure records the conversational and recommendation implementation, the Groq 20B production
  choice, the deterministic authority boundary, and human-authorized live
  financial actions.
- [PASS] Submission copy, evidence map, demo runbook, deployment guide, and
  this checklist describe the shipped architecture.

## Human submission actions remaining

- [HUMAN ACTION] Review and commit the intended source, tests, documentation,
  and curated screenshot assets. Do not commit ignored transient artifacts.
- [HUMAN ACTION] Push the intended branch to the public repository and verify
  judges can read the complete history.
- [HUMAN ACTION] After push, confirm the public repository still supports the
  Start Fresh declaration and that no unrelated repository lineage is being
  claimed.
- [HUMAN ACTION] Deploy to Vercel, set `OMNIS_PUBLIC_ORIGIN`, and record the
  hosted URL.
- [HUMAN ACTION] Configure the Privy production app, server credentials, and
  allowlisted deployment origin.
- [HUMAN ACTION] Run hosted conversation and recommendation smoke checks at 1440px and 375px:
  conversation interpretation, verified recommendation and refresh,
  explicit Run gate, service-purchase auth guard, `/api/services` 200,
  unpaid wallet-activity 402, and `/evidence` 200. Do not trigger a payment
  during smoke checks.
- [HUMAN ACTION] Record the 2 to 4 minute demo using `docs/demo-runbook.md`.
  Keep recommendation rationale advisory, deterministic facts visible, Run
  and final approval explicit, and test mode labeled.
- [HUMAN ACTION] Select the Hedera, Arc, and Privy prize tracks in the
  ETHOnline submission form and attach the video and evidence links.

Judge access remains conditional on the hosted deployment and Privy
production configuration. Public evidence and the unpaid x402 challenge can
be exposed without granting unrestricted server-funded spend.
