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

import { maybeAcceptanceSelector } from "./acceptance-wire"
import type { RepairCandidateOutcome } from "./repair/types"

export interface ReproAcceptancePorts {
  /** Apply `patch` to the sandbox then run `probe(sandbox)`; `null` on empty/failed
   *  apply (degrades that candidate). Reset-to-base is guaranteed after the probe. */
  readonly withCandidatePatch: <T>(
    patch: string,
    probe: (sandbox: string) => Promise<T>,
  ) => Promise<T | null>
  /** Run the reproducing set on the (already patched) sandbox → did the issue RESOLVE. */
  readonly reproResolvedOnSandbox: (sandbox: string) => Promise<boolean>
}

/** Build the repair `selectCandidates` port for the repro-only acceptance path, or
 *  `undefined` to keep the legacy selection (opt-in OFF / no reproducing set). */
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
  return maybeAcceptanceSelector({ enabled: true, runReproOnPatch })
}
