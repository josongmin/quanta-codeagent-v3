/**
 * Smoke-fixture core types (Phase 1 — single/medium/tikitaka × tier-0 replay).
 *
 * Each scenario is a self-contained folder under `tests/smoke/fixtures/<depth>/<NN-name>/`:
 *
 *   seed/                Files copied into a tmp workspace before the run.
 *   prompts.jsonl        One user message per line. Tikitaka feeds them in order.
 *   trajectory.jsonl     Recorded LLM events for tier-0 replay (one entry per event).
 *                        Missing ⇒ scenario is SKIPPED in tier-0 (politely pending).
 *   expect.json          Declarative assertion spec — see {@link ExpectSpec}.
 *
 * Industry-SOTA assertion shape blends Inspect AI / promptfoo / Braintrust
 * primitives:
 *   - {@link ExpectSpec.toolCalls}     positive + negative + ordering
 *   - {@link ExpectSpec.files}         post-state contains/notContains/absent
 *   - {@link ExpectSpec.finalText}     contains/containsAny/regex/notContains
 *   - {@link ExpectSpec.contextRetention} tikitaka — agent recalls a prior fact
 *   - {@link ExpectSpec.budget}        wall / token budgets (perf regression gate)
 *   - {@link ExpectSpec.judge}         OPTIONAL LLM-as-judge rubric (Phase 2 wire)
 *
 * Replay determinism: a `TrajectoryReplayLLM` yields the events scoped to the
 * current `(run, turn)` bucket. `run` = which user message (0-indexed),
 * `turn` = which LLM call within that user message.
 */
export {};
