/**
 * Mid-turn steering decision module (ADR-0030).
 *
 * Models Codex's `core-skills/src/injection.rs` shape: the host receives a
 * user message *while a turn is in flight* and decides whether to inject it
 * into the conversation (so the model sees it on the NEXT step within the
 * same turn) or to reject it with a closed-set reason. The injection itself
 * is performed by `loop.ts` — this module is the pure decision boundary.
 *
 * Properties enforced here (no fallbacks, no silent normalization):
 *
 *   1. **Optimistic concurrency** — `request.expectedTurnId` must equal the
 *      active turn's id. A mismatch yields the explicit
 *      `expected_turn_mismatch` rejection (Codex's race-protection contract).
 *   2. **Steerability** — `review` / `compact` / `standalone` turns are
 *      non-steerable per ADR-0030. Each maps to a distinct rejection reason
 *      so observability can tell the surface "which internal turn refused
 *      you" without inferring it.
 *   3. **Input invariants** — empty and oversized inputs are rejected with
 *      `empty_input` and `input_too_large`; non-string / control-character
 *      inputs throw `SteerInputInvalidError` so the caller (CLI/Web/Tauri)
 *      learns about a *programming* bug (vs. a *policy* rejection).
 *   4. **Interrupted state** — once the turn is interrupted (user cancel /
 *      provider abort), steer becomes a no-op with reason `interrupted`.
 *   5. **No active turn** — between turns there is nothing to steer into;
 *      reject with `no_active_turn`.
 *
 * The module is pure: it does not write into the conversation; it returns a
 * `SteerOutcome` discriminated union that the caller pushes onto the
 * working-memory user-message slot when accepted. Clocks are caller-supplied
 * (deterministic, replay-safe).
 */

import { isSteerable, NON_STEERABLE_KINDS, type TurnHeader, type TurnKind } from "./turn-kind"

/**
 * One mid-turn user input the surface (CLI/Web/Tauri) wants to inject. The
 * surface is responsible for capturing the user's typed text and the turn
 * id it observed when the user pressed send — the latter drives the
 * optimistic-concurrency check.
 */
export interface SteerRequest {
  /** Turn id the caller *expects* to be active. Mismatch ⇒
   *  `expected_turn_mismatch`. */
  readonly expectedTurnId: string
  /** Raw user input (UTF-8). Empty ⇒ `empty_input`; size policed by
   *  {@link SteerConfig.maxInputBytes}. */
  readonly input: string
  /** Wall-clock milliseconds at the time the user submitted (caller
   *  supplied — module never calls `Date.now()`). */
  readonly submittedAt: number
}

/**
 * The injection payload `loop.ts` will push onto working memory when the
 * outcome is `accepted`. Shape mirrors the user-side of `Message.content`
 * the seam already builds for nudge meta-messages, so the caller can
 * convert this to a `Message` with one transformation.
 */
export interface SteerInjection {
  readonly role: "user"
  readonly content: string
  readonly injectedAt: number
  readonly injectedDuringTurnId: string
}

/**
 * Closed set of reasons the steering decision returns when it rejects. Each
 * is observable on the trajectory; consumers MUST handle every literal
 * (exhaustive switch). The 8th historical reason — `standalone_turn` — is
 * split here per ADR-0030 into three precise `non_steerable_*` reasons so
 * the surface knows exactly which internal kind refused; that is closer to
 * Codex's `ActiveTurnNotSteerable { turn_kind }` shape than a single flag.
 */
export type SteerRejectionReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "non_steerable_review"
  | "non_steerable_compact"
  | "non_steerable_standalone"
  | "empty_input"
  | "input_too_large"
  | "interrupted"

/** All rejection reasons enumerated — used by tests for exhaustive
 *  coverage assertions without `as const` gymnastics. */
export const ALL_REJECTION_REASONS: ReadonlyArray<SteerRejectionReason> = [
  "no_active_turn",
  "expected_turn_mismatch",
  "non_steerable_review",
  "non_steerable_compact",
  "non_steerable_standalone",
  "empty_input",
  "input_too_large",
  "interrupted",
]

/**
 * Read-only snapshot of the agent's active-turn state. Constructed and
 * passed in by `loop.ts` — this module never reaches into mutable state.
 */
export interface ActiveTurnState {
  /** The header for the currently running turn, or `null` when no turn is
   *  in flight (between turns / after `done`). */
  readonly currentTurn: TurnHeader | null
  /** True after a user cancel / provider abort has been observed for the
   *  current turn; the loop is unwinding and cannot accept new input. */
  readonly isInterrupted: boolean
}

/**
 * Configuration knob set. All limits are explicit — no magic numbers. The
 * surface owns the policy choice (per-surface ceilings can differ); the
 * module enforces whatever the caller supplied.
 */
export interface SteerConfig {
  /** Maximum input size in UTF-8 bytes (counted by {@link utf8ByteLength}).
   *  Must be a finite positive integer; otherwise the constructor caller
   *  is a programming error and the module surfaces it through
   *  {@link SteerInputInvalidError} at decision time. */
  readonly maxInputBytes: number
}

/**
 * Discriminated outcome. Caller branches on `kind`:
 *
 *  - `accepted`: caller must push {@link SteerInjection} into working
 *    memory as a user `Message` BEFORE the next LLM stream opens.
 *  - `rejected`: caller emits an observability event with `reason` and
 *    keeps the in-flight turn untouched.
 */
export type SteerOutcome =
  | { kind: "accepted"; injection: SteerInjection }
  | { kind: "rejected"; reason: SteerRejectionReason; rejectedAt: number }

/**
 * Named error for programming-level invariant violations. Used when the
 * SURFACE has handed us a clearly malformed `request`/`config` (non-string
 * input, NaN timestamp, etc.) — that is a bug in the caller's wiring, not a
 * user-facing rejection.
 *
 * Per project rule (no silent catch, no sentinels), the steer entry point
 * THROWS this rather than synthesizing a fake `rejected` outcome.
 */
export class SteerInputInvalidError extends Error {
  readonly field: string
  constructor(field: string, detail: string) {
    super(`SteerInputInvalidError: ${field} — ${detail}`)
    this.name = "SteerInputInvalidError"
    this.field = field
  }
}

/** Lazily-constructed encoder; module-scope so we don't allocate per call. */
const UTF8_ENCODER = new TextEncoder()

/**
 * UTF-8 byte length of a string. Deterministic (no estimation, no per-char
 * heuristic). Used both for the `input_too_large` check and for tests that
 * want to encode boundary-of-acceptance fixtures.
 */
export const utf8ByteLength = (s: string): number => {
  if (typeof s !== "string") {
    throw new SteerInputInvalidError("input", `expected string (got ${typeof s})`)
  }
  return UTF8_ENCODER.encode(s).byteLength
}

/** Map a non-steerable TurnKind to its rejection reason. Internal — the
 *  enum-level exhaustiveness guard catches any future kind added without
 *  an explicit reason mapping. */
const reasonForNonSteerable = (kind: TurnKind): SteerRejectionReason => {
  switch (kind) {
    case "review":
      return "non_steerable_review"
    case "compact":
      return "non_steerable_compact"
    case "standalone":
      return "non_steerable_standalone"
    case "main": {
      // Programming error — `main` is steerable; reasonForNonSteerable
      // must never be called on it. Surface loudly rather than silently
      // emit a wrong rejection reason.
      throw new SteerInputInvalidError(
        "kind",
        `reasonForNonSteerable invoked for steerable kind "main"`,
      )
    }
    default: {
      const _exhaustive: never = kind
      throw new SteerInputInvalidError("kind", `unhandled TurnKind: ${String(_exhaustive)}`)
    }
  }
}

/** Validate `request` shape up-front. Programming-level failures throw
 *  {@link SteerInputInvalidError}; policy-level failures are reported via
 *  the outcome (handled inside {@link steer}). */
const assertRequestShape = (request: SteerRequest): void => {
  if (typeof request.expectedTurnId !== "string" || request.expectedTurnId.length === 0) {
    throw new SteerInputInvalidError("expectedTurnId", "must be a non-empty string")
  }
  if (typeof request.input !== "string") {
    throw new SteerInputInvalidError("input", `must be a string (got ${typeof request.input})`)
  }
  if (
    !Number.isFinite(request.submittedAt) ||
    !Number.isInteger(request.submittedAt) ||
    request.submittedAt < 0
  ) {
    throw new SteerInputInvalidError(
      "submittedAt",
      `must be a finite non-negative integer (got ${String(request.submittedAt)})`,
    )
  }
}

/** Validate `config` shape. Same throwing semantics as `assertRequestShape`. */
const assertConfigShape = (config: SteerConfig): void => {
  if (
    !Number.isFinite(config.maxInputBytes) ||
    !Number.isInteger(config.maxInputBytes) ||
    config.maxInputBytes <= 0
  ) {
    throw new SteerInputInvalidError(
      "maxInputBytes",
      `must be a finite positive integer (got ${String(config.maxInputBytes)})`,
    )
  }
}

/** Build a `rejected` outcome with the caller's clock. */
const rejected = (reason: SteerRejectionReason, rejectedAt: number): SteerOutcome => ({
  kind: "rejected",
  reason,
  rejectedAt,
})

/**
 * Decide whether to inject `request` into the active turn. Pure function;
 * the caller is responsible for the side effects (working-memory push,
 * trajectory emit, etc.).
 *
 * Decision order (each step short-circuits):
 *   1. interrupted state          ⇒ `interrupted`
 *   2. no active turn             ⇒ `no_active_turn`
 *   3. expectedTurnId mismatch    ⇒ `expected_turn_mismatch`
 *   4. non-steerable kind         ⇒ `non_steerable_{review,compact,standalone}`
 *   5. empty input (after trim)   ⇒ `empty_input`
 *   6. oversized input            ⇒ `input_too_large`
 *   7. otherwise                  ⇒ `accepted` with a fresh
 *                                   {@link SteerInjection}.
 *
 * The ordering is deterministic and documented: a request that violates
 * multiple invariants returns the FIRST violation in the list above, so the
 * trajectory is reproducible across replays.
 */
export const steer = (
  request: SteerRequest,
  state: ActiveTurnState,
  config: SteerConfig,
): SteerOutcome => {
  assertRequestShape(request)
  assertConfigShape(config)
  if (state.isInterrupted) {
    return rejected("interrupted", request.submittedAt)
  }
  const active = state.currentTurn
  if (active === null) {
    return rejected("no_active_turn", request.submittedAt)
  }
  if (active.turnId !== request.expectedTurnId) {
    return rejected("expected_turn_mismatch", request.submittedAt)
  }
  if (NON_STEERABLE_KINDS.has(active.kind)) {
    return rejected(reasonForNonSteerable(active.kind), request.submittedAt)
  }
  // Defensive: if a future kind is added to the enum without being added
  // to `NON_STEERABLE_KINDS` it falls through here as steerable — the
  // intended default per ADR-0030.
  if (!isSteerable(active.kind)) {
    // Unreachable today (only `main` is steerable) but kept as a guard
    // against the enum/predicate drifting silently in a future refactor.
    return rejected(reasonForNonSteerable(active.kind), request.submittedAt)
  }
  if (request.input.trim().length === 0) {
    return rejected("empty_input", request.submittedAt)
  }
  const bytes = utf8ByteLength(request.input)
  if (bytes > config.maxInputBytes) {
    return rejected("input_too_large", request.submittedAt)
  }
  const injection: SteerInjection = {
    role: "user",
    content: request.input,
    injectedAt: request.submittedAt,
    injectedDuringTurnId: active.turnId,
  }
  return { kind: "accepted", injection }
}

// ─────────────────────────────────────────────────────────────────────────
// Typed ConversationAction layer (ADR-0071 — absorbed from Cursor's
// `ConversationAction` oneof). ADDITIVE + PURE + DEFAULT-OFF.
//
// Everything ABOVE this banner is unchanged: `steer()` remains the canonical
// implementation of the `user_message` injection path and every existing
// export keeps its byte-identical behavior. The layer below models the FULL
// set of mid-turn user actions as a discriminated union and routes them
// through one pure decision function `decideAction()`. The `user_message`
// case *delegates* to `steer()` (it does not reimplement injection); the new
// control actions (cancel / cancel_subagent / summarize / resume) are decided
// here for the first time.
//
// **Integration seam (deferred to loop.ts follow-up, NOT wired here):** the
// loop will (a) construct `ActiveTurnState` per turn (already its job for
// `steer()`), (b) call `decideAction()` with the surface-supplied action, and
// (c) execute the side effect implied by an `accepted_control` outcome —
// crucially, for `cancel_subagent` it must cancel the ONE named child agent
// WITHOUT unwinding the parent turn (the parent keeps running). This module
// makes no side effects and never identifies which child exists — it validates
// SHAPE + turn-state only (see `unknown_subagent` note below). This banner is
// the documented hand-off point for that wiring.
// ─────────────────────────────────────────────────────────────────────────

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
