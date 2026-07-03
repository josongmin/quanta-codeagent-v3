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

/**
 * P3 (memory backstop): FIFO cap on the number of DISTINCT `toolCallId`s the
 * latest-wins diff Map retains. This is a BACKSTOP, not a tuned value —
 * mirrors the `EVENT_DEDUP_CAP` precedent (`session-hooks.ts`): a cap so high
 * it NEVER evicts anything in a normal session, only bounding memory for a
 * pathological one. A long agent session accumulates a diff per distinct tool
 * call, and each diff retains its full `lines[]`; without a cap that grows
 * unbounded for the whole session. 256 distinct concurrent tool diffs is far
 * beyond any realistic pane (the observability pane shows one panel each);
 * eviction is oldest-first, so the recent window a surface actually renders is
 * always retained. Measure-first: revisit if real sessions ever approach it.
 */
export const TOOL_DIFFS_CAP = 256

/**
 * Latest-wins insert into an insertion-ordered Map with a FIFO memory cap.
 * `map.set` on an EXISTING key updates in place (latest-wins) WITHOUT changing
 * its insertion position, so re-touching a recent key never evicts it. A NEW
 * key is appended; if that pushes size over `cap`, the oldest inserted key
 * (Map's first entry) is evicted. Mutates `next` (a caller-owned fresh copy).
 */
const setWithFifoCap = <V>(next: Map<string, V>, key: string, value: V, cap: number): void => {
  next.set(key, value)
  if (next.size > cap) {
    const oldest = next.keys().next().value
    if (oldest !== undefined) next.delete(oldest)
  }
}

/** Reducer is exported so the codec / state semantics can be unit-tested in
 *  the node test environment (no DOM render needed). */
export const toolDiffsReducer = (
  state: ReadonlyMap<string, ToolDiffMessage>,
  action: DiffAction,
): ReadonlyMap<string, ToolDiffMessage> => {
  if (action.type === "reset") return EMPTY_DIFFS
  // Latest-wins per toolCallId; FIFO-capped as a memory backstop (P3).
  const next = new Map(state)
  setWithFifoCap(next, action.msg.toolCallId, action.msg, TOOL_DIFFS_CAP)
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

/** FIFO backstop, parity with TOOL_DIFFS_CAP/TOOL_PROGRESS_CAP — a cap so high it
 *  never evicts in a normal session, only bounds a pathological one. */
export const ARTIFACTS_CAP = 256

/** Reducer exported for unit test (no DOM render needed). Latest-wins per id so a
 *  re-registered artifact updates in place; FIFO-capped so the Map can't grow
 *  unbounded across a long session. */
export const artifactsReducer = (
  state: ReadonlyMap<string, ArtifactReadyMessage>,
  action: ArtifactAction,
): ReadonlyMap<string, ArtifactReadyMessage> => {
  if (action.type === "reset") return EMPTY_ARTIFACTS
  const next = new Map(state)
  setWithFifoCap(next, action.msg.artifactId, action.msg, ARTIFACTS_CAP)
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
