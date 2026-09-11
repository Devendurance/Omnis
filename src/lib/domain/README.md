# useOmnis domain layer

The domain layer is the boundary beneath the existing interface preview. It has no wallet, provider, database, or sponsor integration.

## Authority boundary

- The LLM layer can propose an intent, a plan, service choices, and explanatory text.
- The deterministic layer validates structured values, evaluates policy, enforces budgets, and authorizes state transitions.
- The execution layer writes service payment and settlement identifiers only after authorization.
- The reconciliation layer reads trusted provider status and supplies typed confirmation evidence. Recovery is read-only after an identifier exists.
- The proof layer records the task, policy snapshot, service activity, approval, settlement outcome, and timestamps. Finalization is idempotent.

Money uses non-negative `bigint` base units with an explicit decimal scale. No policy comparison uses JavaScript floating-point arithmetic. Agent summaries remain explanatory data and never establish payment or settlement truth.

P1 connects deterministic local intent parsing, task and policy orchestration, plan presentation, and versioned draft persistence to these contracts. It still has no wallet, provider, database, or sponsor integration, and authorization remains outside UI and parser code.

P3 adds a provider-agnostic, development-only service catalog and deterministic
discovery boundary. Discovery evaluates candidates through the P2 budget and
policy runtime; selecting a candidate never creates a reservation. Provider
adapters expose inspection only until P4 adds an execution boundary.
