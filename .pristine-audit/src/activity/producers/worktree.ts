/**
 * Producer: current-thread worktree transition → activity events (RFC02-5 /
 * RFC06-2, aug-02 absorption).
 *
 * The FIRST real operation-correlated producer. A worktree transition is a
 * long-running OPERATION: the caller persists a `creating` intent, runs the git
 * effect, then publishes `ready` (or `failed` on a git error). This producer
 * maps those lifecycle positions INTO the SSOT spine vocabulary as ONE
 * correlated node — `running` at open, then a single TERMINAL transition
 * (`done` on ready, `failed` on git error) carrying the SAME
 * {@link OperationCorrelation} so a surface can stitch the transitions to the
 * one operation / thread / turn that ordered it.
 *
 * Pure + deterministic + no value import of `@/runner` / `@/session` (the
 * transition state is mirrored structurally, exactly as `workflow`/`fleet`
 * mirror their sources). NO new event type, NO status bus, NO per-feature
 * store: the correlation rides the existing `node_open` on the existing spine.
 *
 * Vocabulary discipline (mirrors `fleet.ts`'s `STATUS` table): the transition's
 * native settled kind maps through ONE low-cardinality table into the spine's
 * terminal statuses. `ready` → `done`, `failed` → `failed`. The producer does
 * NOT decide the outcome — it TRANSLATES the caller's already-settled result.
 */

import type { AgentActivityEvent, OperationCorrelation } from "../types"

/** Structural mirror of `TransitionResult["kind"]` settled positions the
 *  producer translates. `ready`/`failed` are the two terminal outcomes; a
 *  `rejected` request never STARTED an operation (no intent persisted, no git
 *  effect) so it is intentionally NOT a mappable settled kind — a rejected
 *  transition emits NO activity (byte-identical no-op). */
export type WorktreeSettledKind = "ready" | "failed"

/** Single SSOT mapping from the transition's settled kind to the spine's
 *  terminal vocabulary (mirrors `fleet.ts`'s `STATUS`). Low-cardinality + stable
 *  — never a dynamic status string. */
const SETTLED_STATUS: Readonly<Record<WorktreeSettledKind, "done" | "failed">> = {
  ready: "done",
  failed: "failed",
}

/** Stable id for the operation's spine node. Namespaced under a fixed
 *  `worktree-op/` prefix + the url-encoded operationId so a `/` in the id can
 *  never break the hierarchy or alias a sibling (mirrors `wfSeg`). The
 *  operationId is the correlation key — the SAME node id for open + terminal. */
export const worktreeOpNodeId = (operationId: string): string =>
  `worktree-op/${encodeURIComponent(operationId)}`

/** Facts a caller supplies to OPEN a worktree transition operation. */
export interface WorktreeOpenOpts {
  /** Stable operation id (the caller-minted ownershipId). */
  readonly operationId: string
  /** Owning thread/session id. */
  readonly threadId: string
  /** Optional turn id when the switch was ordered inside a specific turn. */
  readonly turnId?: string
  /** Optional run/workflow id when the operation nests under a run root. */
  readonly runId?: string
  /** Human label for the operation row (e.g. the target branch). */
  readonly label: string
  /** Epoch-ms the operation started (the intent-persist boundary). */
  readonly startedAt: number
  /** Optional parent node id (a run root); null/absent ⇒ an L0 operation. */
  readonly parentId?: string | null
}

/**
 * Emit the OPEN event for a worktree transition operation: a single `running`
 * node carrying the stable {@link OperationCorrelation} at `sequence: 0`. The
 * caller emits this at the intent-persist boundary — BEFORE the git effect — so
 * the operation is observable as `running` the instant it is ordered (never
 * success-before-effect: the terminal comes only after the effect settles).
 */
export const worktreeOpenActivity = (opts: WorktreeOpenOpts): AgentActivityEvent => {
  const correlation: OperationCorrelation = {
    operationId: opts.operationId,
    threadId: opts.threadId,
    sequence: 0,
    occurredAt: opts.startedAt,
    ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  }
  return {
    type: "node_open",
    node: {
      id: worktreeOpNodeId(opts.operationId),
      parentId: opts.parentId ?? null,
      kind: "phase",
      label: opts.label,
      status: "running",
      at: opts.startedAt,
      correlation,
    },
  }
}

/**
 * Emit the TERMINAL transition for a settled worktree operation. `kind` is the
 * caller's already-settled outcome (`ready`/`failed`); this producer only
 * TRANSLATES it through the SSOT table — it never decides the outcome. Stamps
 * `endedAt` so the node closes. The correlation on the OPEN node already stitches
 * this terminal to the same operation (the id is derived from the same
 * operationId), so the terminal event needs no correlation payload of its own.
 */
export const worktreeSettleActivity = (
  operationId: string,
  kind: WorktreeSettledKind,
  endedAt: number,
): AgentActivityEvent => ({
  type: "node_status",
  id: worktreeOpNodeId(operationId),
  status: SETTLED_STATUS[kind],
  at: endedAt,
})

/* ─────────────────────────── RFC-04 D1 — staged steps ─────────────────────────
 *
 * D1 refines the single coarse op node into a PARENT CONTAINER with staged child
 * step nodes, MIRRORING the `createWorkflowSink` container+child pattern
 * (`store.ts:113`) — a container whose status the spine DERIVES from its children
 * (`deriveContainerStatus`) — but deliberately NOT copying its `kind:"agent"`
 * accounting error. The steps are `kind:"phase"` (structural stages, never
 * agent-kind) so they NEVER fabricate agent/running/stuck counts; the container
 * derives `failed` iff a child failed, and — load-bearing — a `skipped` child is
 * NON-fatal (`skipped ≠ failed`), which is what lets a future "Environment setup
 * skipped" coexist with a successfully created worktree.
 *
 * The step nodes carry NO {@link OperationCorrelation}: only the parent op node
 * does, so a surface that filters operation rows by `correlation !== undefined`
 * still resolves EXACTLY ONE op node per operation (the existing e2e fence).
 */

/** The closed set of worktree-init stages. A `Record<WorktreeStep, …>` label
 *  table (below) is the drift-guard: adding a stage here fails to COMPILE until
 *  it is labelled (the `exhaustive-record-classification` pattern). `setup` is
 *  in the union so the label/producer contract is complete, but D1 does NOT wire
 *  a `setup` child into the transaction — that is D3 (PARKED behind a trusted
 *  config owner). D1 only emits `workspace`/`checkout`. */
export type WorktreeStep = "workspace" | "checkout" | "setup"

/** Human labels for each stage (mirrors the Codex staged-progress card copy).
 *  Exhaustive `Record<WorktreeStep, string>` ⇒ a new stage cannot ship unlabelled. */
const WORKTREE_STEP_LABEL: Readonly<Record<WorktreeStep, string>> = {
  workspace: "Preparing workspace",
  checkout: "Checking out files",
  setup: "Setting up environment",
}

/** Terminal outcomes a stage step can settle to. `skipped` is a DELIBERATE,
 *  non-fatal skip (proceed-anyway), distinct from `failed` — the derivation
 *  distinction is load-bearing (see the module note above). */
export type WorktreeStepOutcome = "done" | "failed" | "skipped"

/** Stable id for a stage child, namespaced UNDER the parent op node id. The
 *  parent id already url-encodes the operationId, and `step` is a fixed closed
 *  union literal (no `/`), so a step id can never break the hierarchy or alias a
 *  sibling operation's step (mirrors the `worktreeOpNodeId` discipline). */
export const worktreeStepId = (operationId: string, step: WorktreeStep): string =>
  `${worktreeOpNodeId(operationId)}/${step}`

/** Open a stage child as a `running` leaf under the parent op container. `kind`
 *  is `phase` (structural — NEVER `agent`) so the agent aggregate is invariant.
 *  Carries no correlation (the parent op node owns it). */
export const worktreeStepOpen = (
  operationId: string,
  step: WorktreeStep,
  at?: number,
): AgentActivityEvent => ({
  type: "node_open",
  node: {
    id: worktreeStepId(operationId, step),
    parentId: worktreeOpNodeId(operationId),
    kind: "phase",
    label: WORKTREE_STEP_LABEL[step],
    status: "running",
    ...(at !== undefined ? { at } : {}),
  },
})

/** Settle a stage child to its terminal outcome. The spine derives the parent
 *  container's honest status from these child outcomes at `materialize`. */
export const worktreeStepSettle = (
  operationId: string,
  step: WorktreeStep,
  outcome: WorktreeStepOutcome,
  at?: number,
): AgentActivityEvent => ({
  type: "node_status",
  id: worktreeStepId(operationId, step),
  status: outcome,
  ...(at !== undefined ? { at } : {}),
})

/**
 * RFC-04 D3 — refresh the `checkout` stage child's LIVE percentage as a
 * presentational `meta.checkoutPercentage` hint. This re-emits `node_open` for
 * the SAME `checkout` node id: the spine's idempotent re-open refreshes
 * `label`/`meta` while PRESERVING the node's identity, `running` status and
 * counters (`spine.ts` openNode) — so the percentage rides the EXISTING node
 * with NO new event type and NO `node_metric` abuse (percent is a presentational
 * hint, not a cumulative counter). `percentage` is git's OWN reported ratio,
 * already validated to an integer in [0,100] by the runner adapter; an
 * unparseable/indeterminate ratio never reaches here (the adapter emits nothing,
 * so the node stays `running` with no fabricated number — no-heuristics). The
 * full parentId/kind/status is supplied so this is also self-sufficient if a
 * progress line arrives before the coarse `checkout` open (it opens the node
 * running); a later open/settle for the same id is idempotent for identity.
 */
export const worktreeCheckoutProgress = (
  operationId: string,
  percentage: number,
): AgentActivityEvent => ({
  type: "node_open",
  node: {
    id: worktreeStepId(operationId, "checkout"),
    parentId: worktreeOpNodeId(operationId),
    kind: "phase",
    label: WORKTREE_STEP_LABEL.checkout,
    status: "running",
    meta: { checkoutPercentage: String(percentage) },
  },
})
