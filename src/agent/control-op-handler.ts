/**
 * Control-op handler — L3→L4 promotion (2026-05-23).
 *
 * Shared cancel_subagent / interrupt behavior wired by BOTH the submission-op
 * envelope (`./submission.ts`) and the typed conversation-action layer
 * (`./conversation-action.ts`). The two surfaces previously had typed-but-
 * unbehaved control-ops (accepted-and-ignored stubs at L3); this module is
 * the L4 behavioral pivot.
 *
 * Three pure helpers shipped here:
 *
 *   - {@link cancelSubagent}: route a `cancel_subagent` op to the session's
 *     TaskRegistry. Registry-absent and unknown-id are observed (not thrown)
 *     so the loop's parent turn KEEPS running. The 3-way outcome
 *     (`stopped | not_found | registry_absent`) is surface-visible via the
 *     emitted `subagent_cancel` AgentEvent.
 *   - {@link isInterruptOp}: type narrow for submission-op interrupts.
 *   - {@link isCancelSubagentOp}: type narrow for submission-op
 *     cancel_subagent.
 *
 * All helpers are PURE except `cancelSubagent` (which mutates the registry)
 * and emit no events themselves — the loop is responsible for emitting the
 * matching `subagent_cancel` / `interrupted` AgentEvent. That separation
 * keeps the helpers unit-testable without a stream.
 *
 * A follow-up promotion (queued-follow-ups L4) extends this module with the
 * `RESPONSE_QUEUED_REASONS` closed taxonomy for the back-pressure event.
 */

import type { BriefStore } from "./brief"
import { ALL_PAUSED_REASONS, type PausedReason } from "./follow-up-queue"
import type { Submission } from "./submission"

/**
 * Closed reason taxonomy for the `response_queued` AgentEvent (back-pressure
 * signal). Union of {@link PausedReason} (the 10 thread-pause states the
 * follow-up queue reports) plus two control-op-pending reasons documented
 * here — the stream/types.ts comment pins the contract that adding a new
 * reason MUST extend BOTH this union AND {@link RESPONSE_QUEUED_REASONS}.
 *
 *   - `submission_op_pending`    — interrupt/cancel_subagent op received but
 *                                   the loop deferred behavior (e.g., session
 *                                   not yet ready — Codex `ensureReady`).
 *   - `subagent_cancel_pending`  — cancel_subagent named a subagent whose
 *                                   registration has not yet been observed
 *                                   (race between spawn-ack and cancel). The
 *                                   parent turn keeps running.
 *
 * Closed-union exhaustiveness forces compile-time coverage when a new
 * reason is added.
 */
export type ResponseQueuedReason =
  | PausedReason
  | "submission_op_pending"
  | "subagent_cancel_pending"

/** All {@link ResponseQueuedReason} values as a readonly array — used by
 *  the enum-coverage test (mirrors `ALL_PAUSED_REASONS`). Adding a new
 *  reason MUST extend both the union and this array. */
export const RESPONSE_QUEUED_REASONS: readonly ResponseQueuedReason[] = Object.freeze([
  ...ALL_PAUSED_REASONS,
  "submission_op_pending",
  "subagent_cancel_pending",
] as const)

/**
 * Outcome of routing a `cancel_subagent` op through the session's
 * `TaskRegistry`. The 3-way enum is closed; adding a new outcome MUST extend
 * this union AND the matching `subagent_cancel` AgentEvent in
 * `@/stream/types`. Mirrors Codex's subagent registry contract (ADR-0011) —
 * an unknown id is observation, NOT a thrown error (the parent turn keeps
 * running; the surface gets to decide whether to retry / log).
 *
 *   - `stopped`           — the registry had a RUNNING task with this id; it
 *                            was force-stopped. The parent turn continues.
 *   - `not_found`         — the registry has no record of this id (never
 *                            registered, or already settled). Observation
 *                            only; the parent turn continues.
 *   - `registry_absent`   — the session has no subagent registry at all
 *                            (the caller never opted into `cfg.subagent`).
 *                            Observation only; the parent turn continues.
 */
export type CancelSubagentOutcome = "stopped" | "not_found" | "registry_absent"

/** Narrow shape of the subagent-registry slice this module needs (mirrors
 *  `TaskRegistry.forceStop`'s signature). Taking the narrow type instead of
 *  the whole `TaskRegistry` keeps the module unit-testable with a fake
 *  registry and documents the exact surface used. */
export interface SubagentRegistrySlice {
  /** Force-cancel a running task without an owner token. Returns `true`
   *  when the task was found+stopped, `false` when the id is unknown or
   *  already settled. Mirrors `TaskRegistry.forceStop`. */
  forceStop(id: string): boolean
}

/**
 * Route a `cancel_subagent` op (from a submission envelope OR a typed
 * conversation-action) to the session's subagent registry.
 *
 * Pure except for the registry mutation:
 *   - registry undefined        → `registry_absent` (no allocation, no
 *                                  registry consult).
 *   - registry present, hit     → `forceStop` is called, returns `true`
 *                                  ⇒ `stopped`.
 *   - registry present, no hit  → `forceStop` returns `false`
 *                                  ⇒ `not_found`.
 *
 * NEVER throws — even on a malformed `subagentId` the loop's parent turn
 * must keep running. The caller (loop) MUST emit the matching
 * `subagent_cancel` AgentEvent with the returned outcome.
 */
export const cancelSubagent = (
  registry: SubagentRegistrySlice | undefined,
  subagentId: string,
): CancelSubagentOutcome => {
  if (registry === undefined) return "registry_absent"
  // Defensive: `forceStop` itself never throws (see TaskRegistry impl) but a
  // bug in a host-supplied stub MUST NOT propagate into the parent loop. A
  // throw collapses to `not_found` (same shape as "no record").
  let stopped: boolean
  try {
    stopped = registry.forceStop(subagentId)
  } catch {
    return "not_found"
  }
  return stopped ? "stopped" : "not_found"
}

/**
 * Closed outcome of routing a `force_background` control-op (ADR-0487) through
 * the session's background-subagent scheduler. Mirrors
 * {@link CancelSubagentOutcome}'s no-throw posture — every input collapses to a
 * closed arm, NEVER a thrown error, so the parent turn keeps running. Adding a
 * new arm MUST extend this union AND the matching `force_background` AgentEvent
 * in `@/stream/types`.
 *
 *   - `promoted_now`    — a slot was free (or `allowBurst` granted a +1 burst);
 *                          the queued subagent started running immediately.
 *   - `moved_to_front`  — no free slot / no burst; re-ordered to the FIFO head
 *                          (runs next).
 *   - `already_running` — the handle was already running OR terminal (no-op).
 *   - `not_found`       — unknown handle id.
 *   - `queue_disabled`  — the scheduler has no admission queue (default path).
 *   - `scheduler_absent`— the session never opted into a background scheduler
 *                          at all. Observation only; the parent turn continues.
 */
export type ForceBackgroundControlOutcome =
  | "promoted_now"
  | "moved_to_front"
  | "already_running"
  | "not_found"
  | "queue_disabled"
  | "scheduler_absent"

/** Narrow shape of the scheduler slice this module needs (mirrors
 *  `BackgroundSubagentScheduler.forceBackground`'s signature). Taking the
 *  narrow type keeps the module unit-testable with a fake and documents the
 *  exact surface used — the same discipline as {@link SubagentRegistrySlice}.
 *  The 5 producer outcomes are a SUBSET of
 *  {@link ForceBackgroundControlOutcome} (which adds `scheduler_absent`). */
export interface BackgroundSchedulerSlice {
  /** Promote a queued handle to run NOW (or the FIFO head). No-throw; returns
   *  a closed 5-way outcome. */
  forceBackground(
    id: string,
    opts?: { allowBurst?: boolean },
  ): "promoted_now" | "moved_to_front" | "already_running" | "not_found" | "queue_disabled"
}

/**
 * Route a `force_background` op (from a submission envelope OR the model-facing
 * `subagent_force_background` tool) to the session's background scheduler.
 *
 * Pure except for the scheduler mutation:
 *   - scheduler undefined  → `scheduler_absent` (no allocation, no consult).
 *   - scheduler present     → returns its closed `forceBackground` outcome.
 *
 * NEVER throws — even on a malformed `handleId` OR a buggy host-supplied stub
 * the loop's parent turn must keep running. A throw collapses to `not_found`
 * (same shape as "no record"), mirroring {@link cancelSubagent}.
 */
export const forceBackground = (
  scheduler: BackgroundSchedulerSlice | undefined,
  handleId: string,
  opts?: { allowBurst?: boolean },
): ForceBackgroundControlOutcome => {
  if (scheduler === undefined) return "scheduler_absent"
  try {
    return scheduler.forceBackground(handleId, opts)
  } catch {
    return "not_found"
  }
}

/** Type guard: this submission envelope carries the `interrupt` op. */
export const isInterruptOp = (
  sub: Submission,
): sub is Submission & { op: { kind: "interrupt"; turnId?: string } } => sub.op.kind === "interrupt"

/** Type guard: this submission envelope carries the `cancel_subagent` op. */
export const isCancelSubagentOp = (
  sub: Submission,
): sub is Submission & { op: { kind: "cancel_subagent"; subagentId: string } } =>
  sub.op.kind === "cancel_subagent"

/** Type guard: this submission envelope carries the `set_mode` op (P3,
 *  2026-05-23). Mirrors {@link isInterruptOp} / {@link isCancelSubagentOp};
 *  loop wiring is out of P3 scope — a follow-up will consume this guard. */
export const isSetModeOp = (
  sub: Submission,
): sub is Submission & {
  op: { kind: "set_mode"; mode: "default" | "plan"; reason?: string }
} => sub.op.kind === "set_mode"

/** Type guard: this submission envelope carries the `set_brief` op (C3,
 *  jun-4-brief-mode RFC). Mirrors {@link isSetModeOp}; the loop routes the op
 *  through {@link applyBriefTransition}. */
export const isSetBriefOp = (
  sub: Submission,
): sub is Submission & {
  op: { kind: "set_brief"; on: boolean; reason?: string }
} => sub.op.kind === "set_brief"

/** C3 — apply a `set_brief` op to the session's brief-mode store. Pure except
 *  for the store mutation; NEVER throws (a malformed op must not crash the
 *  parent loop). Returns the resolved boolean that was written so the caller
 *  can echo a confirmation / emit a posture-changed event. The NEXT turn's
 *  `buildTurnContext({ brief })` observes the new value. */
export const applyBriefTransition = (store: BriefStore, on: boolean): boolean => {
  store.set(on)
  return store.get()
}
