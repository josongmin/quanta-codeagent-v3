/**
 * CENTRAL bench-knob registrar — registration DERIVED from the schema barrel.
 *
 * THE FIX (jun-26 knob-config-systems-inventory): the bench knob list was
 * hand-maintained in parallel places that drift (bootstrap import set / barrel
 * import set / inventory / posture). This registrar makes the REGISTRY a derived
 * artifact of the ONE SSOT — `ALL_BENCH_SCHEMAS` (`@/config/knob-schema/schemas`).
 * It iterates the schema barrel and registers `deriveKnob(schema, apply?)` for
 * each schema that backs a registry Knob. No per-knob hand-import list.
 *
 * WHICH schemas back a registry Knob? `ALL_BENCH_SCHEMAS` (75) is the union of
 * (a) registry-Knob schemas (52 — they carry a `source` provenance string, the
 * field every registry knob declares) and (b) INVENTORY-ONLY schemas (23 — bench
 * infra/config dials like full-remote-*, resume, bench-preset that are consumed
 * out of band by the bench driver and are NOT `@/runner/knobs` Knobs). The split
 * is DATA-DERIVED from the schema (`source !== undefined`), not a hand-list — so
 * registering exactly the same 52 ids as the pre-unification per-file
 * self-registration, no knob added or dropped.
 *
 * APPLY is IRREDUCIBLE: a Knob's `apply` needs `AgentConfig` (a runner type) so
 * it cannot live on the config-leaf schema. The few knobs whose live `apply`
 * MUTATES cfg (vs the NOOP default) bind their applyFn here via APPLY_BINDINGS;
 * the applyFn DEFINITION still lives in the knob file (ONE definition, imported
 * here) so `deriveKnob(schema, apply)` is byte-identical to the live knob (proven
 * by the derive-parity full-Knob gates). Schemas with no binding default to NOOP.
 */

import { ALL_BENCH_SCHEMAS } from "@/config/knob-schema/schemas"
import { deriveKnob, type KnobRelationships } from "@/runner/batch/eval/kernel/derive"
// Non-NOOP applyFns — the ONLY definitions live in the knob files; imported here
// so the registrar's derived knob shares the SAME apply reference as the live
// knob export (byte-identical). A schema absent from this map ⇒ NOOP apply.
import { applyBranchSearch } from "./knobs/branch-search"
import { applyCloseoutGuard } from "./knobs/closeout-guard"
import { applyHooks } from "./knobs/hooks"
import { applyLocalizePhase } from "./knobs/localize-phase"
import { applyLsp } from "./knobs/lsp"
import { applyMultiVoter } from "./knobs/multi-voter"
import { applyMustPass } from "./knobs/must-pass"
import { applyRepoMap } from "./knobs/repo-map"
import { applyReproDoubt } from "./knobs/repro-doubt"
import { applySkills } from "./knobs/skills"
import { applySubagent } from "./knobs/subagent"
import { applyWorkingState } from "./knobs/working-state"
import { allKnobs, registerKnob } from "./registry"
import type { Knob } from "./types"

/**
 * Knob-id → non-NOOP `apply` binding. The 12 bench knobs whose live registry
 * `apply` MUTATES the AgentConfig (all others are NOOP — consumed out of band via
 * `benchPostureFromState`). Each applyFn is imported from its knob file (one
 * definition) so the derived knob is byte-identical to the live knob.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous apply value types
const APPLY_BINDINGS: Record<string, Knob<any>["apply"]> = {
  "branch-search": applyBranchSearch,
  "closeout-guard": applyCloseoutGuard,
  hooks: applyHooks,
  "localize-phase": applyLocalizePhase,
  lsp: applyLsp,
  "multi-voter": applyMultiVoter,
  "must-pass": applyMustPass,
  "repo-map": applyRepoMap,
  "repro-doubt": applyReproDoubt,
  skills: applySkills,
  subagent: applySubagent,
  "working-state": applyWorkingState,
}

/**
 * Runner-side relationship bindings (`conflicts`/`requires`) — reference OTHER
 * knob ids for resolver validation; not config-leaf data, so bound here. The
 * three knobs that declare relationships keep their pre-unification metadata.
 */
const RELATIONSHIP_BINDINGS: Record<string, KnobRelationships> = {
  "branch-search": { conflicts: ["localize-phase"] },
  "localize-phase": { conflicts: ["branch-search"] },
  "multi-voter": { requires: ["branch-search"] },
}

/**
 * A schema backs a registry Knob iff it declares a `source` provenance string.
 * The 23 inventory-only schemas (full-remote-*, resume, bench-preset, …) omit it
 * — they are bench-driver config dials, not `@/runner/knobs` Knobs. Data-derived
 * (NOT a hand-list) so the registered set never silently drifts from the SSOT.
 */
const backsRegistryKnob = (schema: { source?: string }): boolean => schema.source !== undefined

/**
 * Register every bench REGISTRY-Knob schema (derived from `ALL_BENCH_SCHEMAS`).
 * Idempotent under the registry's collision guard ONLY via the presence check —
 * we skip any id already registered so a repeat call (or a sibling that
 * self-registers a non-schema knob) never throws.
 */
export const registerBenchKnobs = (): void => {
  const reg = allKnobs()
  for (const schema of ALL_BENCH_SCHEMAS) {
    if (!backsRegistryKnob(schema)) continue
    if (reg.has(schema.id)) continue // already registered (repeat call / reset-recovery)
    registerKnob(deriveKnob(schema, APPLY_BINDINGS[schema.id], RELATIONSHIP_BINDINGS[schema.id]))
  }
}
