/**
 * Pillar D — experiment LIFECYCLE registry (experiments ≠ features).
 *
 * The PROBLEM this solves: today nothing distinguishes a stable FEATURE
 * (always-on, shipped, no expiry) from an EXPERIMENT (default-OFF A/B knob under
 * measurement). So dead A/B knobs rot in place — verify-select sat in the tree
 * for weeks after it was proven harmful (it laundered correct patches into empty
 * diffs) because nothing FORCED a graduate-or-delete decision.
 *
 * The fix: every experiment is registered HERE with an owner, a hypothesis, and
 * an expiry. A ratchet (see tests/unit/kernel/experiment-lifecycle-ratchet.test.ts)
 * fails CI when an `active` experiment is past its expiry — forcing the owner to
 * either GRADUATE it (promote to a stable feature, drop the experiment meta) or
 * RETIRE it (delete the knob). `retiredKnobIds()` then feeds a follow-up sweep
 * that actually removes the dead knobs from the codebase.
 *
 * Everything here is PURE (no Date.now / new Date) — `today` is always passed in
 * so the burn-down is deterministic and testable.
 *
 * Additive: this registry is not wired into the live driver. It is the SSOT the
 * ratchet reads.
 */

import type { ExperimentMeta } from "@/config/knob-schema/contracts"

/** One registry row: the knob id and its lifecycle metadata. */
export interface ExperimentEntry {
  readonly knobId: string
  readonly meta: ExperimentMeta
}

/**
 * The experiment registry. Two real states are seeded:
 *
 *  - RETIRED: the verify-select family. It was the headline dead-knob this pillar
 *    exists to catch — a verify-and-select loop that rejected good patches and
 *    emitted empty diffs, superseded by the closure-repair loop. Past expiry +
 *    `retired` ⇒ scheduled for deletion (a follow-up sweep removes the knobs).
 *
 *  - ACTIVE: repro-vote — a genuine, currently-running A/B (K-of-N resolved gate)
 *    with a near-future expiry, so the registry demonstrates BOTH states and the
 *    ratchet has a live `active` row to burn down.
 */
export const EXPERIMENTS: readonly ExperimentEntry[] = [
  // --- RETIRED: the verify-select family (the canonical dead-knob) ---
  {
    knobId: "verify-select",
    meta: {
      owner: "bench-scaffold",
      hypothesis:
        "Generating N candidate patches and selecting the one a repro oracle marks resolved beats single-pass. REFUTED: the selector laundered correct patches into empty diffs (false-negative repro oracles rejecting good fixes); superseded by the closure-repair loop.",
      expiry: "2026-06-20",
      status: "retired",
    },
  },
  {
    knobId: "verify-select-repro",
    meta: {
      owner: "bench-scaffold",
      hypothesis:
        "verify-select sub-arm gating selection on a generated repro test. Retired with the family — the repro oracle failed to reproduce ~45% of the time, so selection ran on noise.",
      expiry: "2026-06-20",
      status: "retired",
    },
  },
  {
    knobId: "verify-select-regression",
    meta: {
      owner: "bench-scaffold",
      hypothesis:
        "verify-select sub-arm adding a regression gate to candidate selection. Retired with the family — measured failures were ~79% pure not-fixed vs ~21% regression, so the regression gate was minor and not worth the laundering risk.",
      expiry: "2026-06-20",
      status: "retired",
    },
  },
  // --- ACTIVE: repro-vote (a live A/B with a near-future expiry) ---
  {
    knobId: "repro-vote",
    meta: {
      owner: "bench-scaffold",
      hypothesis:
        "A K-of-N 'resolved' vote across candidate patches (using the generated repro oracle as the voter) raises resolved-rate without the patch-laundering failure mode that killed verify-select. Under measurement; readout = oracle consistency, not raw verdict.",
      expiry: "2026-07-31",
      status: "active",
    },
  },
]

/** Lookup the lifecycle metadata for a knob, or `undefined` if not an experiment. */
export function experimentByKnob(knobId: string): ExperimentMeta | undefined {
  return EXPERIMENTS.find((e) => e.knobId === knobId)?.meta
}

/**
 * The burn-down predicate: registry rows that are still `active` but whose expiry
 * is strictly before `today` (both ISO YYYY-MM-DD strings; lexical compare is a
 * valid date compare for that format). A non-empty result is a ratchet failure —
 * each such experiment must graduate or retire.
 *
 * Pure: `today` is passed in, never read from the clock.
 */
export function expiredActiveExperiments(
  today: string,
  registry: readonly ExperimentEntry[] = EXPERIMENTS,
): ExperimentEntry[] {
  return registry.filter((e) => e.meta.status === "active" && e.meta.expiry < today)
}

/**
 * The knob ids of every `retired` experiment — the worklist for a follow-up
 * sweep that deletes the dead knobs (schema, env wiring, read sites, docs).
 */
export function retiredKnobIds(registry: readonly ExperimentEntry[] = EXPERIMENTS): string[] {
  return registry.filter((e) => e.meta.status === "retired").map((e) => e.knobId)
}
