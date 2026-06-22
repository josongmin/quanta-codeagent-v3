/**
 * Posture injection seam (jun-22 v5 Wave-1 skeleton).
 *
 * The `agentless-v5-thin-and-expanded` controller needs to materialize a
 * DIFFERENT {@link BenchPosture} per phase (thin → expand → proof-clean → …)
 * WITHOUT mutating global env or re-resolving a single preset from the process
 * environment. Today posture is resolved ONCE at run start —
 * `prepareAttemptContext` calls `benchOptIns()` =
 * `benchPostureFromState(resolveBenchKnobs({ envVars: process.env }))` — and the
 * result is threaded as a plain `args.posture` parameter through the phase
 * runners. So the phase layer already accepts posture AS DATA; this module
 * supplies the missing pure COMPOSITION primitive.
 *
 * NOT-YET-DONE (Wave 3, do not assume free): `prepareAttemptContext` /
 * `runInstanceOnce` still re-derive posture from `process.env` internally and
 * expose no per-phase injection point — wiring this seam requires letting those
 * entrypoints accept an injected posture instead of calling `benchOptIns()`, and
 * passing a fresh per-phase posture into each phase entry. REPORT-FIDELITY
 * OBLIGATION: the derived `BenchKnobState` must then become the SINGLE object
 * feeding report serialization + the `knobs_applied` event + the agent config,
 * else the report keeps naming the base preset while a different posture actually
 * ran (the "report ≠ applied" split-brain this codebase forbids). Add a
 * report-fidelity test at wiring time; the equivalence hellgate's `behavioral()`
 * strip deliberately does NOT cover that path.
 *
 * This module is that seam. A {@link KnobModule} is a detachable capability
 * fragment expressed in the SAME vocabulary the presets use (knob id → raw
 * value). {@link withKnobModules} folds modules onto a base
 * {@link BenchKnobState}, and {@link derivePhasePosture} re-derives a posture
 * through the existing {@link benchPostureFromState} projector — so every
 * derived posture stays internally consistent (derived fields like `inLoopExec`
 * and the `liveOverrides` array are recomputed by the one canonical projector,
 * never hand-patched).
 *
 * Byte-identical fence: `withKnobModules(base, [])` returns `base` unchanged, so
 * `derivePhasePosture(base, [])` equals `benchPostureFromState(base)` exactly.
 * Nothing in this module is wired into the live driver yet — the v5 controller
 * (Wave 3) is its sole intended consumer. Its correctness is pinned instead by
 * the equivalence hellgate: each named composite reproduces an existing preset's
 * posture (see `capability-profiles.ts`).
 */

import type { KnobValue, KnobValueMap } from "@/runner/knobs"
import { type BenchKnobState, type BenchPosture, benchPostureFromState } from "../knobs-bench"

/**
 * A detachable capability fragment. `knobs` is a knob-id → raw-string map,
 * identical to a slice of a `KNOB_PRESETS` entry. The controller attaches/
 * detaches whole modules; it never emits raw posture fields.
 */
export interface KnobModule {
  /** Stable module name (telemetry / debug). */
  readonly id: string
  /** Knob-id → raw value, parsed through each knob's own `parse`. */
  readonly knobs: Readonly<Record<string, string>>
}

/**
 * Fold `modules` onto `base`, parsing each fragment value through the registered
 * knob's `parse`. Later modules win on key collision (last-write). Fragment keys
 * naming an UNREGISTERED knob, or whose raw value the knob's parser REJECTS, are
 * skipped (fail-open: a registry gap must never crash a run) — use
 * {@link unknownModuleKnobs} / {@link rejectedModuleKnobs} to surface those in
 * tests or telemetry.
 *
 * Pure: `base` (and `base.values`) is never mutated. Empty `modules` returns the
 * SAME state reference for the byte-identical fast path.
 */
export const withKnobModules = (
  base: BenchKnobState,
  modules: readonly KnobModule[],
): BenchKnobState => {
  if (modules.length === 0) return base
  const values = new Map<string, KnobValue<unknown>>(base.values)
  for (const mod of modules) {
    for (const [id, raw] of Object.entries(mod.knobs)) {
      const knob = base.knobs.get(id)
      if (knob === undefined) continue
      const parsed = knob.parse(raw)
      if (parsed === undefined) continue
      // Wave-3 obligation 3: a controller-injected phase value is NOT a named
      // preset. Tag it `phase-module` so the report attributes it to the v5
      // controller's per-phase fold instead of misnaming it as a preset that
      // never set it (the report still names the base preset elsewhere).
      values.set(id, { value: parsed, source: "phase-module" })
    }
  }
  const inactive = base.inactive.filter((id) => !values.has(id))
  // #5 symmetry: a phase module that supplies a valid value for a knob whose ENV
  // raw was rejected ACTIVATES it — so it must leave the `rejected` set too, just
  // like `inactive`. Without this re-filter the `...base` spread would carry a
  // stale rejected entry for a now-active knob.
  const rejected = base.rejected.filter((r) => !values.has(r.id))
  return { ...base, values: values as KnobValueMap, inactive, rejected }
}

/**
 * Materialize a phase posture: fold `modules` onto `base`, then re-derive
 * through the canonical projector so all derived fields stay consistent.
 * `derivePhasePosture(base, [])` is byte-identical to `benchPostureFromState(base)`.
 */
export const derivePhasePosture = (
  base: BenchKnobState,
  modules: readonly KnobModule[],
  env: NodeJS.ProcessEnv,
): BenchPosture => benchPostureFromState(withKnobModules(base, modules), env)

/** Fragment knob ids that name a knob NOT in the bench registry (typo guard). */
export const unknownModuleKnobs = (
  base: BenchKnobState,
  modules: readonly KnobModule[],
): readonly string[] => {
  const out: string[] = []
  for (const mod of modules)
    for (const id of Object.keys(mod.knobs)) if (!base.knobs.has(id)) out.push(`${mod.id}:${id}`)
  return out
}

/** Fragment entries whose raw value the knob's own parser rejects (misconfig). */
export const rejectedModuleKnobs = (
  base: BenchKnobState,
  modules: readonly KnobModule[],
): readonly string[] => {
  const out: string[] = []
  for (const mod of modules)
    for (const [id, raw] of Object.entries(mod.knobs)) {
      const knob = base.knobs.get(id)
      if (knob !== undefined && knob.parse(raw) === undefined) out.push(`${mod.id}:${id}=${raw}`)
    }
  return out
}
