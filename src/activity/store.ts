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

import { mergeProgress } from "./progress"
import { type WorkflowEventLike, wfPhaseId, wfRunId, wfStepId } from "./producers/workflow"
import { type ActivityState, emptyActivityState, materialize, reduceActivity } from "./spine"
import {
  type ActivityChange,
  type ActivityListener,
  type ActivitySubscription,
  createActivitySubscription,
  type SubscribeOptions,
} from "./subscription"
import type {
  ActivityEvent,
  ActivityNode,
  ActivitySnapshot,
  NodeProgressEvent,
} from "./types"

/** A live, mutable activity accumulator. */
export interface ActivityStore {
  emit(event: ActivityEvent): void
  emitAll(events: Iterable<ActivityEvent>): void
  snapshot(): ActivitySnapshot
  /** RFC-04 R6 D1 — store-level monotonic sequence: the count of events applied
   *  so far (0 before any emit). The SSOT ordering handle a subscription uses to
   *  partition "already in the snapshot" (`seq <= baseSeq`) from "delivered"
   *  (`seq > baseSeq`). Distinct from `OperationCorrelation.sequence` (a
   *  per-operation step counter on a node) — this is the per-STORE event clock. */
  readonly seq: number
  /** RFC-04 R6 D1 — subscribe atomically. Returns `{snapshot, nextSeq}` and
   *  registers `listener`; an event injected between capture and registration is
   *  neither lost nor duplicated (see `subscription.ts`). */
  subscribe(listener: ActivityListener, opts?: SubscribeOptions): ActivitySubscription
  /** Internal accumulator (escape hatch for tests/diagnostics). */
  readonly state: ActivityState
}

export const createActivityStore = (): ActivityStore => {
  const state = emptyActivityState()
  let seq = 0
  const rawListeners = new Set<(change: ActivityChange) => void>()

  /** Apply a typed progress refresh onto the node (store-level, NOT the pure
   *  spine). NO-THROW: an unknown id is dropped (mirrors the spine's rule). The
   *  node object is REPLACED (structural sharing), so an earlier snapshot stays
   *  frozen — exactly as `reduceActivity` does. */
  const applyProgress = (event: NodeProgressEvent): void => {
    const node = state.nodes.get(event.id)
    if (node === undefined) return
    state.nodes.set(event.id, { ...node, progress: mergeProgress(node.progress, event.progress) })
  }

  /** Advance the clock + fan out to raw listeners. Materialization stays lazy —
   *  a subscriber pulls `snapshot()` when it renders — so with no listeners the
   *  emit path is byte-identical to the landed store (state + snapshot unchanged;
   *  only the cheap counter moves). */
  const notify = (event: ActivityEvent): void => {
    seq += 1
    if (rawListeners.size === 0) return
    const change: ActivityChange = { seq, event }
    for (const l of [...rawListeners]) l(change)
  }

  const store: ActivityStore = {
    state,
    get seq() {
      return seq
    },
    emit: (event) => {
      if (event.type === "node_progress") applyProgress(event)
      else reduceActivity(state, event)
      notify(event)
    },
    emitAll: (events) => {
      for (const e of events) store.emit(e)
    },
    snapshot: () => materialize(state),
    subscribe: (listener, opts) =>
      createActivitySubscription(
        {
          // Atomic attach: register the raw listener BEFORE capturing the
          // snapshot + seq, so a mid-capture emit is seen and reconciled.
          attach: (raw) => {
            rawListeners.add(raw)
            const snapshot = materialize(state)
            return { snapshot, seq, detach: () => rawListeners.delete(raw) }
          },
        },
        listener,
        opts,
      ),
  }
  return store
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
