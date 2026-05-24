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
  /** Store result. TTL / eviction is implementation-defined. */
  set(key: string, result: ToolResult): void
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
        cache.set(key, terminal)
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
  /** Clock injection for tests. Default `Date.now`. */
  readonly now?: () => number
}

interface Entry {
  readonly result: ToolResult
  readonly storedAt: number
}

/**
 * In-memory LRU + TTL cache. Re-insertion order on `get` (Map iteration order)
 * gives us LRU for free. TTL is per-entry; expired entries are dropped lazily
 * on lookup.
 *
 * No I/O, no clock side-channels (the clock is injected via `opts.now`).
 */
export const defaultToolCallCache = (opts: DefaultCacheOpts = {}): ToolCallCache => {
  const maxEntries = opts.maxEntries ?? 200
  const ttlMs = opts.ttlMs ?? 30_000
  const now = opts.now ?? (() => Date.now())
  const store = new Map<string, Entry>()

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
      if (now() - e.storedAt > ttlMs) {
        store.delete(key)
        return null
      }
      // LRU touch: re-insert to move to the tail of insertion order.
      store.delete(key)
      store.set(key, e)
      return e.result
    },
    set(key, result) {
      // If the key exists, delete first so re-insertion lands at the tail.
      if (store.has(key)) store.delete(key)
      store.set(key, { result, storedAt: now() })
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
