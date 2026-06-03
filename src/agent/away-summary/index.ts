/**
 * AFK away-summary slice barrel (ADR-0465).
 *
 * What it does: re-exports the away-summary port, prompt constant, gate, the
 * `shouldEmit` activity guard, and the `runAwaySummary` orchestrator.
 *
 * Slices imported (transitively): `@/shared` ONLY. This slice lives in
 * `@/agent` but never imports `@/llm` — the LLM call is the injected
 * {@link SummarizeFn} (port inversion, mirrors `@/permission`'s
 * `ClassifierPort`). The composition root in `@/apps` wires the real adapter.
 *
 * DEFAULT-OFF: no `apps/` wire imports this barrel today. Activation (the
 * SummarizeFn adapter, the on-return trigger, and the CLI render of the recap)
 * is listed in the ADR's integration TODOs and applied by the human at
 * integration. With the gate (`QUANTA_ENABLE_AWAY_SUMMARY`) unset every call
 * short-circuits to a `gate-off` skip and makes zero LLM calls.
 *
 * NO-THROW: every export returns a Result/outcome/value, never throws.
 */

export { AWAY_SUMMARY_SYSTEM_PROMPT, type SummarizeFn } from "./port"
export {
  AWAY_SUMMARY_ENV,
  AWAY_SUMMARY_MAX_WORDS,
  awaySummaryEnabled,
  describeSkip,
  runAwaySummary,
  shouldEmit,
} from "./runner"
export type {
  AwaySkipReason,
  AwaySummaryEnv,
  AwaySummaryOutcome,
  AwaySummaryRequest,
  RecapTurn,
} from "./types"
