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

import type { ItemStreamCore } from "@/shared"
import type { ActivityStatus, AgentActivityEvent } from "../types"

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

/**
 * S2 unified-observability (jul-03) — bridge an ActivityStore subagent snapshot
 * (a fleet row) into the ONE item-stream as a `subagent` item core, so the
 * fleet view is NOT a disjoint model but a projection of the same item taxonomy
 * a surface already renders reasoning / tool / plan from.
 *
 * L0→L2 drilldown rides the item body (JSON): L0 = the root identity
 * (`id`/`description`/`agentType`), L1 = the run status, L2 = the settled detail
 * (`turns`/`finalText`/`error`). A running row is an OPEN item (started only —
 * the surface shows a live spinner); a settled row completes with the drilldown
 * body. This uses the SAME {@link ItemStreamCore} contract both wire planes carry
 * verbatim, so no transport edit is needed.
 *
 * Pure + additive: this is a NEW projection alongside {@link fleetRowToActivity}
 * (the spine mapping is untouched, byte-stable). The caller (a host that has
 * `QUANTA_ITEM_STREAM` on) feeds these cores onto the item wire; absent that
 * gate, this function is simply never called.
 */
export const fleetRowToItemStream = (row: FleetRowLike, index: number): readonly ItemStreamCore[] => {
  const itemId = `item-subagent-${row.id}`
  const started: ItemStreamCore = { phase: "started", itemId, itemType: "subagent", index }
  if (STATUS[row.status] === "running") return [started]
  // L0→L2 drilldown detail carried on the completed body.
  const detail: Record<string, unknown> = {
    id: row.id,
    description: row.description,
    status: STATUS[row.status],
    ...(row.agentType !== undefined ? { agentType: row.agentType } : {}),
    ...(row.result !== undefined
      ? { turns: row.result.turns, finalText: row.result.finalText, ok: row.result.ok }
      : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
  }
  return [started, { phase: "completed", itemId, itemType: "subagent", text: JSON.stringify(detail) }]
}

/** Map a whole fleet snapshot into item-stream cores (monotonic index). */
export const fleetToItemStream = (rows: readonly FleetRowLike[]): readonly ItemStreamCore[] =>
  rows.flatMap((row, i) => fleetRowToItemStream(row, i))
