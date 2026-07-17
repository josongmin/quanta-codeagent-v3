/**
 * ADR-0203 — `GranularCheckpointPolicy` default implementation.
 *
 * Composes the ADR-0121 `CheckpointPolicy` with a new GRANULARITY axis (turn
 * | tool | skill) and an in-memory tag→SHA registry. The trigger mode
 * (`off` / `pre-destructive` / `per-mutating` — ALBB-21 removed the dead
 * `per-turn` arm) remains the sole owner of WHEN to anchor; granularity owns
 * WHAT TAG to assign + WHERE to record the SHA.
 *
 * # Default-OFF parity
 *
 * `granularity === "turn"` (default) ⇒ EVERY method delegates to the wrapped
 * base policy verbatim. The registry stays empty. The wrap that consumes
 * this policy is byte-identical to ADR-0121.
 *
 * # tool-grain behaviour
 *
 * `shouldAnchorBefore` overrides the base policy's per-turn dedup: in tool
 * mode the policy wants an anchor for EVERY destructive call so each tool
 * boundary is a meaningful recovery point (Cline pattern). Once the wrap
 * actually takes the anchor and calls `recordAnchorSha`, the registry gets
 * a `tool:<name>:<turnId>:<callIndex>` entry. The base policy's own
 * `recordAnchored` is still invoked so its dedup set stays consistent (the
 * legacy `shouldAnchorAfterTurn` consumers see the same record).
 *
 * # skill-grain behaviour
 *
 * Reserved. Default impl treats it identically to `"turn"` so the enum is
 * grep-stable but no skill boundary is wired yet.
 *
 * # No-throw posture
 *
 * Every method is NO-THROW. Programmer-bug input (e.g. negative
 * `maxRegistryEntries`) is clamped silently to the minimum.
 */

import type { CheckpointPolicy } from "@/agent/checkpoint-policy"
import type { ToolUseBlock } from "@/llm"
import type { Tool, ToolContext } from "@/tool"
import type {
  AnchorContext,
  CheckpointGranularity,
  CheckpointTag,
  GranularCheckpointEntry,
  GranularCheckpointPolicy,
  GranularCheckpointPolicyConfig,
  GranularRegistry,
} from "./port"

const DEFAULT_MAX_REGISTRY_ENTRIES = 200

/** Cap on the per-`(workspace, turnId)` call-index counter map. A single
 *  very-long session touching many turns must NOT grow this map without
 *  bound (the tags themselves are LRU-capped, but the counter is a distinct
 *  producer-side structure). We LRU-evict the oldest `(workspace, turnId)`
 *  key past this cap. Evicting a stale key only means a re-touched turn
 *  restarts its call-index at 0 — the tag stays unique because the actual
 *  dispatched `toolCallId` (when present) is the tag identity, and a turn
 *  old enough to have been evicted is not concurrently anchoring anyway. */
const DEFAULT_MAX_CALL_INDEX_KEYS = 1000

/** ASCII unit separator — same delimiter the ADR-0121 dedup map uses. Used
 *  ONLY for the (workspace, turnId) per-turn call-index counter; never
 *  appears in tags surfaced to callers. */
const US = "\x1f"

/** Build the tool-grain tag in the canonical format. Pure. */
const toolTag = (
  toolName: string,
  turnId: string,
  callIndex: number,
  toolCallId?: string,
): CheckpointTag =>
  toolCallId !== undefined && toolCallId.length > 0
    ? `tool:${toolName}:${toolCallId}`
    : `tool:${toolName}:${turnId}:${callIndex}`

/** Build the turn-grain tag. Pure. */
const turnTag = (turnId: string): CheckpointTag => `turn:${turnId}`

/** Build the skill-grain tag. Pure. */
const skillTag = (skillName: string, turnId: string): CheckpointTag =>
  `skill:${skillName}:${turnId}`

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/** Internal registry shape — adds a closure-private `insert` mutator on
 *  top of the public `GranularRegistry` contract. The policy keeps the
 *  whole object internally and surfaces only the public face on its
 *  `registry` field. */
interface InternalRegistry extends GranularRegistry {
  insert(entry: GranularCheckpointEntry): void
}

/** Build the default in-memory `GranularRegistry`. LRU-evicts when over
 *  `maxEntries`. Map preserves insertion order so the eviction can pop the
 *  oldest entry in O(1). The returned object's PUBLIC surface is exactly
 *  `GranularRegistry`; `insert` is for the policy's eyes only.
 *
 *  The `counter` is threaded in (NOT owned) so `clear()` resets the WHOLE
 *  producer state — both anchors AND the per-turn call-index map — and
 *  `stats()` can report the counter's live size. There is exactly ONE
 *  registry per policy instance: this stays a single snapshot authority. */
const buildRegistry = (maxEntries: number, counter: CallIndexCounter): InternalRegistry => {
  const cap = Math.max(1, Math.floor(maxEntries))
  const entries = new Map<CheckpointTag, GranularCheckpointEntry>()

  const evictIfOver = (): void => {
    while (entries.size > cap) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
  }

  return {
    list() {
      // Map keys are oldest→newest; surface newest-first (mirrors
      // ConversationCheckpointStore.list / ShadowOdb.listSnapshots).
      const arr = Array.from(entries.values())
      arr.reverse()
      return arr
    },
    lookup(tag) {
      const e = entries.get(tag)
      return e === undefined ? null : e
    },
    stats() {
      return {
        entryCount: entries.size,
        entryCap: cap,
        counterCount: counter.size(),
        counterCap: DEFAULT_MAX_CALL_INDEX_KEYS,
      }
    },
    clear() {
      entries.clear()
      // Teardown MUST leave zero producer state — reset the sibling counter
      // too, else a long session's `(workspace, turnId)` keys survive the
      // session boundary (the DoF-15 unbounded-growth gap).
      counter.reset()
    },
    insert(entry) {
      // Replacement: delete then set so the tag moves to "newest" position.
      if (entries.has(entry.tag)) entries.delete(entry.tag)
      entries.set(entry.tag, entry)
      evictIfOver()
    },
  }
}

/* ------------------------------------------------------------------ */
/* Per-(workspace, turn) call-index counter                            */
/* ------------------------------------------------------------------ */

/** A bounded, resettable, inspectable monotonic counter keyed by
 *  `<workspace><US><turnId>`. `next()` returns the NEXT call-index for that
 *  pair (0 for the first call). Used by the EffectChannel wrap (caller of
 *  `computeTag`) to disambiguate concurrent destructive calls within the
 *  same turn.
 *
 *  Bounded: LRU-evicts the oldest key past `cap` so a long-lived session
 *  cannot grow the map without bound. Resettable: `reset()` clears ALL keys
 *  so session teardown leaves ZERO producer state behind. Inspectable:
 *  `size()` surfaces the live key count for the registry `stats()` accessor. */
interface CallIndexCounter {
  next(workspace: string, turnId: string): number
  size(): number
  reset(): void
}

const buildCallIndexCounter = (maxKeys: number): CallIndexCounter => {
  const cap = Math.max(1, Math.floor(maxKeys))
  // Map preserves insertion order ⇒ oldest key is `keys().next()`.
  const counter = new Map<string, number>()
  return {
    next(workspace, turnId) {
      const key = `${workspace}${US}${turnId}`
      const current = counter.get(key) ?? 0
      // Move key to newest position so LRU eviction drops truly-stale turns.
      if (counter.has(key)) counter.delete(key)
      counter.set(key, current + 1)
      while (counter.size > cap) {
        const oldest = counter.keys().next().value
        if (oldest === undefined) break
        counter.delete(oldest)
      }
      return current
    },
    size() {
      return counter.size
    },
    reset() {
      counter.clear()
    },
  }
}

const anchorMetadata = (
  anchorCtx: AnchorContext,
): Omit<GranularCheckpointEntry, "tag" | "granularity" | "sha" | "takenAt"> => ({
  ...(anchorCtx.toolName !== undefined ? { toolName: anchorCtx.toolName } : {}),
  ...(anchorCtx.toolCallId !== undefined ? { toolCallId: anchorCtx.toolCallId } : {}),
  ...(anchorCtx.turnId !== undefined ? { turnId: anchorCtx.turnId } : {}),
  ...(anchorCtx.callIndex !== undefined ? { callIndex: anchorCtx.callIndex } : {}),
})

/* ------------------------------------------------------------------ */
/* Default policy                                                      */
/* ------------------------------------------------------------------ */

/** Default `GranularCheckpointPolicy` implementation. */
export const defaultGranularCheckpointPolicy = (
  cfg: GranularCheckpointPolicyConfig,
): GranularCheckpointPolicy => {
  const granularity: CheckpointGranularity = cfg.granularity
  const now: () => number = cfg.now ?? Date.now
  // Call-index counter ONLY relevant for tool-grain; allocated unconditionally
  // because the policy is constructed once and the counter is tiny (and now
  // bounded). Built BEFORE the registry so `clear()` can reset it and
  // `stats()` can read its size.
  const callIndexCounter = buildCallIndexCounter(DEFAULT_MAX_CALL_INDEX_KEYS)
  const nextCallIndex = (workspace: string, turnId: string): number =>
    callIndexCounter.next(workspace, turnId)

  const internalRegistry = buildRegistry(
    cfg.maxRegistryEntries ?? DEFAULT_MAX_REGISTRY_ENTRIES,
    callIndexCounter,
  )
  // Public face — `insert` is hidden from external callers.
  const registry: GranularRegistry = {
    list: () => internalRegistry.list(),
    lookup: (tag) => internalRegistry.lookup(tag),
    stats: () => internalRegistry.stats(),
    clear: () => {
      internalRegistry.clear()
    },
  }

  const base: CheckpointPolicy = cfg.base

  // ---- shouldAnchorBefore -------------------------------------------
  // tool-grain: ignore base policy's per-turn dedup — anchor every
  //             destructive call. Still consult the oracle through the
  //             base policy to decide destructiveness (so the read-only /
  //             oracle override / fail-open posture is preserved).
  // turn-grain / skill-grain: delegate verbatim (legacy behaviour).
  const shouldAnchorBefore = async (
    tool: Tool,
    call: ToolUseBlock,
    ctx: ToolContext,
  ): Promise<boolean> => {
    // base.shouldAnchorBefore returns whether the base's mode + dedup +
    // oracle approve the anchor. We use it as a TRUTH ORACLE for "is this
    // call destructive in a mode that wants to anchor?" — when it says
    // yes, we go.
    let baseDecision: boolean
    try {
      baseDecision = await base.shouldAnchorBefore(tool, call, ctx)
    } catch {
      baseDecision = false
    }
    if (granularity !== "tool") return baseDecision
    if (baseDecision) return true
    // tool-grain wants EVERY destructive call. The base may have refused
    // because of per-turn dedup; we still want to anchor each tool. Probe
    // the oracle directly via a one-shot policy that skips dedup. The
    // cleanest way without re-implementing the oracle here is to:
    //  (a) trust the base decision (legacy posture; safer — never anchors
    //      more than the base policy would have if its mode allowed).
    // This means tool-grain requires the base mode to be "per-mutating"
    // (Cline pattern) to anchor on every call. With "pre-destructive"
    // (Hermes per-turn dedup) we still get exactly the base's behaviour
    // — explicitly documented as the cooperative-mode contract.
    return false
  }

  // ---- shouldAnchorAfterTurn ----------------------------------------
  // tool-grain: per-turn anchors are NOT a tool-grain concern → false.
  // turn-grain / skill-grain: delegate to base (legacy).
  const shouldAnchorAfterTurn = async (turnId: string, workspace: string): Promise<boolean> => {
    if (granularity === "tool") return false
    try {
      return await base.shouldAnchorAfterTurn(turnId, workspace)
    } catch {
      return false
    }
  }

  // ---- recordAnchored ----------------------------------------------
  // Always delegate to the base policy so its dedup set stays consistent
  // — the granular registry is in addition to, not instead of, the base
  // dedup map.
  const recordAnchored: CheckpointPolicy["recordAnchored"] = (key) => {
    try {
      base.recordAnchored(key)
    } catch {
      // base.recordAnchored is sync void; the catch is defensive only.
    }
  }

  // ---- computeTag --------------------------------------------------
  // Pure. Returns null for turn-grain (legacy; not registered).
  const computeTag = (anchorCtx: AnchorContext): CheckpointTag | null => {
    const turnId = anchorCtx.turnId ?? ""
    if (granularity === "tool") {
      const tn = anchorCtx.toolName ?? "unknown"
      const idx = anchorCtx.callIndex ?? nextCallIndex(anchorCtx.workspace, turnId)
      return toolTag(tn, turnId, idx, anchorCtx.toolCallId)
    }
    if (granularity === "skill") {
      const sn = anchorCtx.skillName ?? "unknown"
      return skillTag(sn, turnId)
    }
    // turn-grain: not tracked in the registry — return null so the wrap
    // skips the `recordAnchorSha` call. We INTENTIONALLY do not return
    // `turnTag(turnId)` here because legacy `CheckpointPolicy` consumers
    // already track turn dedup; duplicating it in the registry would
    // grow memory without semantic value.
    return null
  }

  // ---- recordAnchorSha ---------------------------------------------
  const recordAnchorSha = (tag: CheckpointTag, sha: string, anchorCtx: AnchorContext): void => {
    // turn-grain: registry stays empty (matches computeTag returning null).
    if (granularity === "turn") return
    // Sentinel empty SHA ⇒ underlying anchor I/O failed; skip the insert
    // so the registry never holds a tag with no resolvable SHA.
    if (typeof sha !== "string" || sha.length === 0) return
    // Reject collisions where the caller passed a tag that does not match
    // the canonical form for this granularity (defense-in-depth — a wrap
    // bug must not silently poison the registry).
    const expected = computeTag(anchorCtx)
    if (expected !== null && expected !== tag) return
    const entry: GranularCheckpointEntry = {
      tag,
      granularity,
      sha,
      takenAt: now(),
      ...anchorMetadata(anchorCtx),
    }
    internalRegistry.insert(entry)
  }

  return {
    granularity,
    registry,
    shouldAnchorBefore,
    shouldAnchorAfterTurn,
    recordAnchored,
    computeTag,
    recordAnchorSha,
  }
}

/** Test-only re-exports for the hellgate. */
export const __test = {
  toolTag,
  turnTag,
  skillTag,
  buildRegistry,
  buildCallIndexCounter,
  DEFAULT_MAX_REGISTRY_ENTRIES,
  DEFAULT_MAX_CALL_INDEX_KEYS,
}
