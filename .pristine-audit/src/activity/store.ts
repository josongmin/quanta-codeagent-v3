/**
 * Activity store + live producer sinks (jun-15 P0-b).
 *
 * The runtime side of the spine: a stateful accumulator the host feeds with
 * live {@link AgentActivityEvent}s, exposing an immutable `snapshot()` the
 * surfaces render. `createWorkflowSink` adapts the executor's streaming
 * `WorkflowSink` (one `WorkflowEvent` at a time) into spine events — the SAME
 * id scheme + mapping as the batch `workflowToActivity`, so the streaming and
 * batch paths produce identical snapshots (pinned by the store drift ratchet).
 *
 * NO-THROW: feeding a malformed event degrades inside the pure reducer.
 */

import { type WorkflowEventLike, wfPhaseId, wfRunId, wfStepId } from "./producers/workflow"
import { type ActivityState, emptyActivityState, materialize, reduceActivity } from "./spine"
import type { ActivityNode, ActivitySnapshot, AgentActivityEvent } from "./types"

/** A live, mutable activity accumulator. */
export interface ActivityStore {
  emit(event: AgentActivityEvent): void
  emitAll(events: Iterable<AgentActivityEvent>): void
  snapshot(): ActivitySnapshot
  /** Internal accumulator (escape hatch for tests/diagnostics). */
  readonly state: ActivityState
}

export const createActivityStore = (): ActivityStore => {
  const state = emptyActivityState()
  return {
    state,
    emit: (event) => {
      reduceActivity(state, event)
    },
    emitAll: (events) => {
      for (const e of events) reduceActivity(state, e)
    },
    snapshot: () => materialize(state),
  }
}

/** Replay ONE node into the seed store: open + counters + (leaf-only) status.
 *  Container status is NOT re-emitted — `materialize` re-derives it from the
 *  seeded children, which both reproduces the original and avoids stamping a
 *  spurious `stuck:{unknown}` reason on a container that has none. */
const seedNode = (store: ActivityStore, snapshot: ActivitySnapshot, n: ActivityNode): void => {
  store.emit({
    type: "node_open",
    node: {
      id: n.id,
      parentId: n.parentId,
      kind: n.kind,
      label: n.label,
      status: "running",
      ...(n.startedAt !== undefined ? { at: n.startedAt } : {}),
      ...(n.correlation !== undefined ? { correlation: n.correlation } : {}),
      ...(n.meta !== undefined ? { meta: n.meta } : {}),
    },
  })
  if (n.tokens > 0 || n.toolCalls > 0) {
    store.emit({
      type: "node_metric",
      id: n.id,
      tokensDelta: n.tokens,
      toolCallsDelta: n.toolCalls,
    })
  }
  const isLeaf = (snapshot.childIds.get(n.id)?.length ?? 0) === 0
  if (isLeaf && n.status !== "running") {
    store.emit({
      type: "node_status",
      id: n.id,
      status: n.status,
      ...(n.stuck !== undefined ? { stuck: n.stuck } : {}),
      ...(n.endedAt !== undefined ? { at: n.endedAt } : {}),
    })
  }
}

/** Replay a snapshot's nodes into a FRESH store — a non-mutating "view base".
 *  Used by `/activity` to overlay the live fleet WITHOUT polluting the durable
 *  session store (which only `run_workflow` writes). Nodes are emitted in
 *  root→child preorder so the tree order is preserved; counters + leaf status
 *  are restored and container statuses re-derive identically (round-trip safe). */
export const seedStoreFromSnapshot = (snapshot: ActivitySnapshot): ActivityStore => {
  const store = createActivityStore()
  const visit = (id: string): void => {
    const n = snapshot.byId.get(id)
    if (n === undefined) return
    seedNode(store, snapshot, n)
    for (const child of snapshot.childIds.get(id) ?? []) visit(child)
  }
  for (const root of snapshot.roots) visit(root)
  return store
}

/** Options for {@link createWorkflowSink}. */
export interface WorkflowSinkOpts {
  readonly runId: string
  readonly label: string
  readonly startedAt?: number
}

/** A streaming workflow→spine sink. Shaped like the executor's `WorkflowSink`
 *  (`emit(WorkflowEvent)`), plus `close(ok)` for the run-settle signal. Opens
 *  the run root immediately; tracks the current phase so steps attach + the
 *  prior phase closes on the next `phase_enter`; `close` settles the tracked
 *  last phase + run (no event re-scan needed). */
export interface WorkflowSink {
  emit(event: WorkflowEventLike): void
  close(ok: boolean, endedAt?: number): void
}

export const createWorkflowSink = (store: ActivityStore, opts: WorkflowSinkOpts): WorkflowSink => {
  const runRoot = wfRunId(opts.runId)
  store.emit({
    type: "node_open",
    node: {
      id: runRoot,
      parentId: null,
      kind: "workflow",
      label: opts.label,
      status: "running",
      ...(opts.startedAt !== undefined ? { at: opts.startedAt } : {}),
    },
  })
  let currentPhase: string | null = null
  const started = new Set<string>()
  // A started step is NOT re-opened on completion, so the idempotent re-open's
  // label refresh never clobbers its real label with the id. A start-less
  // completion (cache-hit / pre-skip) still opens once (id as the only label).
  const ensureStep = (id: string, label: string): string => {
    const sid = wfStepId(opts.runId, id)
    if (!started.has(id)) {
      started.add(id)
      store.emit({
        type: "node_open",
        node: {
          id: sid,
          parentId: currentPhase ?? runRoot,
          kind: "agent",
          label,
          status: "running",
        },
      })
    }
    return sid
  }
  return {
    emit: (e) => {
      switch (e.type) {
        case "phase_enter": {
          if (currentPhase !== null)
            store.emit({ type: "node_status", id: currentPhase, status: "done" })
          const pid = wfPhaseId(opts.runId, e.name)
          store.emit({
            type: "node_open",
            node: { id: pid, parentId: runRoot, kind: "phase", label: e.name, status: "running" },
          })
          currentPhase = pid
          break
        }
        case "step_start":
          ensureStep(e.id, e.label)
          break
        case "step_complete":
          store.emit({
            type: "node_status",
            id: ensureStep(e.id, e.id),
            status: e.ok ? "done" : "failed",
          })
          break
        case "step_skipped":
          store.emit({ type: "node_status", id: ensureStep(e.id, e.id), status: "skipped" })
          break
      }
    },
    close: (ok, endedAt) => {
      if (currentPhase !== null)
        store.emit({ type: "node_status", id: currentPhase, status: "done" })
      store.emit({
        type: "node_status",
        id: runRoot,
        status: ok ? "done" : "failed",
        ...(endedAt !== undefined ? { at: endedAt } : {}),
      })
    },
  }
}
