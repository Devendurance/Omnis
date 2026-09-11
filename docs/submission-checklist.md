# Submission checklist

Verified against the P8B tree. PASS means verified in this workspace;
FAIL means a manual human action is still required.

- [PASS] Full test suite green: 382 passed, exit 0, foreground run (`npm run test`)
- [PASS] Lint clean (`npm run lint`)
- [PASS] Typecheck clean (`npm run typecheck`)
- [PASS] Production build clean, `/evidence` prerendered static (`npm run build`)
- [PASS] No em dashes in authored files (`npm run check:no-em-dash`)
- [PASS] Git worktree present: branch `main`, remote
  `https://github.com/Devendurance/Omnis.git`, history from 2026-09-11
  (`first commit`, `build useOmnis hackathon MVP`). Working tree is
  currently dirty: P8B changes are uncommitted and the branch ref still
  points at 7e770e8, so commit plus push remain manual steps (see FAIL
  items below).
- [FAIL] Public repository URL: push `main` to the public remote and confirm
  judges can read it
- [FAIL] Start Fresh declaration reviewed: after the first push, verify the
  public repo shows full history from project start with no forks, then
  confirm the README declaration matches what judges see
- [PASS] Secrets scan: `.env.local`, `.env`, private keys, tokens,
  `node_modules`, `.next`, Playwright output, and test artifacts are
  gitignored; `.env.local.example` is committable and carries no values
- [FAIL] Deployment URL: deploy to Vercel per `docs/deployment.md`, set
  `OMNIS_PUBLIC_ORIGIN`, then record the URL here
- [FAIL] Hosted smoke test: run the post-deploy commands in
  `docs/deployment.md` (services 200, x402 402 challenge, `/evidence`
  heading, service-purchase 401 without token, 1440px + 375px pass)
- [FAIL] Privy production app configured: production app ID, secret,
  verification key, and allowlisted deployment origin
- [PASS] Public x402 challenge verified locally against the production
  build: unauthenticated POST to `/api/services/wallet-activity` returns
  HTTP 402, `/evidence` returns 200, POST to
  `/api/tasks/service-purchase` without a token returns 401. Hosted
  verification is still pending (see hosted smoke test FAIL below).
- [PASS] Hedera proof: x402 v2 exact on hedera:testnet via Blocky402, HTS
  USDC 0.0.429274, $0.003, payment `0.0.7162784@1788995118.130839662`,
  rendered on `/evidence`
- [PASS] Arc proof: Arc Testnet 5042002 USDC settlement, transaction
  `0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d`,
  block `61303876`, 0.01 USDC TEST MODE with the 50 USDC mandate NOT
  EXECUTED, rendered on `/evidence` with the ArcScan link
- [PASS] Architecture diagram: Mermaid diagram in README with the LLM /
  conversation vs deterministic execution trust boundary
- [PASS] AI disclosure: `docs/ai-development.md` distinguishes human
  decisions, AI-assisted coding/research, and human-authorized live
  financial actions (owner must still confirm the final model list)
- [FAIL] Demo video: record per `docs/demo-runbook.md` (2-4 minutes, no
  faked states, test mode visibly labeled)
- [PASS] ETHGlobal submission copy: `docs/submission-copy.md` (main with
  technical highlights, Hedera, Arc, Privy answers; live-proven testnet
  transactions distinguished from the not-yet-hosted `/evidence` route)
- [FAIL] Hedera prize selected in the submission form
- [FAIL] Arc prize selected in the submission form
- [FAIL] Privy prize selected in the submission form

Judge access summary (conditional on the pending deployment and Privy
production configuration): unknown judges can open the app, explore the
landing page and `/evidence`, authenticate with Privy, view the verified
historical proof, and trigger the unpaid x402 402 challenge. Server-funded
$0.003 purchases require an allowlisted DID plus an explicit start action;
other DIDs get an explicit not-allowed response and no money moves. The
video demonstrates the full write path.
