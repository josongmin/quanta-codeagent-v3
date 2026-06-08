/**
 * ADR-0440 — React hooks over the canvas WS channel.
 *
 * Consumes `tool.diff` / `context.usage` frames from the daemon and exposes
 * two typed states:
 *
 *   - `useToolDiffs(source)`    → `Map<toolCallId, ToolDiffMessage>` (latest
 *                                 wins per tool call).
 *   - `useContextUsage(source)` → the latest `ContextUsageMessage | null`.
 *
 * Mirrors `observability-hooks.ts`: the hook accepts an event source (the
 * production caller wraps the existing `SessionClient`; tests pass a stub).
 * With no source / no frames the hooks return empty defaults so the components
 * render nothing — chat UI unchanged (default-OFF).
 */

import { useEffect, useReducer, useState } from "react"
import type { CanvasMessage, ContextUsageMessage, ToolDiffMessage } from "../types/protocol"

/** Minimal event source the hooks subscribe to. Production callers wrap the
 *  existing `SessionClient` to feed canvas messages here; tests pass a stub. */
export interface CanvasSource {
  subscribe(handler: (msg: CanvasMessage) => void): () => void
}

/* ------------------------------------------------------------------ */
/* Per-kind narrowing — the SINGLE filter both hooks route on.         */
/*                                                                     */
/* Exported (and load-bearing: the hooks below call these) so the      */
/* routing predicate is unit-tested directly instead of re-implemented */
/* inline in the test. A canvas channel multiplexes `tool.diff` and    */
/* `context.usage`; each hook consumes exactly one kind.               */
/* ------------------------------------------------------------------ */

export const isToolDiffMessage = (msg: CanvasMessage): msg is ToolDiffMessage =>
  msg.kind === "tool.diff"

export const isContextUsageMessage = (msg: CanvasMessage): msg is ContextUsageMessage =>
  msg.kind === "context.usage"

/* ------------------------------------------------------------------ */
/* Tool diffs — Map<toolCallId, ToolDiffMessage>                       */
/* ------------------------------------------------------------------ */

type DiffAction = { type: "message"; msg: ToolDiffMessage } | { type: "reset" }

const EMPTY_DIFFS: ReadonlyMap<string, ToolDiffMessage> = new Map()

/** Reducer is exported so the codec / state semantics can be unit-tested in
 *  the node test environment (no DOM render needed). */
export const toolDiffsReducer = (
  state: ReadonlyMap<string, ToolDiffMessage>,
  action: DiffAction,
): ReadonlyMap<string, ToolDiffMessage> => {
  if (action.type === "reset") return EMPTY_DIFFS
  // Latest-wins per toolCallId.
  const next = new Map(state)
  next.set(action.msg.toolCallId, action.msg)
  return next
}

export const useToolDiffs = (source: CanvasSource | null): ReadonlyMap<string, ToolDiffMessage> => {
  const [state, dispatch] = useReducer(toolDiffsReducer, EMPTY_DIFFS)
  useEffect(() => {
    if (source === null) return
    return source.subscribe((msg) => {
      if (isToolDiffMessage(msg)) dispatch({ type: "message", msg })
    })
  }, [source])
  return state
}

/* ------------------------------------------------------------------ */
/* Context usage — latest wins                                         */
/* ------------------------------------------------------------------ */

export const useContextUsage = (source: CanvasSource | null): ContextUsageMessage | null => {
  const [usage, setUsage] = useState<ContextUsageMessage | null>(null)
  useEffect(() => {
    if (source === null) return
    return source.subscribe((msg) => {
      if (isContextUsageMessage(msg)) setUsage(msg)
    })
  }, [source])
  return usage
}
