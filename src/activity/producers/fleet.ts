/**
 * Producer: in-process subagent rows → activity events (jun-15 P0-a, gap G2).
 *
 * Maps the `agents-fleet-panel.ts` `AgentFleetRow` (itself a structural mirror
 * of `@/subagent`'s `TaskRecord`) into spine events. Mirrored structurally so
 * the activity slice does not value-import `@/subagent`. Each row is an L0
 * `subagent` root; the row's settled state maps INTO the SSOT
 * {@link ActivityStatus} vocabulary (so `completed`→`done`, `stopped`→
 * `stopped`).
 */

import type { AgentActivityEvent, ActivityStatus } from "../types"

/** Structural mirror of `AgentFleetRow` (no `@/subagent` value import). */
export interface FleetRowLike {
  readonly id: string
  readonly description: string
  readonly agentType?: string
  readonly status: "running" | "completed" | "failed" | "stopped"
  readonly startedAt: number
  readonly endedAt?: number
  readonly result?: { readonly ok: boolean; readonly finalText: string; readonly turns: number }
  readonly error?: string
}

/** Single SSOT mapping from the subagent vocabulary to the spine's. */
const STATUS: Readonly<Record<FleetRowLike["status"], ActivityStatus>> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
}

export const fleetRowToActivity = (row: FleetRowLike): readonly AgentActivityEvent[] => {
  const status = STATUS[row.status]
  const meta: Record<string, string> = {}
  if (row.agentType !== undefined) meta.agentType = row.agentType
  if (row.result !== undefined) meta.turns = String(row.result.turns)
  const open: AgentActivityEvent = {
    type: "node_open",
    node: {
      id: row.id,
      parentId: null,
      kind: "subagent",
      label: row.description,
      status: "running",
      at: row.startedAt,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    },
  }
  // Settled rows get a closing transition (stamped with `endedAt` when known).
  if (status === "running") return [open]
  return [
    open,
    {
      type: "node_status",
      id: row.id,
      status,
      ...(row.endedAt !== undefined ? { at: row.endedAt } : {}),
    },
  ]
}

/** Map a whole fleet snapshot. */
export const fleetToActivity = (rows: readonly FleetRowLike[]): readonly AgentActivityEvent[] =>
  rows.flatMap(fleetRowToActivity)
