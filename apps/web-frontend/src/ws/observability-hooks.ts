/**
 * ADR-0408 — React hook over the observability WS channel.
 *
 * Consumes `observability.snapshot` / `observability.delta` frames received
 * from the daemon and exposes a single typed state: `{ runs, objective,
 * approvals }`. The reducer mirrors the wire semantics:
 *
 *   snapshot ⇒ replace everything verbatim
 *   delta    ⇒ apply each axis independently:
 *     - runChanges[].entry === null      ⇒ remove that id
 *     - runChanges[].entry !== null      ⇒ add or overwrite
 *     - approvalChanges[] same semantics
 *     - objectiveChanged === null        ⇒ clear objective
 *     - objectiveChanged !== null+!==undefined ⇒ replace
 *
 * The hook accepts an event source (the existing SessionClient is wrapped
 * with a small adapter on the call site). When no events arrive the hook
 * returns empty defaults — the pane renders empty placeholders.
 */

import { useEffect, useReducer } from "react"
import type { ApprovalRequest, Objective, ObservabilityMessage, RunEntry } from "../types/protocol"

/** Public observability state — what the pane renders. */
export interface ObservabilityState {
  readonly runs: readonly RunEntry[]
  readonly objective: Objective | null
  readonly approvals: readonly ApprovalRequest[]
  /** Epoch-ms stamp of the most recent observability frame. 0 ⇒ none yet. */
  readonly lastEmittedAt: number
}

const EMPTY_STATE: ObservabilityState = {
  runs: [],
  objective: null,
  approvals: [],
  lastEmittedAt: 0,
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

type Action = { type: "message"; msg: ObservabilityMessage } | { type: "reset" }

const applyRuns = (
  runs: readonly RunEntry[],
  changes: readonly { id: string; entry: RunEntry | null }[] | undefined,
): readonly RunEntry[] => {
  if (changes === undefined || changes.length === 0) return runs
  const byId = new Map<string, RunEntry>()
  for (const r of runs) byId.set(r.id, r)
  for (const change of changes) {
    if (change.entry === null) {
      byId.delete(change.id)
    } else {
      byId.set(change.id, change.entry)
    }
  }
  return [...byId.values()]
}

const applyApprovals = (
  approvals: readonly ApprovalRequest[],
  changes: readonly { id: string; approval: ApprovalRequest | null }[] | undefined,
): readonly ApprovalRequest[] => {
  if (changes === undefined || changes.length === 0) return approvals
  const byId = new Map<string, ApprovalRequest>()
  for (const a of approvals) byId.set(a.id, a)
  for (const change of changes) {
    if (change.approval === null) {
      byId.delete(change.id)
    } else {
      byId.set(change.id, change.approval)
    }
  }
  return [...byId.values()]
}

export const observabilityReducer = (
  state: ObservabilityState,
  action: Action,
): ObservabilityState => {
  if (action.type === "reset") return EMPTY_STATE
  const msg = action.msg
  if (msg.kind === "observability.snapshot") {
    return {
      runs: msg.runs,
      objective: msg.objective,
      approvals: msg.approvals,
      lastEmittedAt: msg.emittedAt,
    }
  }
  // delta
  return {
    runs: applyRuns(state.runs, msg.runChanges),
    approvals: applyApprovals(state.approvals, msg.approvalChanges),
    objective: "objectiveChanged" in msg ? (msg.objectiveChanged ?? null) : state.objective,
    lastEmittedAt: msg.emittedAt,
  }
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

/** Minimal event source the hook subscribes to. Production callers wrap the
 *  existing `SessionClient` to feed observability messages here; tests pass a
 *  stub. */
export interface ObservabilitySource {
  subscribe(handler: (msg: ObservabilityMessage) => void): () => void
}

export const useObservabilityState = (source: ObservabilitySource | null): ObservabilityState => {
  const [state, dispatch] = useReducer(observabilityReducer, EMPTY_STATE)
  useEffect(() => {
    if (source === null) return
    const off = source.subscribe((msg) => dispatch({ type: "message", msg }))
    return off
  }, [source])
  return state
}

/** Helper used by the pane / smoke tests — split runs by status into the
 *  three columns the UI renders. */
export const splitRunsByStatus = (
  runs: readonly RunEntry[],
): {
  running: readonly RunEntry[]
  waiting: readonly RunEntry[]
  completed: readonly RunEntry[]
} => {
  const running: RunEntry[] = []
  const waiting: RunEntry[] = []
  const completed: RunEntry[] = []
  for (const r of runs) {
    if (r.status === "running") running.push(r)
    else if (r.status === "waiting") waiting.push(r)
    else completed.push(r)
  }
  return { running, waiting, completed }
}
