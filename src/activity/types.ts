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

import type { Progress } from "./progress"

/** The kind of node. Drives the surface's icon + which zoom level it anchors.
 *  `workflow`/`reactor`/`daemon`/`remote`/`scheduled` are L0 roots (one per
 *  running agent); `phase` is L1; `agent`/`tool` are L2.
 *
 *  `operation`/`step` (RFC-04 R6 D1) are STRUCTURAL long-running-op nodes — an
 *  `operation` container (e.g. a worktree transition) with `step` children
 *  (validate / create / checkout / bind). They are DELIBERATELY not agent-ish:
 *  the aggregate's `AGENT_KINDS` (`spine.ts`) excludes them, so a staged
 *  operation NEVER fabricates agent/running/stuck counts — the D1 receipt
 *  "step nodes leave agent aggregate unchanged". */
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
  | "operation"
  | "step"

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

/**
 * RFC02-5 operation-correlation contract (aug-02 absorption, B6).
 *
 * The STABLE correlation a long-running OPERATION (a worktree transition, an env
 * setup) carries so a surface can stitch its `running`→`done|failed` transitions
 * to the run/thread/turn that ORDERED it — WITHOUT a second status bus or a
 * per-feature store. It is a thin annotation ON the existing spine node, not a
 * new event type: a producer stamps it at `node_open`; the spine carries it
 * verbatim; surfaces read it off the node.
 *
 * Cardinality discipline (mirrors the spine's status vocabulary rule): every
 * field is a STABLE, low-cardinality identifier the caller MINTS (a run id, a
 * thread id, an operation id) — NEVER a dynamic value (model/tool/path/free
 * text) that would explode the id space. `sequence` is a monotonic per-operation
 * step counter (0-based) so a surface can order an operation's transitions even
 * when wall-clock stamps collide; `occurredAt` is the epoch-ms the correlated
 * lifecycle position was reached.
 */
export interface OperationCorrelation {
  /** The long-running operation's stable id (caller-minted, e.g. an
   *  ownershipId). The SAME id for every transition of the one operation — this
   *  is what makes `running`/`done`/`failed` correlate to ONE operation. */
  readonly operationId: string
  /** Owning thread/session id (correlates the operation to the agent thread). */
  readonly threadId: string
  /** Optional turn id when the operation was ordered inside a specific turn. */
  readonly turnId?: string
  /** Optional run/workflow id when the operation nests under a run root. */
  readonly runId?: string
  /** Monotonic 0-based per-operation step counter (orders transitions). */
  readonly sequence: number
  /** Epoch-ms the correlated lifecycle position was reached. */
  readonly occurredAt: number
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
  /** RFC02-5 — the stable operation correlation this node projects (when it is
   *  a correlated long-running operation). Absent for ordinary spine nodes so
   *  the default posture is byte-identical. Stamped at `node_open`. */
  readonly correlation?: OperationCorrelation
  /** RFC-04 R6 D1 — the node's TYPED live progress (a closed `Progress` union,
   *  NOT a free-form meta string). Set/updated by `node_progress`; absent for a
   *  node with no ratio (the default posture is byte-identical). A renderer reads
   *  this typed field, never a stringly-typed percentage smuggled through `meta`. */
  readonly progress?: Progress | undefined
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
  /** RFC02-5 — stable operation correlation stamped onto the opened node. */
  readonly correlation?: OperationCorrelation
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

/**
 * RFC-04 R6 D1 — refresh a node's TYPED live progress. Kept OUT of
 * {@link AgentActivityEvent} deliberately: that union is the pure spine's closed
 * reducer contract (`spine.ts` folds it exhaustively), and progress is a
 * store-level concern (it rides the monotonic sequence + subscription, not the
 * pure fold). The store applies it (`store.ts`) via `mergeProgress`, so the
 * spine reducer and its exhaustiveness check stay byte-identical.
 *
 * `progress` is the already-closed `Progress` value (never a free-form string);
 * an unknown `id` is a NO-THROW drop (mirrors the spine's status/metric rule).
 */
export interface NodeProgressEvent {
  readonly type: "node_progress"
  readonly id: string
  readonly progress: Progress
}

/** The full store-level event vocabulary: the pure-spine events PLUS the
 *  store-applied {@link NodeProgressEvent}. `store.emit` accepts this wider
 *  union; anything that is not `node_progress` routes to the unchanged spine
 *  reducer. */
export type ActivityEvent = AgentActivityEvent | NodeProgressEvent

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
