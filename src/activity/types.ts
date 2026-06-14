/**
 * Agent Activity Spine — canonical event + node model (jun-15 P0-a).
 *
 * The ONE model every agent-activity surface projects from. Workflow phases,
 * in-process subagents, side-agent daemons, reactor/remote/scheduled runs all
 * map their native shape into {@link AgentActivityEvent}s; the pure reducer
 * (`spine.ts`) folds them into an {@link ActivitySnapshot} tree; the surfaces
 * (CLI `/activity`, Web Mission Control, embedded) are PURE projectors of that
 * one snapshot — so the fleet view (L0), the run view (L1) and the agent view
 * (L2) are the SAME tree at different zoom depths, never three drifting UIs.
 *
 * Design rules (mirror `@/stream` item-stream-projector, T01):
 *  - The reducer is PURE and NO-THROW: a malformed / out-of-order event (e.g. a
 *    status for an unknown id) is dropped, never throws — a producer bug must
 *    not crash the observ­ability spine.
 *  - Deterministic: same event order ⇒ byte-identical snapshot. Child order is
 *    first-seen insertion order (NOT a Map iteration accident).
 *  - Single source: every projection (`project.ts`) is DERIVED from the
 *    snapshot, so projections cannot disagree on membership/status — pinned by
 *    the drift ratchet.
 */

/** The kind of node. Drives the surface's icon + which zoom level it anchors.
 *  `workflow`/`reactor`/`daemon`/`remote`/`scheduled` are L0 roots (one per
 *  running agent); `phase` is L1; `agent`/`tool` are L2. */
export type ActivityKind =
  | "workflow"
  | "phase"
  | "agent"
  | "tool"
  | "reactor"
  | "daemon"
  | "remote"
  | "scheduled"
  | "subagent"

/** Lifecycle status. A single SSOT vocabulary every producer maps INTO (so the
 *  source registries' divergent vocabularies — `completed` vs `done`,
 *  `idle-reaped` vs `idle` — converge here, mapped by the producers). */
export type ActivityStatus =
  | "pending" // declared, not started
  | "running" // actively executing
  | "stuck" // blocked, awaiting an external unblock (see `stuck`)
  | "idle" // alive but between wakes (daemons)
  | "done" // settled OK
  | "failed" // settled with error
  | "skipped" // gated out (a deliberate skip, not a failure)
  | "stopped" // cancelled / reaped

/** Why a node is `stuck` — the north-star "왜 멈췄나" payload. A closed union so
 *  surfaces can render a specific action chip (e.g. `approval` → [Approve]). */
export type StuckReason =
  | "waiting_approval"
  | "rate_limited"
  | "waiting_tool"
  | "waiting_subagent"
  | "waiting_input"
  | "unknown"

/** A stuck annotation. `detail` is a short human label (e.g. the tool/file the
 *  node is blocked on) — surfaces show it inline next to the action chip. */
export interface Stuck {
  readonly reason: StuckReason
  readonly detail?: string
}

/** One node in the activity tree. Counters (`tokens`/`toolCalls`) are
 *  cumulative for THIS node only; aggregates roll up in the snapshot. */
export interface ActivityNode {
  readonly id: string
  readonly parentId: string | null
  readonly kind: ActivityKind
  readonly label: string
  readonly status: ActivityStatus
  readonly startedAt?: number
  readonly endedAt?: number
  readonly tokens: number
  readonly toolCalls: number
  readonly stuck?: Stuck
  /** Free-form, surface-rendered hints (e.g. `{ tool: "Bash", model: "gpt-5" }`). */
  readonly meta?: Readonly<Record<string, string>>
}

/** Fields a producer supplies when OPENING a node. `tokens`/`toolCalls` default
 *  to 0; `status` defaults to `running` (an opened node is live unless said
 *  otherwise). */
export interface NodeInit {
  readonly id: string
  readonly parentId: string | null
  readonly kind: ActivityKind
  readonly label: string
  readonly status?: ActivityStatus
  readonly at?: number
  readonly meta?: Readonly<Record<string, string>>
}

/** Canonical activity event. The ONE shape all producers emit. */
export type AgentActivityEvent =
  /** Create (or re-assert) a node. Re-opening an existing id is a NO-OP for the
   *  identity fields (idempotent) but refreshes `label`/`meta` — a producer may
   *  legitimately re-emit on reconnect. */
  | { readonly type: "node_open"; readonly node: NodeInit }
  /** Transition status (and optionally annotate `stuck`). `at` stamps
   *  start/end where the transition implies one. */
  | {
      readonly type: "node_status"
      readonly id: string
      readonly status: ActivityStatus
      readonly at?: number
      readonly stuck?: Stuck
    }
  /** Add to this node's cumulative counters (deltas, not absolutes). */
  | {
      readonly type: "node_metric"
      readonly id: string
      readonly tokensDelta?: number
      readonly toolCallsDelta?: number
    }

/** Rolled-up totals over the whole tree (the L0 header line). */
export interface ActivityAggregate {
  readonly agents: number // nodes of an agent-ish kind (excludes phase/tool roots)
  readonly running: number
  readonly stuck: number
  readonly tokens: number
  readonly toolCalls: number
}

/** Materialized, immutable view of the spine at a point in time. `byId` +
 *  `childIds` together are the tree; `roots` are the L0 entries (parentId
 *  null), in first-seen order. */
export interface ActivitySnapshot {
  readonly roots: readonly string[]
  readonly byId: ReadonlyMap<string, ActivityNode>
  readonly childIds: ReadonlyMap<string, readonly string[]>
  readonly aggregate: ActivityAggregate
}
