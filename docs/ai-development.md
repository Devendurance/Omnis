# AI-assisted development disclosure

## Tools and models

The exact AI tools and models used across this project are not fully recorded in this repo. The human owner must confirm the final list before submission.

Known: P8A hardening and documentation in this session were produced with AI coding assistance under human direction. Prior sessions (P0-P7 implementation): specific tools and models unrecorded, see the TODO below. P8B submission readiness (public `/evidence` surface, deployment doc, submission copy, Mermaid diagram, checklist) was likewise AI-assisted under human direction; no product features added, no P0-P7 financial semantics changed, no live payment executed.

## Human-directed process

- Architecture: the mandate-to-proof flow, deterministic P2 policy boundary, one-shot x402 payer semantics, and approval-gated settlement were defined and reviewed by the human owner. The agent implemented inside those boundaries and did not change P0-P7 financial semantics in P8A.
- Testing: live Hedera and Arc actions were executed explicitly by the human (dry-run preflight first, then one manual paid command). No test suite, page load, reload, or agent loop sends a payment automatically.
- Review: every production safety change in P8A (demo guard, endpoint allowlist, server-authoritative test mode, proof copy) was checked with typecheck, lint, build, focused tests, and a production-mode smoke test.

## AI-assisted areas

- P8A hardening code: demo guard module, endpoint allowlist, route wiring, proof-copy branch, and new P8A tests.
- P8A documentation: README rewrite, submission evidence, checklist, and demo runbook.
- Earlier work (P0-P7): conversational UI, domain state machines, persistence, settlement and reconciliation, and existing test suites were built with AI assistance under human direction. Exact per-area attribution before P8A is unrecorded; see the TODO above.

## Live financial actions

- The $0.003 Hedera x402 payment and the 0.01 USDC Arc test transfer were each authorized and triggered by an explicit human command after a passing preflight. See `docs/submission-evidence.md` for identifiers.
- The 50 USDC contractor mandate has never been executed. Test-mode surfaces state this explicitly.

## Required prompt and spec artifacts

- If ETHGlobal requires original prompt or spec artifacts, they are absent from this repo. TODO: the human owner must add them under `docs/` or file the submission disclosure stating they were not retained, rather than reconstructing history.
