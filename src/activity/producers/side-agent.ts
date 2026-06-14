/**
 * Producer: side-agent daemon snapshots → activity events (jun-15 P0-a, gap G2).
 *
 * Maps a `@/side-agent` daemon snapshot (the OS-process registry's `list()`
 * shape) into spine events. Daemons are L0 `daemon` roots. Mirrored
 * structurally (no value import). `wakesDone` is surfaced via `meta` so the
 * fleet line can show "woke 4×".
 */

import type { AgentActivityEvent, ActivityStatus } from "../types"

/** Mirror of `@/side-agent`'s `SideAgentStatus`. */
export type SideAgentStatusLike = "running" | "stopped" | "failed" | "idle-reaped"

/** Structural mirror of the surfaced daemon snapshot slice (no value import). */
export interface SideAgentSnapshotLike {
  readonly id: string
  readonly label: string
  readonly status: SideAgentStatusLike
  readonly wakesDone: number
  readonly startedAt: number
  readonly stoppedAt?: number
  readonly lastFindingAt?: number
}

const STATUS: Readonly<Record<SideAgentStatusLike, ActivityStatus>> = {
  running: "running",
  stopped: "stopped",
  failed: "failed",
  "idle-reaped": "stopped",
}

export const sideAgentToActivity = (
  snap: SideAgentSnapshotLike,
): readonly AgentActivityEvent[] => {
  const status = STATUS[snap.status]
  const meta: Record<string, string> = { wakes: String(snap.wakesDone) }
  const open: AgentActivityEvent = {
    type: "node_open",
    node: {
      id: snap.id,
      parentId: null,
      kind: "daemon",
      label: snap.label,
      status: "running",
      at: snap.startedAt,
      meta,
    },
  }
  if (status === "running") return [open]
  return [
    open,
    {
      type: "node_status",
      id: snap.id,
      status,
      ...(snap.stoppedAt !== undefined ? { at: snap.stoppedAt } : {}),
    },
  ]
}

export const sideAgentsToActivity = (
  snaps: readonly SideAgentSnapshotLike[],
): readonly AgentActivityEvent[] => snaps.flatMap(sideAgentToActivity)
