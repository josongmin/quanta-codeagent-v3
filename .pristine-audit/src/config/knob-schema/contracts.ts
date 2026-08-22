/**
 * SOTA architecture spine — the cross-pillar CONTRACTS (types only, no logic).
 *
 * These are the shared seams the four pillars are built against so the parallel
 * work meshes:
 *   - Pillar A (config = schema SSOT): {@link KnobSchema} is the SINGLE
 *     declaration of a knob; registry / inventory / posture / CLI / docs are
 *     DERIVED from `KnobSchema[]`, never hand-maintained in parallel lists.
 *   - Pillar C (preset = pipeline spec): {@link PresetSpec} names ordered step
 *     ids + param overrides; the resolved knob map is GENERATED from it (one
 *     SSOT — no literal-vs-composite double-book, no byte-identical oracle).
 *   - Pillar D (experiments ≠ features): a `KnobSchema.experiment` marks a knob
 *     as a time-boxed A/B with an owner + expiry; past expiry an experiment MUST
 *     graduate (become a stable feature, drop the meta) or be retired/deleted —
 *     enforced by a ratchet, so dead knobs cannot rot in place.
 *
 * The pipeline contract ({@link Step}) lives in `./pipeline` (Pillar B). The
 * eval-CONCRETE context + step alias live in `./eval-step` (Pillar B impl).
 *
 * Additive: nothing here is wired into the live driver yet.
 */

/** Application surfaces a knob can apply to. Inlined (not imported from
 *  @/runner/knobs/types) to keep this contracts module dependency-light.
 *  jul-4 F1: now derived from the @/shared execution-mode surface SSOT (was a third copy-paste). */
export type Surface = import("@/shared/execution-surface").ExecutionSurface

/** Registry knob category (`--help` grouping). Inlined (not imported from
 *  @/runner/knobs/types) to keep this contracts module a config-light leaf.
 *  Kept structurally equal to the runner `KnobCategory` union. */
export type KnobCategory = "agent" | "tool" | "hint" | "verify" | "validation"

/** The storage/parse shapes a knob can take. Mirrors the existing inventory knob
 *  kinds (incl. `"float"`, used by e.g. no-patch-force-fraction) so a `KnobSchema`
 *  can be the SSOT the current `Knob`/inventory/posture derive from during the
 *  strangler migration. */
export type KnobKind = "bool" | "int" | "float" | "enum" | "string"

/** Domain constraint: enum members, or an inclusive [min, max] for ints. Used to
 *  validate raw values at resolve time (Pillar A: "garbage validated at startup"). */
export type KnobDomain =
  | { readonly enum: readonly string[] }
  | { readonly range: readonly [number, number] }

/**
 * Pillar D — experiment lifecycle metadata. PRESENT on a `KnobSchema` ⇒ the knob
 * is an EXPERIMENT (default-OFF A/B), not a shipped stable feature. Absent ⇒ a
 * stable feature/dial. The expiry forces a decision: an experiment past its date
 * must be graduated (delete `experiment`, keep the knob as a feature) or retired
 * (delete the knob). A ratchet reads these and fails CI on an expired `active`.
 */
export interface ExperimentMeta {
  /** Who owns the measurement + the graduate/retire decision. */
  readonly owner: string
  /** The A/B hypothesis being tested (so a stale flag's intent is never lost). */
  readonly hypothesis: string
  /** ISO date (YYYY-MM-DD). Past this, status `active` is a ratchet failure. */
  readonly expiry: string
  /** Lifecycle state. `active` = under measurement; `graduated` = promoted (knob
   *  kept, meta should be removed next pass); `retired` = scheduled for deletion. */
  readonly status: "active" | "graduated" | "retired"
}

/**
 * Pillar A — the SINGLE source of truth for one knob. Everything the system needs
 * about a knob is HERE; registry, inventory entry, BenchPosture field, CLI flag,
 * /config surface, default-OFF proof, and docs are all DERIVED from `KnobSchema[]`
 * (see `./derive`). No more 4 hand-maintained parallel lists (bootstrap import /
 * import-bundle / inventory / posture) drifting out of sync.
 *
 * Generic over `T` = the parsed value type.
 */
export interface KnobSchema<T = unknown> {
  /** Canonical knob id (kebab-case), e.g. "repro-test". */
  readonly id: string
  /** Environment variable, e.g. "QUANTA_BENCH_REPRO_TEST". */
  readonly envKey: string
  readonly kind: KnobKind
  /** Registry knob category (`--help` grouping). Omit ⇒ `"validation"` (the
   *  common case). The registry `Knob.category` derives from this; the inventory
   *  does NOT use it (inventory groups by `home`). */
  readonly category?: KnobCategory
  /** Optional value-domain for validation/derivation. */
  readonly domain?: KnobDomain
  /** Resolved default when unset. `undefined` ⇒ the feature is OFF by default
   *  (the byte-identical baseline) — the default-OFF ratchet derives from this. */
  readonly default: T | undefined
  /** One-line human description (the inventory `describe` is derived from this). */
  readonly describe: string
  /** Source file that CONSUMES the knob (inventory-readSite truthfulness derives
   *  from this — a stale path is a ratchet failure). */
  readonly readSite: string
  /** Which application surfaces this knob applies to. */
  readonly surfaces: readonly Surface[]
  /** Parse a raw env string to the typed value, or `undefined` when the raw does
   *  not denote a value (keeps the existing knob parse semantics). */
  readonly parse: (raw: string | undefined) => T | undefined
  /** Present ⇒ this knob is an EXPERIMENT with a lifecycle (Pillar D). */
  readonly experiment?: ExperimentMeta
  /** Matrix-budget multiplier (registry `Knob.costMultiplier`; default 1). Used at
   *  runtime in the bench matrix-budget Σ (driver.ts) — MUST be carried by the
   *  schema so `deriveKnob` never silently drops a knob's cost weight. */
  readonly costMultiplier?: number
  /** ESCAPE HATCH — when the registry knob's `describe` differs from the (terser)
   *  inventory `describe`, the knob's richer text goes here. `deriveKnob` uses
   *  `knobDescribe ?? describe`; `deriveInventoryEntry` always uses `describe`.
   *  Keeps BOTH artifacts byte-identical (one schema, two texts where they
   *  legitimately diverge) instead of forcing a single canonical + churning the
   *  inventory. Omit when knob + inventory describe already agree. */
  readonly knobDescribe?: string
  /** Display unit for the value (registry `Knob.unit`). */
  readonly unit?: string
  /** Provenance string (registry `Knob.source`). */
  readonly source?: string
  /** ESCAPE HATCH — the current hand-maintained inventory has a few idiosyncratic
   *  defaults the kind-convention can't infer (a `bool` recorded as `undefined`
   *  rather than `false`). Set this to the inventory's literal default cell to
   *  keep the derive byte-identical; a follow-up NORMALIZE pass removes both the
   *  idiosyncrasy and this override. Omit for the common case. */
  readonly inventoryDefault?: string | number | boolean | undefined
  /** ESCAPE HATCH — same: a few cross-surface knobs are filed under the `bench`
   *  home in the current inventory rather than the surface-derived `runner-knobs`.
   *  Set to pin the inventory home byte-identically. Omit for the common case. */
  readonly inventoryHome?: string
}

/** Any-typed knob schema for heterogeneous registries (mirrors `AnyKnob`). */
export type AnyKnobSchema = KnobSchema<unknown>

/**
 * Pillar C — a preset as a PIPELINE SPEC, not a frozen knob literal. Names the
 * ordered step ids the pipeline runs plus the param (knob) overrides those steps
 * read. The resolved knob map is GENERATED by `resolvePresetSpec` (see
 * `./preset-spec`), so there is exactly ONE source — the literal-vs-composite
 * duplication and its byte-identical golden oracle disappear.
 */
export interface PresetSpec {
  /** Preset id, e.g. "agentless-v6-singlepass-execfull". */
  readonly id: string
  /** Ordered step ids that compose the pipeline for this preset. */
  readonly steps: readonly string[]
  /** Knob-id → raw-value overrides applied on top of defaults for this preset. */
  readonly params: Readonly<Record<string, string>>
  /** Optional human note (provenance / why this preset exists). */
  readonly note?: string
}
