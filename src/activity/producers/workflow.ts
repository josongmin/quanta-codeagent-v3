/**
 * Producer: workflow events → activity events (jun-15 P0-a, gap G3).
 *
 * Maps the executor's `WorkflowEvent` stream (`@/workflow`) into spine events
 * WITHOUT importing the workflow engine's values (the `WorkflowEventLike` shape
 * is mirrored structurally). The run is an L0 `workflow` root; `phase_enter`
 * opens an L1 `phase` (and CLOSES the prior one — "we moved on"); each `step_*`
 * is an L2 `agent` under the current phase.
 *
 * Honesty: closing a phase emits a TERMINAL `done` (= "this phase is settled").
 * The spine's derived-status pass turns that into `failed` if a child step
 * failed — so a phase with a failed step never reads green. (The producer does
 * NOT decide done-vs-failed; the spine derives it from children.)
 *
 * Pure + deterministic. Ids are namespaced AND url-encoded so a `/` in a phase
 * name or step id can never break the hierarchy or alias a sibling.
 */

import type { AgentActivityEvent } from "../types"

/** Structural mirror of `@/workflow`'s `WorkflowEvent` (no value import). */
export type WorkflowEventLike =
  | { readonly type: "phase_enter"; readonly name: string }
  | { readonly type: "step_start"; readonly id: string; readonly label: string }
  | { readonly type: "step_complete"; readonly id: string; readonly ok: boolean }
  | { readonly type: "step_skipped"; readonly id: string }

export interface WorkflowToActivityOpts {
  /** Stable run id — the L0 root node id. */
  readonly runId: string
  /** Human label for the run row (e.g. the workflow name). */
  readonly label: string
  /** Optional monotonic timestamp for the run-open stamp. */
  readonly startedAt?: number
}

/** Url-encode a dynamic id segment so `/` (or any reserved char) in a phase
 *  name / step id cannot break the `runId/phase/...` namespacing. Exported so
 *  the streaming sink (`store.ts`) mints byte-identical ids — the batch and
 *  streaming paths MUST agree (pinned by the store drift ratchet). */
export const wfSeg = (s: string): string => encodeURIComponent(s)
export const wfRunId = (runId: string): string => wfSeg(runId)
export const wfPhaseId = (runId: string, name: string): string => `${wfSeg(runId)}/phase/${wfSeg(name)}`
export const wfStepId = (runId: string, id: string): string => `${wfSeg(runId)}/step/${wfSeg(id)}`
const seg = wfSeg
const phaseId = wfPhaseId
const stepId = wfStepId

/**
 * Translate a workflow event sequence into spine events. Emits the run root
 * first; tracks the current phase so steps attach to it. Steps before any phase
 * attach to the run root. A `step_complete`/`step_skipped` whose `step_start`
 * was never seen still OPENS the node (so a pre-skipped / cache-hit step is
 * visible, never silently dropped).
 */
export const workflowToActivity = (
  events: readonly WorkflowEventLike[],
  opts: WorkflowToActivityOpts,
): readonly AgentActivityEvent[] => {
  const out: AgentActivityEvent[] = [
    {
      type: "node_open",
      node: {
        id: `${seg(opts.runId)}`,
        parentId: null,
        kind: "workflow",
        label: opts.label,
        status: "running",
        ...(opts.startedAt !== undefined ? { at: opts.startedAt } : {}),
      },
    },
  ]
  const runRoot = seg(opts.runId)
  let currentPhase: string | null = null
  const ensureStep = (id: string, label: string): string => {
    const sid = stepId(opts.runId, id)
    out.push({
      type: "node_open",
      node: { id: sid, parentId: currentPhase ?? runRoot, kind: "agent", label, status: "running" },
    })
    return sid
  }
  for (const e of events) {
    switch (e.type) {
      case "phase_enter": {
        if (currentPhase !== null) {
          out.push({ type: "node_status", id: currentPhase, status: "done" })
        }
        const pid = phaseId(opts.runId, e.name)
        out.push({
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
        // Idempotent open guarantees the node exists even without a prior start.
        out.push({ type: "node_status", id: ensureStep(e.id, e.id), status: e.ok ? "done" : "failed" })
        break
      case "step_skipped":
        out.push({ type: "node_status", id: ensureStep(e.id, e.id), status: "skipped" })
        break
    }
  }
  return out
}

/**
 * Emit the run-close transition. Derives the LAST phase from the same event
 * stream (no fragile caller-supplied phase name), closes it, then settles the
 * run root. The spine derives done-vs-failed for both from their children, so
 * passing `ok` only stamps the explicit run outcome when the run has no steps.
 */
export const workflowCloseActivity = (
  events: readonly WorkflowEventLike[],
  opts: WorkflowToActivityOpts,
  ok: boolean,
  endedAt?: number,
): readonly AgentActivityEvent[] => {
  const out: AgentActivityEvent[] = []
  let lastPhase: string | undefined
  for (const e of events) if (e.type === "phase_enter") lastPhase = e.name
  if (lastPhase !== undefined) {
    out.push({ type: "node_status", id: phaseId(opts.runId, lastPhase), status: "done" })
  }
  out.push({
    type: "node_status",
    id: seg(opts.runId),
    status: ok ? "done" : "failed",
    ...(endedAt !== undefined ? { at: endedAt } : {}),
  })
  return out
}
