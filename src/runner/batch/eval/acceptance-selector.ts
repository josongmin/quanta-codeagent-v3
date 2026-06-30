/**
 * jun-28 SOTA++ Phase-A — driver-side acceptance selector factory (repro-only).
 *
 * Composes the real sandbox ports into the `selectCandidates` port the repair
 * orchestrator consumes. The driver binds:
 *   - `withCandidatePatch` — reset→apply candidate diff→probe→reset (rematerialize.ts)
 *   - `reproResolvedOnSandbox` — run the reproducing set on the patched tree and
 *     decide RESOLVED (executeReproTests + the K-of-N resolved vote).
 * Both are INJECTED so this factory stays hermetic-by-injection (tests fake them;
 * the box-gated real exec is verified against the same contract the HARD e2e pins).
 *
 * Gating / no-leak: returns `undefined` (⇒ legacy validator-rank selection,
 * byte-identical) when the `acceptance` opt-in is OFF or there is no reproducing
 * set. Scores ONLY the agent-side reproSources — never a hidden dataset field.
 * The regression dual-guard half is a follow-up (it needs the no-leak base-tree
 * passing-set capture); this lands the repro-only acceptance first.
 */

import type { AcceptanceLlmRerank } from "./acceptance-select"
import { maybeAcceptanceSelector } from "./acceptance-wire"
import type { RepairCandidateOutcome } from "./repair/types"

/**
 * Map a regression run result → the acceptance failure COUNT (lower = better).
 *
 * `!ran` (the patched tree's pytest could not COLLECT/run the selected tests — a
 * patch that broke importability, a collection error, no tests collected) ⇒
 * `+Infinity` (SUSPECT — loses the min-regression bar), NOT `0`. Scoring an
 * unmeasurable regression as `0` would let a patch that BREAKS the test suite win
 * the regression comparison. If collection fails UNIFORMLY across candidates they
 * all get `+Infinity` ⇒ the min bar is `+Infinity` ⇒ regression no-ops and repro
 * decides (correct). `ran && pass` ⇒ 0; `ran && !pass` ⇒ the failed-test count.
 */
export const regressionFailureCount = (r: {
  readonly ran: boolean
  readonly pass: boolean
  readonly failed: readonly string[]
}): number => (!r.ran ? Number.POSITIVE_INFINITY : r.pass ? 0 : r.failed.length)

export interface ReproAcceptancePorts {
  /** Apply `patch` to the sandbox then run `probe(sandbox)`; `null` on empty/failed
   *  apply (degrades that candidate). Reset-to-base is guaranteed after the probe. */
  readonly withCandidatePatch: <T>(
    patch: string,
    probe: (sandbox: string) => Promise<T>,
  ) => Promise<T | null>
  /** Run the reproducing set on the (already patched) sandbox → did the issue RESOLVE. */
  readonly reproResolvedOnSandbox: (sandbox: string) => Promise<boolean>
  /** OPTIONAL dual-guard: run the selected regression set on the (already patched)
   *  sandbox → COUNT of failed tests. Present ⇒ the rerank gains the regression
   *  guard (Agentless dual-oracle); absent ⇒ repro-only. */
  readonly regressionFailuresOnSandbox?: (sandbox: string) => Promise<number>
  /** OPTIONAL LLM soft-reranker over the admissible survivors (chooser/reviewer
   *  knobs). Absent ⇒ deterministic vote only. Fail-open / never-veto. */
  readonly llmRerank?: AcceptanceLlmRerank
  /** OPTIONAL stronger vote-key normalizer (#3 Agentless-parity dedup,
   *  `QUANTA_BENCH_VOTE_NORMALIZE`). Absent ⇒ raw-trim key (byte-identical). */
  readonly normalizePatch?: (patch: string) => string
}

/** Build the repair `selectCandidates` port for the acceptance path (repro-only,
 *  or dual-guard when `regressionFailuresOnSandbox` is supplied), or `undefined` to
 *  keep the legacy selection (opt-in OFF / no reproducing set). */
export const buildReproAcceptanceSelector = (
  enabled: boolean,
  reproSources: readonly string[],
  ports: ReproAcceptancePorts,
):
  | ((candidates: readonly RepairCandidateOutcome[]) => Promise<RepairCandidateOutcome>)
  | undefined => {
  if (!enabled || reproSources.length === 0) return undefined
  const runReproOnPatch = async (patch: string): Promise<boolean> =>
    (await ports.withCandidatePatch(patch, ports.reproResolvedOnSandbox)) === true
  // Dual-guard: a failed apply (`withCandidatePatch` null) ⇒ +Infinity failures so
  // the candidate loses the min-regression bar (consistent with the repro degrade).
  const regressionProbe = ports.regressionFailuresOnSandbox
  const runRegressionOnPatch =
    regressionProbe === undefined
      ? undefined
      : async (patch: string): Promise<number> =>
          (await ports.withCandidatePatch(patch, regressionProbe)) ?? Number.POSITIVE_INFINITY
  return maybeAcceptanceSelector({
    enabled: true,
    runReproOnPatch,
    ...(runRegressionOnPatch !== undefined ? { runRegressionOnPatch } : {}),
    ...(ports.llmRerank !== undefined ? { llmRerank: ports.llmRerank } : {}),
    ...(ports.normalizePatch !== undefined ? { normalizePatch: ports.normalizePatch } : {}),
  })
}
