# AI-assisted development disclosure

AI assisted research, planning, coding, debugging, testing, and
documentation under human direction. The complete per-session coding-tool and
coding-model ledger was not retained in Git; this disclosure does not invent
that missing history. The runtime model facts below are verified from the
shipped source and configuration.

## Human-directed authority boundary

The human owner defined and reviewed the mandate-to-proof flow, sponsor
architecture, deterministic P2 policy boundary, one-shot x402 payer
semantics, approval-gated settlement, test-mode truthfulness, and final
submission claims. AI-assisted implementation stayed inside those boundaries.

Groq may interpret, clarify, compare, recommend, and explain. Deterministic
code remains authoritative over recipients, amounts, service eligibility,
budgets, approval, execution, settlement truth, and proof. Model output cannot
sign, authorize spend, bypass P2, invent financial truth, mark settlement
complete, or create proof.

## Implementation record

- Conversational intelligence: Groq-compatible structured interpretation,
  strict runtime validation, deterministic reconciliation, authority-bypass
  guards, response motion, task actions, owner history, and read-only records.
- Semantic interpretation and deterministic validation: flat semantic slots are grounded against the
  user's source text, pending intent, task values, and deterministic evidence
  validation before promotion into an authoritative intent.
- Model evaluation: strict-output support covers exactly
  `openai/gpt-oss-20b` and `openai/gpt-oss-120b`. The evaluation did not
  establish a quality winner; 20B remains the production default and 120B is
  opt-in through `OMNIS_LLM_MODEL`.
- Groq provider reliability and isolation: the GPT-OSS path
  uses `max_completion_tokens 2048`, `reasoning_effort low`,
  `include_reasoning false`, and strict JSON Schema output. The legacy
  `json_object` path remains isolated for other models and compatible
  providers. Provider failures fail closed to deterministic behavior.
- Bounded service recommendation: deterministic capability discovery
  builds the candidate DTO, Groq compares bounded candidates, deterministic
  verification accepts only a current executable candidate, and P2 remains
  the only service-spend authority.
- Recommendation presentation integrity: `Recommended by Omnis`, advisory rationale,
  and `Why this service` facts are provider-gated and derived from verified
  deterministic DTO values.
- Recommendation freshness and invalidation: recommendation freshness uses one canonical
  context fingerprint and a single refresh predicate, preventing stale
  recommendations or duplicate refresh requests.

## Runtime model choice

The shipped Groq production default is `openai/gpt-oss-20b` at the canonical
Groq OpenAI-compatible endpoint. `openai/gpt-oss-120b` is the supported
strict-output opt-in. Both GPT-OSS IDs use the same strict schema contract;
20B was retained as default because the live comparison was inconclusive and
the smaller model was the selected production choice. GPT-OSS reasoning is
configured as low effort and is not returned to the client.

## Live financial actions

- The `$0.003` Hedera x402 payment and the 0.01 USDC Arc Testnet transfer
  were each authorized and triggered by an explicit human command after a
  passing preflight. See `docs/submission-evidence.md` for identifiers.
- The flagship final-payment intent is 0.10 USDC. It was not executed by the
  test-mode proof. Test-mode surfaces state this explicitly.
- No test suite, page load, reload, model response, or agent loop sends a
  payment automatically. No payment was executed during this packaging task.

## Required prompt and spec artifacts

Original prompt or spec artifacts from earlier sessions were not retained in
this repository. If ETHOnline requires them, the human owner must add only
artifacts that actually exist or disclose that they were not retained; this
repository does not reconstruct history.
