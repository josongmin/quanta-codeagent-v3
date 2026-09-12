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
import { ALL_PERMISSION_MODES } from "@/permission"

export interface UnifiedKnob {
  readonly envKey: string
  readonly kind: "bool" | "int" | "float" | "string" | "enum" | "list"
  /** Value when unset (`undefined` = no fixed default / value-bearing). `list` ⇒
   *  the delimited-string knobs whose runtime default is `[]`. */
  readonly default: boolean | number | string | readonly string[] | undefined
  readonly describe: string
  /** UI bucket (cli render group, architectural layer, or @/runner category). */
  readonly group: string
  /** Which registry owns the declaration — drives the config UI's section + the
   *  read-routing target. */
  readonly home: "cli" | "runtime-config" | "runner-knobs" | "bench"
  /** Whether a `/config set` can change it live this session (only @/runner
   *  knobs COULD carry hotToggleable; declaration-only knobs are restart-scoped).
   *  Measured: ZERO of the 674 catalog rows are `hotToggleable: true` — the last
   *  one, `QUANTA_PERSONA`, was corrected to `false` because its apply path was
   *  dead. The live-toggle branches downstream are therefore unreachable today;
   *  `knobs-set-liveness-honesty-hellgate` pins that as a fact, not an intent. */
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

/** Typed runtime-config knobs (consumed as `runtimeConfig().field`; declared in
 *  `@/shared/runtime-config-knobs`). Always `home: "runtime-config"`. */
export interface RuntimeConfigRow {
  readonly envKey: string
  readonly kind: UnifiedKnob["kind"]
  readonly default: UnifiedKnob["default"]
  readonly describe: string
  readonly group: string
}

export interface CatalogSources {
  readonly cli: readonly CliKnobRow[]
  readonly inventory: readonly InventoryRow[]
  readonly runtimeConfig?: readonly RuntimeConfigRow[]
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
  // typed runtime-config knobs — authoritative over the inventory's "should-be"
  // duplicates (same envKey), still beaten by @/runner's richer contract.
  for (const k of sources.runtimeConfig ?? []) {
    out.set(k.envKey, {
      envKey: k.envKey,
      kind: k.kind,
      default: k.default,
      describe: k.describe,
      group: k.group,
      home: "runtime-config",
      hotToggleable: false,
    })
  }
  // @/runner/knobs win (richest contract: real parse/apply + hot-toggle).
  for (const k of sources.runner) {
    const prev = out.get(k.envKey)
    out.set(k.envKey, {
      envKey: k.envKey,
      kind: "string", // @/runner Knob<T> encodes type in parse(); surface as string
      default: asScalar(k.default) ?? prev?.default,
      describe: k.describe,
      group: k.category,
      home: "runner-knobs",
      hotToggleable: k.hotToggleable === true,
      ...(prev?.readSite !== undefined ? { readSite: prev.readSite } : {}),
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

/**
 * Closed valid-value sets for enum knobs (ADR-0503 P4 — `/knobs set` validation
 * + web option lists). SSOT for the sets, kept HERE (not threaded through every
 * registry) so it's one place to extend. Only knobs with a genuinely CLOSED set
 * (confirmed against the reader) appear — open-set enums (named permission
 * profiles, etc.) are deliberately ABSENT, so `/knobs set` accepts any value for
 * them (the reader still validates). A NEW closed enum should add its set here.
 */
export const KNOB_ENUM_VALUES: ReadonlyMap<string, readonly string[]> = new Map([
  // The startup permission posture. It is declared `kind: "enum"` and its describe
  // names the four values, but it was absent here — so `setCatalogKnob`'s membership
  // gate saw `allowed === undefined` and accepted anything. Derived from the closed
  // union, never re-typed.
  ["QUANTA_PERMISSION", [...ALL_PERMISSION_MODES]],
  ["QUANTA_LOG_LEVEL", ["debug", "info", "warn", "error"]],
  ["QUANTA_PTY_BACKEND", ["tmux", "bun", "both"]],
  ["QUANTA_PROMPT_CACHE_TTL", ["5m", "1h"]],
  ["QUANTA_TLS_MITM_ON_FAILURE", ["deny", "opaque-tunnel"]],
  ["QUANTA_NOTIFY", ["off", "bell", "title"]],
  ["QUANTA_SHELL_SNAPSHOT_SHELL", ["auto", "zsh", "bash"]],
  ["QUANTA_TOOL_PROFILE", ["read", "write", "execute", "all"]],
])

/** Closed valid set for an enum knob, or `undefined` (open set ⇒ accept any). */
export const knobEnumValues = (envKey: string): readonly string[] | undefined =>
  KNOB_ENUM_VALUES.get(envKey)

/** One resolved knob value + where it came from (for `/config`/web "current"). */
export interface ResolvedKnobValue {
  readonly envKey: string
  readonly raw: string | undefined
  readonly source: "env" | "session" | "default"
  readonly isDefault: boolean
}

/**
 * Display-safe value for ANY surface (`/knobs all`, web `/api/knobs`). A CUSTOM
 * free-form STRING value (source env/session) may hold a filesystem path, a
 * credential-helper command line, or policy JSON — never surface it verbatim
 * where output can be pasted/transmitted. Bounded bool/int/float/enum values and
 * registry DEFAULTS (public, in-source) are shown. Single SSOT so CLI + web can't
 * drift on what's sensitive. (ADR-0503 P3 security re-audit.)
 */
export const displaySafeValue = (
  kind: UnifiedKnob["kind"],
  raw: string | undefined,
  source: string | undefined,
): string | undefined =>
  kind === "string" && raw !== undefined && source !== undefined && source !== "default"
    ? "[redacted]"
    : raw

/**
 * Resolve the live RAW value + source for every catalog knob, given the env bag
 * + session overrides (`/knobs set`). Precedence session > env > default —
 * matching the ACTUAL read chain (`readCliKnob` / `runtimeConfig` resolve the
 * shared session override first), so what this displays is what a reader gets
 * (WS-D jul-10: display copy derives from the effective store, it never lies
 * about precedence). Pure (no process.env reach — the surface injects the
 * bag). Raw strings only; typed parsing stays at each knob's read site
 * (declaration-only model).
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
    if (sesV !== undefined)
      out.set(k.envKey, { envKey: k.envKey, raw: sesV, source: "session", isDefault: false })
    else if (envV !== undefined)
      out.set(k.envKey, { envKey: k.envKey, raw: envV, source: "env", isDefault: false })
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
