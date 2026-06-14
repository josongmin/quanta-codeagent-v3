/**
 * Producer: workflow events → activity events (jun-15 P0-a, gap G3).
 *
 * Maps the executor's `WorkflowEvent` stream (`@/workflow`) into spine events
 * WITHOUT importing the workflow engine's values — it takes the plain event
 * array (the executor already exposes `WorkflowResult.events` + a live
 * `WorkflowSink`). The run becomes an L0 `workflow` root; `phase_enter` opens an
 * L1 `phase` (and closes the prior one); each `step_*` is an L2 `agent` under
 * the current phase.
 *
 * Pure + deterministic: same event order ⇒ same activity event order. NO engine
 * coupling beyond the `WorkflowEvent` shape (structurally mirrored, so the
 * activity slice does not value-import `@/workflow`).
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

const phaseId = (runId: string, name: string): string => `${runId}/phase/${name}`
const stepId = (runId: string, id: string): string => `${runId}/step/${id}`

/**
 * Translate a workflow event sequence into spine events. Emits the run root
 * first; tracks the current phase so steps attach to it. Steps emitted before
 * any phase attach directly to the run root.
 */
export const workflowToActivity = (
  events: readonly WorkflowEventLike[],
  opts: WorkflowToActivityOpts,
): readonly AgentActivityEvent[] => {
  const out: AgentActivityEvent[] = [
    {
      type: "node_open",
      node: {
        id: opts.runId,
        parentId: null,
        kind: "workflow",
        label: opts.label,
        status: "running",
        ...(opts.startedAt !== undefined ? { at: opts.startedAt } : {}),
      },
    },
  ]
  let currentPhase: string | null = null
  for (const e of events) {
    switch (e.type) {
      case "phase_enter": {
        // A new phase implies the previous one finished.
        if (currentPhase !== null) {
          out.push({ type: "node_status", id: currentPhase, status: "done" })
        }
        const pid = phaseId(opts.runId, e.name)
        out.push({
          type: "node_open",
          node: { id: pid, parentId: opts.runId, kind: "phase", label: e.name, status: "running" },
        })
        currentPhase = pid
        break
      }
      case "step_start":
        out.push({
          type: "node_open",
          node: {
            id: stepId(opts.runId, e.id),
            parentId: currentPhase ?? opts.runId,
            kind: "agent",
            label: e.label,
            status: "running",
          },
        })
        break
      case "step_complete":
        out.push({
          type: "node_status",
          id: stepId(opts.runId, e.id),
          status: e.ok ? "done" : "failed",
        })
        break
      case "step_skipped":
        out.push({ type: "node_status", id: stepId(opts.runId, e.id), status: "skipped" })
        break
    }
  }
  return out
}

/** Emit the run-close transition (the executor's `WorkflowResult.ok` is a
 *  separate signal from the event stream). Closes the last open phase too. */
export const workflowCloseActivity = (
  opts: WorkflowToActivityOpts,
  ok: boolean,
  lastPhaseName?: string,
  endedAt?: number,
): readonly AgentActivityEvent[] => {
  const out: AgentActivityEvent[] = []
  if (lastPhaseName !== undefined) {
    out.push({ type: "node_status", id: phaseId(opts.runId, lastPhaseName), status: "done" })
  }
  out.push({
    type: "node_status",
    id: opts.runId,
    status: ok ? "done" : "failed",
    ...(endedAt !== undefined ? { at: endedAt } : {}),
  })
  return out
}
