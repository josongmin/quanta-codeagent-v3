/**
 * Typed ConversationAction layer (ADR-0071 — absorbed from Cursor's
 * `ConversationAction` oneof). ADDITIVE + PURE + DEFAULT-OFF.
 *
 * Split out of `steering.ts` (#7): the mid-turn STEERING decision engine
 * (`steer()` and friends) and this CONVERSATION-ACTION decision engine are two
 * disjoint subsystems that previously shared a single file. They share nothing
 * but their dependence on the steering primitives — this module imports them
 * from `./steering` rather than reimplementing anything.
 *
 * `steer()` remains the canonical implementation of the `user_message`
 * injection path; every existing export keeps its byte-identical behavior. The
 * layer here models the FULL set of mid-turn user actions as a discriminated
 * union and routes them through one pure decision function `decideAction()`.
 * The `user_message` case *delegates* to `steer()` (it does not reimplement
 * injection); the new control actions (cancel / cancel_subagent / summarize /
 * resume) are decided here for the first time.
 *
 * **Integration seam (deferred to loop.ts follow-up, NOT wired here):** the
 * loop will (a) construct `ActiveTurnState` per turn (already its job for
 * `steer()`), (b) call `decideAction()` with the surface-supplied action, and
 * (c) execute the side effect implied by an `accepted_control` outcome —
 * crucially, for `cancel_subagent` it must cancel the ONE named child agent
 * WITHOUT unwinding the parent turn (the parent keeps running). This module
 * makes no side effects and never identifies which child exists — it validates
 * SHAPE + turn-state only (see `unknown_subagent` note below). This banner is
 * the documented hand-off point for that wiring.
 */

import { ALL_REJECTION_REASONS, type SteerRejectionReason } from "./steer-reasons"
import {
  type ActiveTurnState,
  type SteerConfig,
  type SteerInjection,
  SteerInputInvalidError,
  type SteerRequest,
  steer,
} from "./steering"
import type { TurnHeader } from "./turn-kind"

/**
 * Typed mid-turn user action — a discriminated union mirroring Cursor's
 * `ConversationAction` oneof. The `kind` literal is the discriminant; the set
 * is closed (see {@link ALL_ACTION_KINDS}). Today's free-text steering is the
 * `user_message` case; the other four are control actions decided by
 * {@link decideAction}.
 *
 *  - `user_message` — inject text mid-turn. Optional `prepend[]` lines are
 *    concatenated AHEAD of `input` (see {@link ACTION_PREPEND_SEPARATOR}); the
 *    combined string then flows through {@link steer} unchanged.
 *  - `cancel` — cancel the whole active turn. Carries a non-empty human
 *    `reason` (observable on the trajectory).
 *  - `cancel_subagent` — **the headline new capability**: cancel ONE child
 *    subagent identified by `subagentId`, leaving the parent turn running.
 *    quanta previously had no way to express this (cancel always meant the
 *    whole turn).
 *  - `summarize` — request a mid-turn summarization of the conversation.
 *  - `resume` — resume after an interruption.
 *
 * Control actions MAY carry an optional `expectedTurnId` for opt-in
 * optimistic concurrency (see {@link ControlExpectation}); `user_message`
 * always carries one via its delegation to {@link SteerRequest}.
 */
export type ConversationAction =
  | { kind: "user_message"; input: string; prepend?: readonly string[]; expectedTurnId?: string }
  | ({ kind: "cancel"; reason: string } & ControlExpectation)
  | ({ kind: "cancel_subagent"; subagentId: string } & ControlExpectation)
  | ({ kind: "summarize" } & ControlExpectation)
  | ({ kind: "resume" } & ControlExpectation)

/**
 * Opt-in optimistic-concurrency carrier for CONTROL actions. Unlike
 * {@link SteerRequest} (where `expectedTurnId` is mandatory), a control action
 * may target "whatever turn is active" without having observed an id. When
 * `expectedTurnId` is present, {@link decideAction} enforces the same
 * mismatch check `steer()` does; when omitted, the check is skipped (the
 * action applies to the active turn regardless of id). This keeps the API
 * honest: a surface that DID observe an id gets race protection; one that
 * didn't is not forced to fabricate a sentinel.
 */
export interface ControlExpectation {
  /** Turn id the caller expects to be active. Present ⇒ enforce
   *  `control_turn_mismatch` on mismatch; omitted ⇒ no concurrency check. */
  readonly expectedTurnId?: string
}

/** All action kinds enumerated — mirrors {@link ALL_REJECTION_REASONS}'s
 *  contract for runtime exhaustiveness assertions without `as const`. */
export const ALL_ACTION_KINDS: ReadonlyArray<ConversationAction["kind"]> = [
  "user_message",
  "cancel",
  "cancel_subagent",
  "summarize",
  "resume",
]

/**
 * Separator inserted between each `prepend[]` line and the `input` for a
 * `user_message` action. A single newline — the only NEW injection-shaping
 * behavior this layer adds on top of `steer()`. Documented + exported so tests
 * (and the loop) reference the contract rather than a magic literal.
 */
export const ACTION_PREPEND_SEPARATOR = "\n"

/**
 * Closed set of reasons {@link decideAction} returns on rejection. REUSES the
 * full {@link SteerRejectionReason} set for the `user_message` path (those are
 * surfaced verbatim from the delegated `steer()` call) and adds two
 * control-specific reasons:
 *
 *  - `control_turn_mismatch` — a control action carried an `expectedTurnId`
 *    that did not match the active turn (opt-in optimistic concurrency).
 *  - `not_interrupted` — `resume` was requested but the turn is not in the
 *    interrupted state, so there is nothing to resume.
 *
 * NOTE on `unknown_subagent`: validating that a given `subagentId` actually
 * names a live child is the CALLER's responsibility (the loop owns the child
 * registry); `decideAction` validates only the SHAPE (non-empty id) and
 * turn-state. It deliberately does NOT carry an `unknown_subagent` reason
 * because it has no child registry to consult — surfacing one here would be a
 * lie. The loop rejects unknown ids after `decideAction` accepts the shape.
 */
export type ActionRejectionReason =
  | SteerRejectionReason
  | "control_turn_mismatch"
  | "not_interrupted"

/** All action rejection reasons enumerated — the steer reasons plus the two
 *  control-specific additions. Mirrors {@link ALL_REJECTION_REASONS}. */
export const ALL_ACTION_REJECTION_REASONS: ReadonlyArray<ActionRejectionReason> = [
  ...ALL_REJECTION_REASONS,
  "control_turn_mismatch",
  "not_interrupted",
]

/**
 * Discriminated outcome of {@link decideAction}. Three arms:
 *
 *  - `accepted_injection` — a `user_message` was accepted; carries the same
 *    {@link SteerInjection} `steer()` produced (caller pushes it onto working
 *    memory, identical to the existing path).
 *  - `accepted_control` — a control action was accepted; carries the original
 *    (validated) {@link ConversationAction} so the loop knows exactly what to
 *    execute (cancel the turn / cancel one child / summarize / resume).
 *  - `rejected` — closed-set `reason` + caller's clock, same shape as
 *    {@link SteerOutcome}'s rejected arm.
 */
export type ActionOutcome =
  | { kind: "accepted_injection"; injection: SteerInjection }
  | { kind: "accepted_control"; action: ConversationAction }
  | { kind: "rejected"; reason: ActionRejectionReason; rejectedAt: number }

/** Build a `rejected` ActionOutcome with the caller's clock. */
const rejectedAction = (reason: ActionRejectionReason, rejectedAt: number): ActionOutcome => ({
  kind: "rejected",
  reason,
  rejectedAt,
})

/**
 * Enforce opt-in optimistic concurrency for a control action. Returns the
 * active {@link TurnHeader} when the action may proceed, or a `rejected`
 * ActionOutcome otherwise. Precedence mirrors `steer()`:
 *   1. interrupted state    ⇒ `interrupted` (except `resume`, handled by caller)
 *   2. no active turn       ⇒ `no_active_turn`
 *   3. expectedTurnId given AND mismatched ⇒ `control_turn_mismatch`
 *
 * `resume` is the one action that is VALID while interrupted, so the caller
 * passes `allowInterrupted` to skip step 1.
 */
const gateControl = (
  expectation: ControlExpectation,
  state: ActiveTurnState,
  now: number,
  allowInterrupted: boolean,
): TurnHeader | ActionOutcome => {
  if (state.isInterrupted && !allowInterrupted) {
    return rejectedAction("interrupted", now)
  }
  const active = state.currentTurn
  if (active === null) {
    return rejectedAction("no_active_turn", now)
  }
  if (expectation.expectedTurnId !== undefined) {
    if (typeof expectation.expectedTurnId !== "string" || expectation.expectedTurnId.length === 0) {
      throw new SteerInputInvalidError("expectedTurnId", "must be a non-empty string when present")
    }
    if (active.turnId !== expectation.expectedTurnId) {
      return rejectedAction("control_turn_mismatch", now)
    }
  }
  return active
}

/**
 * Pure decision boundary for the typed {@link ConversationAction} layer. One
 * function routes every mid-turn user action; the caller (loop.ts) performs
 * the side effects implied by the outcome. Clocks are caller-supplied (`now`)
 * — the module never calls `Date.now()`, matching `steer()`.
 *
 * Per-kind rules (documented precisely):
 *
 *  - **user_message** — delegates to {@link steer}. Builds a
 *    {@link SteerRequest} from `input` (prefixed by `prepend[]` joined with
 *    {@link ACTION_PREPEND_SEPARATOR}), `now` as `submittedAt`, and
 *    `expectedTurnId`. Because `steer()` REQUIRES an `expectedTurnId`, a
 *    `user_message` without one is a programming bug ⇒ `SteerInputInvalidError`.
 *    The returned `SteerOutcome` maps 1:1 to `accepted_injection` / `rejected`.
 *
 *  - **cancel** — requires a non-empty string `reason` (else
 *    `SteerInputInvalidError`; a programming bug, not a policy rejection).
 *    Gated on an active turn (`no_active_turn` if none, `interrupted` if the
 *    turn is already unwinding — cancelling an unwinding turn is a no-op).
 *    Opt-in `expectedTurnId` enforced via {@link gateControl}.
 *
 *  - **cancel_subagent** — requires a non-empty string `subagentId` (else
 *    `SteerInputInvalidError`). Gated identically to `cancel`. On acceptance
 *    the loop cancels the ONE named child WITHOUT unwinding the parent turn
 *    (this module validates shape + turn-state only; it does NOT verify the id
 *    names a live child — see {@link ActionRejectionReason}).
 *
 *  - **summarize** — gated on an active, non-interrupted turn (summarizing a
 *    turn that is unwinding is meaningless ⇒ `interrupted` / `no_active_turn`).
 *    Opt-in concurrency enforced.
 *
 *  - **resume** — the inverse gate: VALID only when the turn IS interrupted.
 *    Requires an active turn (`no_active_turn`); if the turn is NOT interrupted
 *    there is nothing to resume ⇒ `not_interrupted`. Opt-in concurrency
 *    enforced.
 *
 * Exhaustive `switch` over `action.kind` with a `never` default so adding a
 * future kind without a branch is a compile error.
 */
export const decideAction = (
  action: ConversationAction,
  state: ActiveTurnState,
  config: SteerConfig,
  now: number,
): ActionOutcome => {
  if (!Number.isFinite(now) || !Number.isInteger(now) || now < 0) {
    throw new SteerInputInvalidError(
      "now",
      `must be a finite non-negative integer (got ${String(now)})`,
    )
  }
  switch (action.kind) {
    case "user_message": {
      const outcome = steer(buildUserMessageRequest(action, now), state, config)
      return outcome.kind === "accepted"
        ? { kind: "accepted_injection", injection: outcome.injection }
        : rejectedAction(outcome.reason, outcome.rejectedAt)
    }
    case "cancel": {
      if (typeof action.reason !== "string" || action.reason.trim().length === 0) {
        throw new SteerInputInvalidError("reason", "cancel requires a non-empty reason string")
      }
      return decideControl(action, state, now, {
        allowInterrupted: false,
        requireInterrupted: false,
      })
    }
    case "cancel_subagent": {
      if (typeof action.subagentId !== "string" || action.subagentId.trim().length === 0) {
        throw new SteerInputInvalidError(
          "subagentId",
          "cancel_subagent requires a non-empty subagentId string",
        )
      }
      return decideControl(action, state, now, {
        allowInterrupted: false,
        requireInterrupted: false,
      })
    }
    case "summarize":
      return decideControl(action, state, now, {
        allowInterrupted: false,
        requireInterrupted: false,
      })
    case "resume":
      // resume is valid ONLY while interrupted — allow the interrupted state
      // through the gate, then require it explicitly via requireInterrupted.
      return decideControl(action, state, now, {
        allowInterrupted: true,
        requireInterrupted: true,
      })
    default: {
      const _exhaustive: never = action
      throw new SteerInputInvalidError("kind", `unhandled action kind: ${String(_exhaustive)}`)
    }
  }
}

/** Narrow {@link gateControl}'s union return to its success arm. A
 *  `TurnHeader` (success) lacks the `kind: "rejected"` discriminant; the
 *  rejected ActionOutcome carries it. */
const isTurnHeader = (value: TurnHeader | ActionOutcome): value is TurnHeader =>
  !("kind" in value && value.kind === "rejected")

/** Validate a `user_message` action's shape and return the combined
 *  (`prepend[]` + `input`) text. Throws {@link SteerInputInvalidError} on any
 *  programming-level violation; extracted from {@link decideAction} so the
 *  switch stays within the cognitive-complexity budget. */
const buildUserMessageRequest = (
  action: Extract<ConversationAction, { kind: "user_message" }>,
  now: number,
): SteerRequest => {
  if (typeof action.input !== "string") {
    throw new SteerInputInvalidError("input", `must be a string (got ${typeof action.input})`)
  }
  if (action.expectedTurnId === undefined) {
    throw new SteerInputInvalidError(
      "expectedTurnId",
      "user_message must carry an expectedTurnId (delegates to steer())",
    )
  }
  const prepend = action.prepend ?? []
  if (!Array.isArray(prepend)) {
    throw new SteerInputInvalidError("prepend", "must be an array of strings when present")
  }
  for (const line of prepend) {
    if (typeof line !== "string") {
      throw new SteerInputInvalidError(
        "prepend",
        `every prepend line must be a string (got ${typeof line})`,
      )
    }
  }
  const combined =
    prepend.length === 0 ? action.input : [...prepend, action.input].join(ACTION_PREPEND_SEPARATOR)
  return { expectedTurnId: action.expectedTurnId, input: combined, submittedAt: now }
}

/** Decide a control action (cancel / cancel_subagent / summarize / resume)
 *  that has already passed its per-kind shape validation. `allowInterrupted`
 *  is true only for `resume`; `requireInterrupted` adds the `not_interrupted`
 *  gate (also `resume`). Extracted to keep {@link decideAction} flat. */
const decideControl = (
  action: ConversationAction,
  state: ActiveTurnState,
  now: number,
  opts: { allowInterrupted: boolean; requireInterrupted: boolean },
): ActionOutcome => {
  const gated = gateControl(action, state, now, opts.allowInterrupted)
  if (!isTurnHeader(gated)) return gated
  if (opts.requireInterrupted && !state.isInterrupted) {
    return rejectedAction("not_interrupted", now)
  }
  return { kind: "accepted_control", action }
}

/**
 * L4 wiring seam — `ConversationActionPort` (2026-05-23).
 *
 * The loop consults this port ONCE per turn at the top of the body, BEFORE
 * the next LLM stream opens. The surface returns the next pending typed
 * action (a synchronous pull — the surface owns its own queue / debounce
 * policy) or `undefined` when nothing is pending.
 *
 *   - Pull semantics (not push): the loop drives the cadence, identical to
 *     `cfg.steerBarrier` / `cfg.signal.aborted` — no separate event-loop
 *     thread, no race between push-emit and turn-entry snapshot.
 *   - Synchronous: the port is `() => ConversationAction | undefined`. The
 *     surface may build the action from an async source (TUI keystroke /
 *     websocket frame) but commits the snapshot the loop reads here.
 *   - At-most-once: each non-undefined return is consumed exactly once. The
 *     surface is responsible for NOT re-returning the same action on the
 *     next call.
 *
 * Default-OFF: when the field is absent the loop never reads it (byte-
 * identical legacy). Wired via `AgentConfig.conversationActionPort`.
 */
export interface ConversationActionPort {
  /** Return the next pending action OR `undefined` when nothing is pending.
   *  Pure-synchronous; never throws (a programming-error surface throw at the
   *  port boundary collapses to "no action" — the loop emits an `error`
   *  AgentEvent so a probe can still see the failure). */
  next(): ConversationAction | undefined
}
