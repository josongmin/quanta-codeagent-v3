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
 *  - The seam contract guarantees the caller wraps invocation in try/catch
 *    (see `streaming-dispatch#fireToolInput`); we still defensively swallow
 *    callback errors here so a faulty third-party tool cannot surface as a
 *    thrown error at all.
 */
export const buildToolInputSeam = (registry: ToolRegistry): ToolInputStreamSeam => {
  const idToName = new Map<string, string>()

  return {
    start(id, name) {
      idToName.set(id, name)
      const tool = registry.get(name)
      if (tool?.onInputStart === undefined) return
      try {
        tool.onInputStart()
      } catch {
        // Defensive: callback errors must not break the stream.
      }
    },
    delta(id, delta) {
      const name = idToName.get(id)
      if (name === undefined) return
      const tool = registry.get(name)
      if (tool?.onInputDelta === undefined) return
      try {
        tool.onInputDelta(delta)
      } catch {
        // Defensive: see start().
      }
    },
    available(id, input) {
      const name = idToName.get(id)
      idToName.delete(id)
      if (name === undefined) return
      const tool = registry.get(name)
      if (tool?.onInputAvailable === undefined) return
      try {
        tool.onInputAvailable(input)
      } catch {
        // Defensive: see start().
      }
    },
  }
}
