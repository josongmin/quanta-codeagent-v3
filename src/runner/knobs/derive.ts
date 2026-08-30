/**
 * Pillar A — DERIVE the registry {@link Knob} from a knob's single
 * {@link KnobSchema} (the config-leaf data SSOT).
 *
 * THE PROBLEM (jun-26 knob-config-systems-inventory): the same knob list is
 * hand-maintained in 4 parallel places that already drift —
 *   - bootstrap import set (~22),
 *   - knobs-import-bundle `ALL_KNOBS` (~65),
 *   - knob-inventory bench list (~75),
 *   - `BenchPosture` fields (~39).
 * A new knob must be touched in all 4 or a ratchet bites.
 *
 * THE FIX: declare a knob ONCE as a `KnobSchema` (the SSOT) and DERIVE the rest.
 *
 * The schema spine ({@link KnobSchema}) + the authored bench schemas now live in
 * the CONFIG LEAF (`@/config/knob-schema/*`), so the inventory can derive from
 * them without a config→runner back-edge. The runner imports the schemas FORWARD
 * (runner→config is allowed). The leaf-clean inventory-derive functions live in
 * `@/config/knob-schema/derive-inventory`; THIS module keeps only `deriveKnob`,
 * which needs the runner `AgentConfig`/`Knob` types.
 *
 * HOME (aug-30 structural audit G3-01): this module lives in the knob slice —
 * it needs nothing from `@/runner/batch`, and its ~55 importers are the knob
 * files themselves, so hosting it under `batch/eval/kernel/` pointed the core
 * knob framework at an app-level consumer (a wrong-direction edge closing a
 * batch↔knobs import SCC). `batch/eval/kernel/derive.ts` remains as a forward
 * shim (batch→knobs, the allowed direction).
 *
 * Pure functions, zero side effects, no `registerKnob`, no env/fs reads.
 *
 * @see @/config/knob-schema/contracts — the `KnobSchema` spine.
 * @see @/config/knob-schema/schemas — the authored bench `KnobSchema[]`.
 * @see @/config/knob-schema/derive-inventory — the leaf-clean inventory derive.
 * @see ./types — the registry `Knob` shape we reproduce.
 */

import type { AgentConfig } from "@/agent"
import type { AnyKnobSchema, KnobSchema } from "@/config/knob-schema/contracts"
import type { Knob, Surface } from "./types"

/** NOOP apply — the default for bench knobs consumed out of band via posture. */
const NOOP_APPLY = <T>(cfg: AgentConfig, _value: T, _ctx: { surface: Surface }): AgentConfig => cfg

/** Runner-side relationship bindings — `conflicts`/`requires` reference OTHER
 *  knob ids (resolver validation), a runner-registration concern that the
 *  config-leaf schema does not model. Supplied at the derive site alongside
 *  `apply`; carried onto the Knob ONLY when present (byte-identical otherwise). */
export interface KnobRelationships {
  readonly conflicts?: readonly string[]
  readonly requires?: readonly string[]
}

/**
 * Derive a registry {@link Knob} from a {@link KnobSchema} (the config-leaf data
 * SSOT) plus an OPTIONAL `apply` binding and OPTIONAL relationship bindings.
 *
 * The `apply` lives at the RUNNER registration, NOT on the schema: it needs the
 * runner `AgentConfig` type, so putting it on the schema would force the schema
 * out of the config leaf (and break the inventory derive). Most bench knobs are
 * consumed out of band via `BenchPosture`, so `apply` defaults to a NOOP; the few
 * real-apply knobs (repo-map / multi-voter / network-proxy …) pass their `apply`
 * here. `parse` IS the schema's parse (same reference ⇒ identical semantics).
 *
 * `conflicts`/`requires` likewise reference other RUNNER knob ids (resolver
 * validation), not config-leaf data — the few knobs that declare them
 * (branch-search ⇄ localize-phase, multi-voter→branch-search) pass them here so
 * the derived knob keeps its relationship metadata.
 *
 * Single source: the data (id/envKey/kind/default/describe/readSite/parse) comes
 * from the ONE schema; only the AgentConfig-bound `apply` + relationships are
 * supplied at the runner boundary. No hand-written Knob object duplicates the data.
 */
export const deriveKnob = <T>(
  schema: KnobSchema<T>,
  apply?: Knob<T>["apply"],
  relationships?: KnobRelationships,
): Knob<T> => ({
  id: schema.id,
  envKey: schema.envKey,
  // Category drives `--help` grouping; the inventory groups by `home` instead.
  // Omit on the schema ⇒ "validation" (the common case).
  category: schema.category ?? "validation",
  surfaces: schema.surfaces,
  parse: schema.parse,
  apply: apply ?? NOOP_APPLY,
  // Relationship metadata — carried only when supplied (a knob without these must
  // NOT gain an explicit `undefined` key, so the derived knob stays byte-identical).
  ...(relationships?.conflicts !== undefined ? { conflicts: relationships.conflicts } : {}),
  ...(relationships?.requires !== undefined ? { requires: relationships.requires } : {}),
  // Knob describe may be richer than the inventory describe; prefer it when set.
  describe: schema.knobDescribe ?? schema.describe,
  // NB: NO `default` field. The registry resolution (resolve.ts step 6) reads
  // `knob.default` as a value fallback; the hand knobs ALL omit it (the resolved
  // default comes from the bench posture / driver, not the registry). `schema.default`
  // feeds the INVENTORY entry + the default-OFF proof ONLY — emitting it here would
  // make resolve.ts return e.g. bench-in-loop-exec=true on unset (a behavior change,
  // NOT byte-identical). So it is deliberately not projected onto the Knob.
  // Matrix-budget / display / provenance fields — carried only when the schema
  // declares them, so a derived knob is byte-identical to the hand knob (a knob
  // without these must NOT gain an explicit `undefined` key).
  ...(schema.costMultiplier !== undefined ? { costMultiplier: schema.costMultiplier } : {}),
  ...(schema.unit !== undefined ? { unit: schema.unit } : {}),
  ...(schema.source !== undefined ? { source: schema.source } : {}),
})

// `AnyKnobSchema` re-export kept for callers that imported it alongside
// `deriveKnob` from this module (forward to the config-leaf contract SSOT).
export type { AnyKnobSchema }
