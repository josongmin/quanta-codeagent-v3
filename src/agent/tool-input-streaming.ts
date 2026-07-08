import type { ToolRegistry } from "@/tool"
import type { ToolInputStreamSeam } from "./streaming-dispatch"

/**
 * L3 wire helper (absorb #1, ADR-0060) — builds the registry-bound
 * `ToolInputStreamSeam` that routes `tool_use_*` streaming events to the
 * per-tool `onInputStart`/`onInputDelta`/`onInputAvailable` callbacks declared
 * on the {@link Tool} interface.
 *
 * Default-OFF posture: a tool that declares none of the three callbacks
 * incurs a single `Map.get` + property check per event. The loop opts in by
 * passing `onToolInput: buildToolInputSeam(registry)` to `runStreamingTurn`;
 * callers that never opt in are byte-identical to the pre-wire path.
 *
 * Implementation notes:
 *  - Resolves the tool PER EVENT against the live registry — guarantees the
 *    current registration is used even if a hot-reload swaps the registry
 *    mid-turn.
 *  - Tracks the (id → name) mapping locally so `delta`/`available` can find
 *    the right tool without re-parsing the event stream. Cleared on
 *    `available` to bound memory by outstanding-in-turn calls.
 *  - LEAK GUARD: the seam contract has no reset hook, and a `start` whose call
 *    is later tombstoned mid-args (FallbackLLM `stream_reset` discards the dead
 *    partial WITHOUT replaying `tool_use_end`) never reaches `available` — so
 *    its entry would otherwise leak one slot per abandoned call, unbounded over
 *    a long-running turn/session. We bound the map with a small LRU cap: when a
 *    `start` would exceed the cap, the OLDEST entry is evicted (insertion order
 *    via `Map`). The cap is far above any realistic count of concurrently
 *    outstanding tool calls in one turn, so a legitimate `delta`/`available`
 *    pairing is never evicted out from under a live call; only stale
 *    tombstoned entries are reclaimed.
 *  - The seam contract guarantees the caller wraps invocation in try/catch
 *    (see `streaming-dispatch#fireToolInput`). ALBB-20 #8: the per-callback
 *    errors are NO LONGER swallowed HERE — that DOUBLE-swallow (inner + outer)
 *    made a faulty callback invisible at both layers. We now let a callback
 *    throw propagate to the OUTER `fireToolInput` seam, which swallows it (so
 *    the stream-processing invariants are still never poisoned) AND emits a
 *    single `logger.warn` so the fault is observable exactly once. The
 *    id→name bookkeeping is still updated BEFORE the throwing callback runs, so
 *    the leak-guard/dedup state stays consistent regardless of a throw.
 */
/** Bound on outstanding (id → name) entries. A turn never has more than a
 *  handful of tool calls in flight at once; this cap is far above that, so it
 *  only ever reclaims entries leaked by tombstoned `start`-without-`_end`
 *  calls — never a live pairing. */
const MAX_OUTSTANDING_IDS = 256

export const buildToolInputSeam = (registry: ToolRegistry): ToolInputStreamSeam => {
  const idToName = new Map<string, string>()

  return {
    start(id, name) {
      // LRU leak guard: evict the oldest entry (insertion order) when the map
      // is at capacity and this is a NEW id. Re-`start` of an existing id just
      // refreshes its name (handled by the set below). See module docstring.
      if (!idToName.has(id) && idToName.size >= MAX_OUTSTANDING_IDS) {
        const oldest = idToName.keys().next().value
        if (oldest !== undefined) idToName.delete(oldest)
      }
      idToName.set(id, name)
      const tool = registry.get(name)
      if (tool?.onInputStart === undefined) return
      // ALBB-20 #8 — do NOT swallow here; let the OUTER `fireToolInput` seam
      // surface it once (logger.warn) then swallow. Bookkeeping above already ran.
      tool.onInputStart()
    },
    delta(id, delta) {
      const name = idToName.get(id)
      if (name === undefined) return
      const tool = registry.get(name)
      if (tool?.onInputDelta === undefined) return
      tool.onInputDelta(delta) // ALBB-20 #8: propagate to outer seam (see start()).
    },
    available(id, input) {
      const name = idToName.get(id)
      idToName.delete(id)
      if (name === undefined) return
      const tool = registry.get(name)
      if (tool?.onInputAvailable === undefined) return
      tool.onInputAvailable(input) // ALBB-20 #8: propagate to outer seam (see start()).
    },
  }
}
