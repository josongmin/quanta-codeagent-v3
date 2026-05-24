/**
 * Tool-call collapse / dedup (ADR-0172 — sibling to ADR-0160 `instrument-tool.ts`).
 *
 * Closed-port `ToolCallCache` + LRU/TTL default impl + an `instrumentToolWithDedup`
 * wrap that, on a cache HIT within TTL, SKIPS the wrapped tool's `execute` and
 * yields the cached `ToolResult` — with the model-facing `output` PREFIXED by a
 * `[from_cache] ` marker so the model sees that this call was a repeat.
 *
 * MODEL-TRANSPARENCY INVARIANT — load-bearing.
 *   Silent skip (yield cached result with no marker) would break the model's
 *   call-order assumption: from the model's POV it called the tool again and
 *   expects a fresh observation. Yielding identical bytes makes the assistant
 *   think the world didn't move when it might have (TTL is a heuristic; the
 *   underlying FS/process state CAN change inside the window). Marking the
 *   yielded `output` with `[from_cache] ` makes the cache an OBSERVABLE fact —
 *   the model can choose to invalidate by varying input or by asking again
 *   later, instead of being silently misled. This is the single decision that
 *   distinguishes us from a "transparent" cache (which would be incorrect for
 *   an LLM consumer).
 *
 *   The marker is ALSO the model's signal that two consecutive identical
 *   `tool_result` blocks are NOT a bug in the harness — the second one is
 *   tagged `[from_cache]` and the model learns to either change input or stop
 *   re-asking. Without it the model often gets stuck in a "I just called this,
 *   let me call again to verify" loop.
 *
 * Research grounding (none of these solve tool-CALL dedup; this is the first
 * typed primitive of its kind):
 *   - Cursor `Idempotent{,SSE,Poll}` RPC variants — REQUEST-level retry safety
 *     (resending the same RPC), not tool-CALL dedup within a turn.
 *   - Cursor Merkle subtree reconciliation — FILE dedup (path-hash keying),
 *     not call dedup. Pattern reusable for shape but not direct.
 *   - Claude `cache_read_tokens` + `cache_control:{type:"ephemeral"}` ×4
 *     breakpoints — PROMPT-prefix cache; no tool-call cache.
 *   - Codex `cache/codex_apps_tools/{hash}.json` — offline tool-SCHEMA cache;
 *     no runtime call dedup.
 *
 * Counters emitted (default `namePrefix = "tool"`):
 *   tool.call.dedup_collapse.total      labels: tool
 *
 * Plane-clean. This module imports ONLY:
 *   - `./port`           (MetricsRegistry)
 *   - `@/tool`           (Tool / ToolContext / ToolEvent / ToolResult types)
 *   - `node:crypto`      (SHA-256 for the cache key)
 *
 * NO `@/agent`, `@/permission`, `@/llm`, `@/lsp`. NO new npm deps.
 *
 * Default-OFF. The caller must explicitly construct a `ToolCallCache` and pass
 * it to `instrumentToolWithDedup`. `buildDefaultTools()` is NOT changed by this
 * file — every existing wiring path is byte-identical until a composition root
 * opts in.
 */

import { createHash } from "node:crypto"
// biome-ignore lint/style/noRestrictedImports: type-only @/tool import — wrap is a `Tool -> Tool` forwarder (sibling pattern of instrument-tool.ts; ADR-0172).
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"
import type { MetricsRegistry } from "./port"

const safe = (_metrics: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* observability emission must not break the wrapped call */
  }
}

// ── Stable JSON canonicalization ─────────────────────────────────────────
//
// Deterministic key: sort object keys at every level. Arrays preserve order
// (semantic), primitives/null pass through. Cyclic input is caught by a
// WeakSet (would otherwise blow the stack); on cycle we fall back to a sentinel
// to keep `computeKey` total. `undefined` properties are omitted (mirror of
// JSON.stringify); function/symbol values are also omitted for the same reason.

const normalizePrimitive = (v: unknown): unknown => {
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "undefined") {
    return undefined
  }
  // bigint is not JSON-representable; coerce to string so the key is total.
  if (typeof v === "bigint") return `__bigint__:${v.toString()}`
  return v
}

const walkValue = (v: unknown, seen: WeakSet<object>): unknown => {
  if (v === null || typeof v !== "object") return normalizePrimitive(v)
  if (seen.has(v)) return "__cycle__"
  seen.add(v)
  if (Array.isArray(v)) return v.map((x) => walkValue(x, seen))
  const obj = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    const w = walkValue(obj[k], seen)
    if (w !== undefined) out[k] = w
  }
  return out
}

const stableStringify = (value: unknown): string =>
  JSON.stringify(walkValue(value, new WeakSet<object>()))

// ── Closed-port: `ToolCallCache` ─────────────────────────────────────────

export interface ToolCallCache {
  /** Stable key for an `(toolName, input, ctx-scope)` triple. Implementations
   *  MUST be pure (no I/O, no clock) and total (never throw). */
  computeKey(toolName: string, input: unknown, ctx: ToolContext): string
  /** Lookup; `null` = miss (including stale/expired). */
  get(key: string): ToolResult | null
  /** Store result. TTL / eviction is implementation-defined.
   *  `toolName` is optional for back-compat (legacy callers); ADR-0179's
   *  per-tool TTL only takes effect when callers pass it. The
   *  `instrumentToolWithDedup` wrap always passes `tool.name`. */
  set(key: string, result: ToolResult, toolName?: string): void
  /** Drop all entries. Used by the default impl on demand + tests. */
  clear(): void
}

// ── Wrap options ─────────────────────────────────────────────────────────

export interface ToolDedupOpts {
  /** Counter name prefix. Default `"tool"` → `tool.call.dedup_collapse.total`. */
  readonly namePrefix?: string
  /** The cache (default impl below or a custom one). REQUIRED. */
  readonly cache: ToolCallCache
  /** Predicate decides whether THIS call is cacheable. Default behavior:
   *    cache iff `tool.isReadOnly() && tool.isConcurrencySafe(input) &&
   *               (tool.hitlTier?.(input) !== "always-confirm")`.
   *  Override to widen/narrow (e.g. only `read`/`grep`/`glob`). */
  readonly shouldCache?: (tool: Tool, input: unknown, ctx: ToolContext) => boolean
  /** Optional override of the tool label on the emitted counter. Defaults to
   *  `tool.name`. Useful when wrapping a generic family with a facet label. */
  readonly toolLabel?: string
}

// ── Default predicate ────────────────────────────────────────────────────

const defaultShouldCache = (tool: Tool, input: unknown, _ctx: ToolContext): boolean => {
  // `Tool.hitlTier` is optional (ToolSecurityHooks group). Treat absent as
  // "not always-confirm" — the predicate gates on EXPLICITLY-declared HITL.
  if (!tool.isReadOnly()) return false
  // `isConcurrencySafe` is required on every tool (ToolCore).
  if (!tool.isConcurrencySafe(input as never)) return false
  const tier = tool.hitlTier?.(input as never)
  if (tier === "always-confirm") return false
  return true
}

// ── Wrap ─────────────────────────────────────────────────────────────────

/**
 * Pure forwarding wrap with cache lookup + counter emit.
 *
 *   - Cache MISS  → byte-identical to `instrumentTool()` (just forwards the
 *                   tool's events) AND populates the cache with the terminal
 *                   `ToolResult` (success or failure — see ADR §"cache failures").
 *   - Cache HIT   → wrapped tool's `execute` is NOT called; the wrap yields a
 *                   SINGLE `{type:"result", result}` event whose `output` is
 *                   prefixed by `[from_cache] `, and increments
 *                   `tool.call.dedup_collapse.total{tool}` by 1.
 *
 * The cache key composes `toolName | stableStringify(input) | ctx.cwd` and is
 * SHA-256'd — short, fixed-length, collision-resistant.
 *
 * Metric emission is wrapped in `safe(…)`: a throwing `MetricsRegistry` MUST
 * NOT poison the cached-result path (HITL-equivalent of the existing
 * `instrument-tool.ts` invariant).
 */
export const instrumentToolWithDedup = <I>(
  tool: Tool<I>,
  metrics: MetricsRegistry,
  opts: ToolDedupOpts,
): Tool<I> => {
  const prefix = opts.namePrefix ?? "tool"
  const cache = opts.cache
  const shouldCache = opts.shouldCache ?? defaultShouldCache
  const toolLabel = opts.toolLabel ?? tool.name

  return {
    ...tool,
    async *execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const cacheable = shouldCache(tool as Tool, input as unknown, ctx)
      let key: string | null = null
      if (cacheable) {
        key = cache.computeKey(tool.name, input as unknown, ctx)
        const hit = cache.get(key)
        if (hit !== null) {
          safe(metrics, () =>
            metrics.increment(`${prefix}.call.dedup_collapse.total`, 1, { tool: toolLabel }),
          )
          // Yield the cached result with the transparency marker.
          const marked: ToolResult = { ...hit, output: `[from_cache] ${hit.output}` }
          yield { type: "result", result: marked }
          return
        }
      }
      // MISS (or non-cacheable): forward verbatim, capture terminal result.
      let terminal: ToolResult | null = null
      for await (const ev of tool.execute(input, ctx)) {
        if (ev.type === "result") terminal = ev.result
        yield ev
      }
      if (cacheable && key !== null && terminal !== null) {
        // Cache success AND failure — both are "this exact input produced this
        // exact result"; caller has the predicate to opt out for tools where
        // caching ok:false is wrong (see ADR).
        // ADR-0179: pass `tool.name` so the cache can apply per-tool TTL.
        cache.set(key, terminal, tool.name)
      }
    },
  }
}

// ── Default in-memory LRU/TTL cache ──────────────────────────────────────

export interface DefaultCacheOpts {
  /** Max entries. Default 200. Beyond cap, the LRU tail is evicted. */
  readonly maxEntries?: number
  /** Per-entry TTL in ms. Default 30_000 (30s). Past TTL ⇒ `get` returns `null`
   *  AND drops the entry inline (no separate sweeper). */
  readonly ttlMs?: number
  /**
   * ADR-0179: per-tool TTL override. Tool name → TTL ms.
   *
   * Falls through to the global `ttlMs` for tools not listed.
   * Setting an entry to `0` ⇒ never cache (every `get` is a miss; `set`
   *   stores nothing). This is the "always-stale" sentinel used to keep
   *   the `set` path total without a separate "skip" branch in the wrap.
   *
   * Inspired by Cursor's 4-tier freshness model (`cursor-localization.md`
   * — recent_edits overlay 0s / Rust debounce event-driven / 60s server
   * reconciliation / handshake ground truth) which proves staleness
   * tolerance is data-class specific; per-TOOL TTL is the call-level analog
   * (read vs grep vs bash).
   */
  readonly perToolTtlMs?: Readonly<Record<string, number>>
  /** Clock injection for tests. Default `Date.now`. */
  readonly now?: () => number
  /**
   * ADR-0183: when true, compare caller's `perToolTtlMs` to the audited
   * `RECOMMENDED_PER_TOOL_TTL_MS` preset AT CONSTRUCTION TIME and emit a
   * drift signal per divergent tool. Operator-facing log (via `onDriftWarn`)
   * + machine-facing counter (`tool.dedup.config_drift.total{tool, kind}`).
   *
   * Default false — comparison cost is zero and behavior is byte-identical
   * to ADR-0179 when omitted. Modeled after the operator-vs-machine split
   * of ADR-0169 (skipped-warning) + ADR-0175 (wired-gauge).
   *
   * Research grounding: Cursor's `FastRepoInitHandshakeV2` returns a per-
   * codebase status (`UP_TO_DATE` / `OUT_OF_SYNC` / `EMPTY`) at every
   * `doUpdate` cycle (cursor-localization.md §17.6) — a typed signal of
   * config-vs-state drift the caller can act on. Per-tool TTL drift is the
   * construction-time analog.
   */
  readonly checkRecommendedDrift?: boolean
  /** Operator-facing warn sink. Called ONCE with a combined message listing
   *  every drift (mirrors `ObservabilityOpts.warn` from ADR-0169). Default
   *  is a no-op — drift detection without a sink is metric-only. */
  readonly onDriftWarn?: (msg: string) => void
  /** Metric registry for the drift counter. When `checkRecommendedDrift` is
   *  true but `metrics` is absent, drift detection still fires the
   *  `onDriftWarn` log (graceful degradation: operator signal beats machine
   *  signal when only one is wired). */
  readonly metrics?: MetricsRegistry
}

// ── Drift kinds (closed enum) ────────────────────────────────────────────

/** ADR-0183: drift between caller `perToolTtlMs` and `RECOMMENDED_PER_TOOL_TTL_MS`. */
export type PerToolTtlDriftKind = "too-permissive" | "too-restrictive" | "missing" | "unknown-tool"

interface PerToolTtlDrift {
  readonly tool: string
  readonly kind: PerToolTtlDriftKind
}

/**
 * Compute the set of drifts between a caller's `perToolTtlMs` map and the
 * RECOMMENDED preset. Pure / total: union the keys, classify each.
 *
 *   - caller > preset           → "too-permissive" (caching MORE than recommended;
 *                                  staleness risk grows with the delta)
 *   - caller < preset           → "too-restrictive" (caching LESS than recommended;
 *                                  cost-optimization missed; 0 < N also lands here)
 *   - preset has, caller lacks  → "missing" (caller falls through to global ttlMs
 *                                  which may or may not match preset)
 *   - caller has, preset lacks  → "unknown-tool" (custom tool — informational)
 *   - exact match               → no drift, skipped
 */
const classifyOnePerToolTtl = (
  presetVal: number | undefined,
  callerVal: number | undefined,
): PerToolTtlDriftKind | null => {
  if (presetVal === undefined && callerVal !== undefined) return "unknown-tool"
  if (presetVal !== undefined && callerVal === undefined) return "missing"
  if (presetVal === undefined || callerVal === undefined) return null
  if (presetVal === callerVal) return null
  return callerVal > presetVal ? "too-permissive" : "too-restrictive"
}

const computePerToolTtlDrifts = (
  caller: Readonly<Record<string, number>> | undefined,
  preset: Readonly<Record<string, number>>,
): ReadonlyArray<PerToolTtlDrift> => {
  const out: PerToolTtlDrift[] = []
  const presetKeys = Object.keys(preset)
  const callerKeys = caller === undefined ? [] : Object.keys(caller)
  const union = new Set<string>([...presetKeys, ...callerKeys])
  // Deterministic order for the combined message and counter emit.
  const ordered = [...union].sort()
  for (const tool of ordered) {
    const presetVal = preset[tool]
    const callerVal = caller === undefined ? undefined : caller[tool]
    const kind = classifyOnePerToolTtl(presetVal, callerVal)
    if (kind !== null) out.push({ tool, kind })
  }
  return out
}

const groupDriftsByKind = (
  drifts: ReadonlyArray<PerToolTtlDrift>,
): Record<PerToolTtlDriftKind, string[]> => {
  const groups: Record<PerToolTtlDriftKind, string[]> = {
    "too-permissive": [],
    "too-restrictive": [],
    missing: [],
    "unknown-tool": [],
  }
  for (const d of drifts) groups[d.kind].push(d.tool)
  return groups
}

const formatDriftMessage = (drifts: ReadonlyArray<PerToolTtlDrift>): string => {
  const g = groupDriftsByKind(drifts)
  const parts: string[] = []
  if (g["too-permissive"].length > 0)
    parts.push(`too-permissive=[${g["too-permissive"].join(",")}]`)
  if (g["too-restrictive"].length > 0)
    parts.push(`too-restrictive=[${g["too-restrictive"].join(",")}]`)
  if (g.missing.length > 0) parts.push(`missing=[${g.missing.join(",")}]`)
  if (g["unknown-tool"].length > 0) parts.push(`unknown=[${g["unknown-tool"].join(",")}]`)
  return (
    `[tool-dedup] ${drifts.length} drift(s) vs RECOMMENDED: ${parts.join(" ")}. ` +
    `Set 'checkRecommendedDrift:false' to silence or update perToolTtlMs to match.`
  )
}

const safeDriftSink = (fn: () => void): void => {
  try {
    fn()
  } catch {
    /* drift observability must not break cache construction */
  }
}

const reportPerToolTtlDrifts = (
  drifts: ReadonlyArray<PerToolTtlDrift>,
  opts: DefaultCacheOpts,
): void => {
  if (drifts.length === 0) return
  const metrics = opts.metrics
  if (metrics !== undefined) {
    for (const d of drifts) {
      safeDriftSink(() =>
        metrics.increment("tool.dedup.config_drift.total", 1, { tool: d.tool, kind: d.kind }),
      )
    }
  }
  const warn = opts.onDriftWarn
  if (warn !== undefined) {
    safeDriftSink(() => warn(formatDriftMessage(drifts)))
  }
}

/**
 * Recommended per-tool TTL starting preset (ADR-0179).
 *
 * Conservative defaults — callers can override. Tools NOT listed fall through
 * to the global `ttlMs` (default 30s in `defaultToolCallCache`).
 *
 * Rationale per entry:
 *   - `read` 60s     — file content rarely changes within one human-loop turn
 *                      if no `write` was issued (Cursor's recent_edits 0s
 *                      overlay handles the FAST path; we let cold reads live).
 *   - `grep`/`glob` 30s — search results can shift with any write; matches the
 *                          original global default.
 *   - `git_status`/`git_diff` 5s — working tree mutates frequently.
 *   - `git_log` 60s — history is append-only modulo rebase.
 *   - `web_fetch`/`web_search` 0 — content lives outside our control; never
 *                                   cache by default (operator opts in).
 *   - `bash` 0 — we don't know what the command did (clock/network/state);
 *                caching is unsound by default.
 */
export const RECOMMENDED_PER_TOOL_TTL_MS: Readonly<Record<string, number>> = Object.freeze({
  read: 60_000,
  grep: 30_000,
  glob: 30_000,
  git_status: 5_000,
  git_diff: 5_000,
  git_log: 60_000,
  web_fetch: 0,
  web_search: 0,
  bash: 0,
})

interface Entry {
  readonly result: ToolResult
  /** Absolute expiry timestamp resolved at SET time, so per-tool TTL is
   *  honored even though `get` no longer sees the tool name. */
  readonly expiresAt: number
}

/**
 * In-memory LRU + TTL cache. Re-insertion order on `get` (Map iteration order)
 * gives us LRU for free. TTL is per-entry; expired entries are dropped lazily
 * on lookup.
 *
 * Per-tool TTL (ADR-0179) is resolved at SET time so the cheap `get` path stays
 * tool-agnostic. A `0` TTL means "never cache" — the entry is simply not stored
 * (any prior entry for that key is also dropped to keep semantics monotone).
 *
 * No I/O, no clock side-channels (the clock is injected via `opts.now`).
 */
export const defaultToolCallCache = (opts: DefaultCacheOpts = {}): ToolCallCache => {
  const maxEntries = opts.maxEntries ?? 200
  const ttlMs = opts.ttlMs ?? 30_000
  const perToolTtlMs = opts.perToolTtlMs
  const now = opts.now ?? (() => Date.now())
  const store = new Map<string, Entry>()

  // ADR-0183: construction-time drift detection vs the RECOMMENDED preset.
  // Default-OFF — `checkRecommendedDrift` absent means zero comparison cost
  // and behavior byte-identical to ADR-0179.
  if (opts.checkRecommendedDrift === true) {
    const drifts = computePerToolTtlDrifts(perToolTtlMs, RECOMMENDED_PER_TOOL_TTL_MS)
    reportPerToolTtlDrifts(drifts, opts)
  }

  const resolveTtl = (toolName: string | undefined): number => {
    if (toolName === undefined || perToolTtlMs === undefined) return ttlMs
    const override = perToolTtlMs[toolName]
    return override === undefined ? ttlMs : override
  }

  return {
    computeKey(toolName, input, ctx) {
      const h = createHash("sha256")
      h.update(toolName)
      h.update("|")
      h.update(stableStringify(input))
      h.update("|")
      h.update(ctx.cwd)
      return h.digest("hex")
    },
    get(key) {
      const e = store.get(key)
      if (!e) return null
      // Boundary preserved from ADR-0176: strictly past expiry expires; entry
      // at exactly `now() === expiresAt` is still considered alive (the
      // original `now() - storedAt > ttlMs` semantics with TTL added at SET).
      if (now() > e.expiresAt) {
        store.delete(key)
        return null
      }
      // LRU touch: re-insert to move to the tail of insertion order.
      store.delete(key)
      store.set(key, e)
      return e.result
    },
    set(key, result, toolName) {
      const ttl = resolveTtl(toolName)
      // ADR-0179: TTL === 0 means "never cache" — store nothing.
      if (ttl === 0) {
        // Also drop any stale prior entry so the next get is unambiguously miss.
        if (store.has(key)) store.delete(key)
        return
      }
      // If the key exists, delete first so re-insertion lands at the tail.
      if (store.has(key)) store.delete(key)
      store.set(key, { result, expiresAt: now() + ttl })
      // Evict from the HEAD of insertion order (oldest) while over cap.
      while (store.size > maxEntries) {
        const firstKey = store.keys().next().value
        if (firstKey === undefined) break
        store.delete(firstKey)
      }
    },
    clear() {
      store.clear()
    },
  }
}
