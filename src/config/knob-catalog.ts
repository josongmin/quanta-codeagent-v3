/**
 * `@/config/knob-catalog.ts` — the UNIFIED knob view (ADR-0503 P3, UX layer).
 *
 * quanta declares knobs in 3 layer-bound registries (ADR-0503 §1, un-mergeable
 * physically by hexagonal layering): `@/apps/cli` CLI knobs, `@/config`
 * inventory (daemon/agent), `@/runner/knobs` (AgentConfig-mutating). This module
 * is the LOGICAL unification: a single `UnifiedKnob` shape + PURE functions to
 * merge / resolve / search / group them.
 *
 * Layering: this file is PURE and imports NOTHING from the registries (they live
 * above @/config). Each SURFACE (apps/cli, apps/web) reads its three source
 * lists and passes them to `mergeKnobCatalog(...)` — dependency-injection, no
 * upward import. That keeps the merge logic shared while honoring the fence.
 */

/** The lowest-common-denominator knob shape every registry maps onto. */
export interface UnifiedKnob {
  readonly envKey: string
  readonly kind: "bool" | "int" | "float" | "string" | "enum"
  /** Value when unset (`undefined` = no fixed default / value-bearing). */
  readonly default: boolean | number | string | undefined
  readonly describe: string
  /** UI bucket (cli render group, architectural layer, or @/runner category). */
  readonly group: string
  /** Which registry owns the declaration — drives the config UI's section + the
   *  read-routing target. */
  readonly home: "cli" | "runtime-config" | "runner-knobs" | "bench"
  /** Whether a `/config set` can change it live this session (only @/runner
   *  knobs with hotToggleable today; declaration-only knobs are restart-scoped). */
  readonly hotToggleable: boolean
  readonly readSite?: string
}

/** Minimal source rows each registry exposes (structurally compatible subsets). */
export interface CliKnobRow {
  readonly envKey: string
  readonly kind: UnifiedKnob["kind"]
  readonly default: UnifiedKnob["default"]
  readonly describe: string
  readonly group: string
  readonly readSite?: string
}
export interface InventoryRow extends CliKnobRow {
  readonly home: "runtime-config" | "runner-knobs" | "bench"
}
export interface RunnerKnobRow {
  readonly envKey: string
  readonly describe: string
  readonly category: string
  readonly default?: unknown
  readonly hotToggleable?: boolean
}

export interface CatalogSources {
  readonly cli: readonly CliKnobRow[]
  readonly inventory: readonly InventoryRow[]
  readonly runner: readonly RunnerKnobRow[]
}

const asScalar = (v: unknown): boolean | number | string | undefined =>
  typeof v === "boolean" || typeof v === "number" || typeof v === "string" ? v : undefined

/**
 * Merge the 3 registries into one canonical `envKey → UnifiedKnob` map.
 * Precedence on collision (a knob read on >1 surface): @/runner/knobs (richest,
 * has parse/apply/hotToggle) > inventory > cli. Deterministic, pure.
 */
export const mergeKnobCatalog = (sources: CatalogSources): ReadonlyMap<string, UnifiedKnob> => {
  const out = new Map<string, UnifiedKnob>()
  for (const k of sources.cli) {
    out.set(k.envKey, {
      envKey: k.envKey,
      kind: k.kind,
      default: k.default,
      describe: k.describe,
      group: k.group,
      home: "cli",
      hotToggleable: false,
      ...(k.readSite !== undefined ? { readSite: k.readSite } : {}),
    })
  }
  for (const k of sources.inventory) {
    out.set(k.envKey, {
      envKey: k.envKey,
      kind: k.kind,
      default: k.default,
      describe: k.describe,
      group: k.group,
      home: k.home,
      hotToggleable: false,
      ...(k.readSite !== undefined ? { readSite: k.readSite } : {}),
    })
  }
  // @/runner/knobs win (richest contract: real parse/apply + hot-toggle).
  for (const k of sources.runner) {
    out.set(k.envKey, {
      envKey: k.envKey,
      kind: "string", // @/runner Knob<T> encodes type in parse(); surface as string
      default: asScalar(k.default),
      describe: k.describe,
      group: k.category,
      home: "runner-knobs",
      hotToggleable: k.hotToggleable === true,
    })
  }
  return out
}

/** Flat, envKey-sorted list (for `--help` / list views). */
export const catalogList = (catalog: ReadonlyMap<string, UnifiedKnob>): readonly UnifiedKnob[] =>
  [...catalog.values()].sort((a, b) => (a.envKey < b.envKey ? -1 : a.envKey > b.envKey ? 1 : 0))

/** Group → knobs (for a sectioned config UI). Sections + members both sorted. */
export const catalogByGroup = (
  catalog: ReadonlyMap<string, UnifiedKnob>,
): ReadonlyMap<string, readonly UnifiedKnob[]> => {
  const buckets = new Map<string, UnifiedKnob[]>()
  for (const k of catalogList(catalog)) {
    const arr = buckets.get(k.group) ?? []
    arr.push(k)
    buckets.set(k.group, arr)
  }
  return new Map([...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

/** Fuzzy substring search over envKey + describe + group (for `/knobs find` /
 *  web filter). Case-insensitive; ranks envKey-prefix hits first. */
export const searchCatalog = (
  catalog: ReadonlyMap<string, UnifiedKnob>,
  query: string,
): readonly UnifiedKnob[] => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return catalogList(catalog)
  const hits: { k: UnifiedKnob; score: number }[] = []
  for (const k of catalog.values()) {
    const env = k.envKey.toLowerCase()
    const score = env.startsWith(`quanta_${q}`) || env === q ? 0 : env.includes(q) ? 1 : 2
    if (
      env.includes(q) ||
      k.describe.toLowerCase().includes(q) ||
      k.group.toLowerCase().includes(q)
    ) {
      hits.push({ k, score })
    }
  }
  return hits
    .sort((a, b) => a.score - b.score || (a.k.envKey < b.k.envKey ? -1 : 1))
    .map((h) => h.k)
}

/** One resolved knob value + where it came from (for `/config`/web "current"). */
export interface ResolvedKnobValue {
  readonly envKey: string
  readonly raw: string | undefined
  readonly source: "env" | "session" | "default"
  readonly isDefault: boolean
}

/**
 * Resolve the live RAW value + source for every catalog knob, given the env bag
 * + session overrides (`/config set`). Precedence env > session > default. Pure
 * (no process.env reach — the surface injects the bag). Raw strings only; typed
 * parsing stays at each knob's read site (declaration-only model).
 */
export const resolveCatalogValues = (
  catalog: ReadonlyMap<string, UnifiedKnob>,
  env: Readonly<Record<string, string | undefined>>,
  session: Readonly<Record<string, string | undefined>> = {},
): ReadonlyMap<string, ResolvedKnobValue> => {
  const out = new Map<string, ResolvedKnobValue>()
  for (const k of catalog.values()) {
    const envV = env[k.envKey]
    const sesV = session[k.envKey]
    if (envV !== undefined) out.set(k.envKey, { envKey: k.envKey, raw: envV, source: "env", isDefault: false })
    else if (sesV !== undefined)
      out.set(k.envKey, { envKey: k.envKey, raw: sesV, source: "session", isDefault: false })
    else {
      const d = k.default
      out.set(k.envKey, {
        envKey: k.envKey,
        raw: d === undefined ? undefined : String(d),
        source: "default",
        isDefault: true,
      })
    }
  }
  return out
}
