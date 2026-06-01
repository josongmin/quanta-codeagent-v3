/**
 * Layered policy/config merge engine — explicit source layers + per-field
 * override-tracking metadata.
 *
 * WHY this slice exists. quanta already has two narrow layering primitives:
 *   - `PermissionScope` precedence (`permission-profile.ts` {@link strongerScope}) —
 *     orders FOUR scopes (managed > project > user > open) but only as a
 *     scalar "which scope wins" helper; it does NOT merge a struct.
 *   - `repo-rules`/`glob-rules` 3-layer (project > user > system) — but that is
 *     PROMPT-TEXT concatenation, not a typed struct merge.
 *
 * Neither produces a MERGED struct with override metadata. Cursor
 * (`SandboxPolicyMergeSources{ per_user, per_repo, team_admin }`) and Codex
 * (`ConfigLayer` / `ConfigLayerSource` / `MergeStrategy` / `OverriddenMetadata`)
 * both ship a general layered-config engine that records, per field, which
 * source won and which sources it superseded. This slice absorbs that shape.
 *
 * SLICE RULES — pure, leaf-friendly. NO IO, NO state, NO side effects. Depends
 * on nothing outside this file (not even `@/shared`). Every function is a pure
 * mapping `inputs → outputs`; the same inputs always yield a deeply-equal
 * output. The permission layer COULD consume {@link resolvePolicyLayers}, but
 * this slice does NOT touch any existing default path — when unused the
 * existing code is byte-identical (proven by the hellgate battery).
 */

/**
 * The four config sources, ordered LEAST → MOST authoritative in
 * {@link LAYER_SOURCE_PRECEDENCE_ASC}. Mirrors Cursor's
 * `SandboxPolicyMergeSources{ per_user, per_repo, team_admin }` plus a
 * `default` baseline (the un-sourced shipped value).
 *
 * Precedence (most-authoritative wins): `team-admin > per-repo > per-user > default`.
 * An org admin's policy is the strongest; a repo's checked-in policy beats a
 * user's personal config; both beat the shipped default.
 */
export type LayerSource = "default" | "per-user" | "per-repo" | "team-admin"

/**
 * All {@link LayerSource} values ordered LEAST → MOST authoritative. The LAST
 * element wins a same-field conflict under `source-precedence`. Exported as a
 * runtime tuple so callers/tests enumerate without re-declaring the union, and
 * so {@link layerSourceRank} can derive a numeric rank by index.
 */
export const LAYER_SOURCE_PRECEDENCE_ASC = [
  "default",
  "per-user",
  "per-repo",
  "team-admin",
] as const satisfies ReadonlyArray<LayerSource>

/** Type guard — narrows `string` to {@link LayerSource} at a parse boundary. */
export const isLayerSource = (s: string): s is LayerSource =>
  s === "default" || s === "per-user" || s === "per-repo" || s === "team-admin"

/**
 * Numeric authority rank of a source: HIGHER = more authoritative. Derived from
 * the index in {@link LAYER_SOURCE_PRECEDENCE_ASC} so the ordering has a single
 * source of truth. `default` ⇒ 0 … `team-admin` ⇒ 3.
 *
 * The `switch` with a `never` default is the COMPILE-TIME exhaustiveness anchor:
 * adding a member to {@link LayerSource} without extending this switch fails
 * `tsc` (the `never` assignment errors), so the precedence table can never
 * silently omit a source.
 */
export const layerSourceRank = (s: LayerSource): number => {
  switch (s) {
    case "default":
      return 0
    case "per-user":
      return 1
    case "per-repo":
      return 2
    case "team-admin":
      return 3
    default: {
      const _exhaustive: never = s
      return _exhaustive
    }
  }
}

/**
 * One layer of partial config from a single source. The `value` is a
 * `Partial<T>` — a layer only declares the fields it wants to set; absent fields
 * defer to lower layers (and ultimately to `default`). Mirrors Codex `ConfigLayer`.
 */
export interface ConfigLayer<T> {
  readonly source: LayerSource
  readonly value: Partial<T>
}

/**
 * Merge strategy. Mirrors Codex `MergeStrategy`.
 *   - `source-precedence` — the most-authoritative source that SETS a field
 *     wins it (team-admin > per-repo > per-user > default).
 *   - `most-restrictive` — for fields with a declared restrictiveness ordering,
 *     the SAFER value wins REGARDLESS of source authority; fields without an
 *     ordering fall back to source-precedence. See {@link RestrictivenessSpec}.
 */
export type MergeStrategy = "source-precedence" | "most-restrictive"

/**
 * Per-field override record. For each field that ≥1 layer set, names the
 * winning source and the (possibly empty) list of OTHER sources that also set
 * the field but were superseded. Mirrors Codex `OverriddenMetadata`.
 *
 * `overrode` is ordered most-authoritative → least so an auditor reads the
 * "runner-up" first. A field set by exactly one layer has `overrode: []`.
 */
export interface OverriddenMetadata<T> {
  readonly field: keyof T
  readonly winner: LayerSource
  readonly overrode: ReadonlyArray<LayerSource>
}

/**
 * Restrictiveness ordering for `most-restrictive`. For a field `K`, the function
 * returns a numeric "safety rank": HIGHER = SAFER (more restrictive). When two
 * layers set the field, the one whose value has the higher safety rank wins.
 *
 * Why a per-field function rather than a global "false is safer" convention:
 * polarity is field-dependent. `workspaceWrite: false` is SAFER (rank false>true)
 * but `networkIsolated: true` is SAFER (rank true>false). A single global rule
 * cannot express both, so the SAFER direction must be declared per field.
 *
 * A field absent from the spec has no restrictiveness ordering ⇒ it falls back
 * to source-precedence under `most-restrictive`.
 */
export type RestrictivenessSpec<T> = {
  readonly [K in keyof T]?: (value: T[K]) => number
}

/** Result of {@link mergeLayered}. */
export interface MergeResult<T> {
  /** Fully merged value — every field resolved across the layers. */
  readonly merged: T
  /** Per-field override metadata for every field at least one layer set,
   *  in stable `keyof T` discovery order (sorted for determinism). */
  readonly overrides: ReadonlyArray<OverriddenMetadata<T>>
}

/** Options for {@link mergeLayered}. */
export interface MergeOptions<T> {
  /** The baseline `default`-source struct supplying any field NO layer sets.
   *  Required so the result is a complete `T` (not a `Partial<T>`). */
  readonly base: T
  readonly strategy: MergeStrategy
  /** Required for the `most-restrictive` strategy to have any effect; ignored
   *  by `source-precedence`. */
  readonly restrictiveness?: RestrictivenessSpec<T>
}

/**
 * Collect, per field, the sources that SET that field (i.e. `field in layer.value`),
 * ordered most-authoritative → least. Setting a field to `undefined` explicitly
 * still counts as "set" only if the key is PRESENT — we test key presence, not
 * value definedness, so a layer can intentionally carry an `undefined`.
 */
const collectSettersByField = <T extends object>(
  layers: ReadonlyArray<ConfigLayer<T>>,
): Map<keyof T, LayerSource[]> => {
  const byField = new Map<keyof T, LayerSource[]>()
  for (const layer of layers) {
    for (const key of Object.keys(layer.value) as Array<keyof T>) {
      const arr = byField.get(key) ?? []
      arr.push(layer.source)
      byField.set(key, arr)
    }
  }
  // Order each field's setters most-authoritative → least. Ties on source rank
  // (the SAME source appearing twice) preserve declaration order — the later
  // declaration of the same source is treated as the more recent intent, but
  // since rank is equal we keep insertion order which already reflects that.
  for (const [key, sources] of byField) {
    const sorted = [...sources].sort((a, b) => layerSourceRank(b) - layerSourceRank(a))
    byField.set(key, sorted)
  }
  return byField
}

/** Last value a given source set for a field (later same-source layer wins —
 *  "most recent declaration of the same source"). Returns the value plus a
 *  presence flag (so an explicit `undefined` is distinguishable from absent). */
const lastValueFromSource = <T extends object>(
  layers: ReadonlyArray<ConfigLayer<T>>,
  source: LayerSource,
  field: keyof T,
): { present: boolean; value: T[keyof T] | undefined } => {
  let present = false
  let value: T[keyof T] | undefined
  for (const layer of layers) {
    if (layer.source === source && field in layer.value) {
      present = true
      value = layer.value[field]
    }
  }
  return { present, value }
}

/**
 * Resolve a single field under `most-restrictive`: among the sources that set
 * the field, pick the one whose value has the highest safety rank. Ties on
 * safety rank break by source authority (more-authoritative wins). Returns the
 * winning source — the value is read back via {@link lastValueFromSource}.
 */
const restrictiveWinner = <T extends object>(
  layers: ReadonlyArray<ConfigLayer<T>>,
  field: keyof T,
  setters: ReadonlyArray<LayerSource>,
  rankOf: (value: T[keyof T]) => number,
): LayerSource => {
  let winner = setters[0] as LayerSource
  let bestSafety = Number.NEGATIVE_INFINITY
  for (const source of setters) {
    const { value } = lastValueFromSource(layers, source, field)
    const safety = rankOf(value as T[keyof T])
    if (
      safety > bestSafety ||
      (safety === bestSafety && layerSourceRank(source) > layerSourceRank(winner))
    ) {
      bestSafety = safety
      winner = source
    }
  }
  return winner
}

/**
 * Merge a list of {@link ConfigLayer}s into a complete `T` plus per-field
 * {@link OverriddenMetadata}.
 *
 * Determinism: the result depends ONLY on the (source, value) content of the
 * layers and the strategy — NOT on layer array order, except that two layers of
 * the SAME source resolve to the LATER one (most-recent same-source intent).
 * Different orderings of DISTINCT sources produce a deeply-equal result.
 *
 * Empty layers ⇒ `merged === base` (clone) and `overrides === []`.
 */
export const mergeLayered = <T extends object>(
  layers: ReadonlyArray<ConfigLayer<T>>,
  options: MergeOptions<T>,
): MergeResult<T> => {
  const { base, strategy, restrictiveness } = options
  const merged: T = { ...base }
  const settersByField = collectSettersByField(layers)
  const overrides: Array<OverriddenMetadata<T>> = []

  // Stable field iteration: sort discovered fields by their string key so the
  // overrides array is order-independent w.r.t. layer declaration order.
  const fields = [...settersByField.keys()].sort((a, b) => String(a).localeCompare(String(b)))

  for (const field of fields) {
    const setters = settersByField.get(field) as LayerSource[]
    const rankOf = restrictiveness?.[field]
    const useRestrictive = strategy === "most-restrictive" && rankOf !== undefined

    const winner = useRestrictive
      ? restrictiveWinner(layers, field, setters, rankOf)
      : // source-precedence (or most-restrictive with no ordering for this
        // field): setters are already most-authoritative-first.
        (setters[0] as LayerSource)

    const { value } = lastValueFromSource(layers, winner, field)
    merged[field] = value as T[keyof T]

    // `overrode` = every setter EXCEPT the single winning instance. When the
    // same source set the field more than once (e.g. two `per-repo` layers),
    // the LATER one is the winner and the EARLIER same-source layer is recorded
    // as superseded — so we drop exactly one occurrence of `winner`, not all.
    const overrode: LayerSource[] = []
    let winnerDropped = false
    for (const s of setters) {
      if (!winnerDropped && s === winner) {
        winnerDropped = true
        continue
      }
      overrode.push(s)
    }
    overrides.push({ field, winner, overrode })
  }

  return { merged, overrides }
}

/**
 * Thin convenience the permission layer COULD consume: build the layer list
 * from named slots and merge with the supplied base + strategy. Purely a
 * shaping helper over {@link mergeLayered} — no behaviour the engine doesn't
 * already have. Slots are emitted in canonical ascending-authority order; any
 * absent slot is simply omitted (no empty layer).
 *
 * This does NOT wire into any existing default path — it is an opt-in entry the
 * composition root may call later. Unused ⇒ zero effect.
 */
export const resolvePolicyLayers = <T extends object>(
  slots: {
    readonly default?: Partial<T>
    readonly perUser?: Partial<T>
    readonly perRepo?: Partial<T>
    readonly teamAdmin?: Partial<T>
  },
  options: MergeOptions<T>,
): MergeResult<T> => {
  const layers: Array<ConfigLayer<T>> = []
  if (slots.default !== undefined) layers.push({ source: "default", value: slots.default })
  if (slots.perUser !== undefined) layers.push({ source: "per-user", value: slots.perUser })
  if (slots.perRepo !== undefined) layers.push({ source: "per-repo", value: slots.perRepo })
  if (slots.teamAdmin !== undefined) layers.push({ source: "team-admin", value: slots.teamAdmin })
  return mergeLayered(layers, options)
}
