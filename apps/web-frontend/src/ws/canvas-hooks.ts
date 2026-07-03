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
import type {
  ArtifactReadyMessage,
  CanvasMessage,
  ContextUsageMessage,
  ToolDiffMessage,
} from "../types/protocol"

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

export const isArtifactReadyMessage = (msg: CanvasMessage): msg is ArtifactReadyMessage =>
  msg.kind === "artifact.ready"

/** A2 — turn a `quanta-artifact://<id>` locator into the daemon HTTP preview URL
 *  the surface fetches for the bytes. The opaque scheme is stripped to the id and
 *  routed to `GET /artifact/<id>` (the host serves JAILED bytes read-only). A
 *  malformed locator yields `null` so the caller renders a plain "unavailable"
 *  marker rather than a broken fetch. `base` defaults to a relative path (same
 *  origin as the WS/HTTP daemon) so the SPA served by the daemon just works. */
export const artifactPreviewUrl = (locator: string, base = ""): string | null => {
  const scheme = "quanta-artifact://"
  if (!locator.startsWith(scheme)) return null
  const id = locator.slice(scheme.length)
  if (id.length === 0 || id.includes("/")) return null
  return `${base}/artifact/${encodeURIComponent(id)}`
}

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

/* ------------------------------------------------------------------ */
/* Artifacts — Map<artifactId, ArtifactReadyMessage> (latest wins)     */
/* ------------------------------------------------------------------ */

type ArtifactAction = { type: "message"; msg: ArtifactReadyMessage } | { type: "reset" }

const EMPTY_ARTIFACTS: ReadonlyMap<string, ArtifactReadyMessage> = new Map()

/** Reducer exported for unit test (no DOM render needed). Latest-wins per id so a
 *  re-registered artifact updates in place. */
export const artifactsReducer = (
  state: ReadonlyMap<string, ArtifactReadyMessage>,
  action: ArtifactAction,
): ReadonlyMap<string, ArtifactReadyMessage> => {
  if (action.type === "reset") return EMPTY_ARTIFACTS
  const next = new Map(state)
  next.set(action.msg.artifactId, action.msg)
  return next
}

/**
 * A2 — the marker-level artifact state a surface CAN render. Each ready artifact
 * carries its kind + mime + opaque locator; a component turns the locator into a
 * `GET /artifact/<id>` preview URL (`artifactPreviewUrl`) and renders an
 * appropriate card (an `<img>` for `image/*`, a download link otherwise).
 *
 * FOLLOW-UP (honest, deferred): the RICH per-kind renderer components
 * (spreadsheet grid / document / presentation viewers as heavy `.tsx`) are NOT
 * shipped here — those bundle third-party viewers and are the genuinely heavy
 * part. This hook + `artifactPreviewUrl` make the channel RENDERABLE (a surface
 * can already show an image preview + a typed download affordance); the heavy
 * viewers layer on top later.
 */
export const useArtifacts = (
  source: CanvasSource | null,
): ReadonlyMap<string, ArtifactReadyMessage> => {
  const [state, dispatch] = useReducer(artifactsReducer, EMPTY_ARTIFACTS)
  useEffect(() => {
    if (source === null) return
    return source.subscribe((msg) => {
      if (isArtifactReadyMessage(msg)) dispatch({ type: "message", msg })
    })
  }, [source])
  return state
}
