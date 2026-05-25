/**
 * N-phase HITL — driver port (ADR-0243).
 *
 * Single, closed port for the N-phase state machine. Sibling-clean: imports
 * only `./types`. Default impl lives in `./default-driver.ts`.
 *
 * Driver contract (three methods):
 *
 *   1. `current()` — returns the current {@link PhaseSpec}. Total; never
 *      throws (driver always has a current phase post-construction).
 *
 *   2. `transition(toPhaseId)` — attempts to move the machine to `toPhaseId`.
 *      Resolves with a {@link PhaseTransition} on success. Rejects with a
 *      {@link TransitionError} (closed-code) on policy violation:
 *        - `unknown-phase`        — `toPhaseId` not in the spec list.
 *        - `feedback-required`    — current phase has `requiresFeedback: true`
 *                                   and no positive feedback was recorded since
 *                                   the last entry into this phase.
 *        - `skip-not-allowed`     — target is non-adjacent and `allowSkip` is
 *                                   false on the current phase.
 *        - `no-next-phase`        — target is past the last phase.
 *        - `backward-not-permitted` — only feedback() can drive rollback;
 *                                     manual backward transition is rejected.
 *
 *   3. `feedback(result)` — records operator feedback for a phase. Rejects with
 *      a {@link FeedbackError} on:
 *        - `unknown-phase`   — `result.phase` not in the spec list.
 *        - `phase-mismatch`  — `result.phase !== current().id`. Feedback can
 *                              only be recorded against the CURRENT phase.
 *      A `positive: false` feedback triggers a rollback to the previous phase
 *      AND clears any positive feedback recorded for the (now-previous) phase.
 *      Resolves with the resulting {@link PhaseTransition} (direction
 *      `"rollback"`) when a rollback occurred, or `null` when feedback was
 *      merely recorded (positive path; advancing is the caller's next move).
 *
 * Sync vs. Promise: methods are NOT async because the default driver is
 * pure-functional and synchronous. The port returns plain values; a host
 * implementation that needs I/O can wrap with its own async front, but the
 * closed-port shape stays sync for hellgate determinism.
 */

import type { FeedbackResult, PhaseId, PhaseSpec, PhaseTransition } from "./types"

/** Closed port for the N-phase HITL state machine.
 *
 *  The default impl ({@link import("./default-driver").createDefaultNPhaseDriver})
 *  enforces all invariants; hosts that swap the impl (e.g. a remote IDE
 *  driver) MUST preserve the {@link TransitionError}/{@link FeedbackError}
 *  contract. */
export interface NPhaseDriver {
  /** Current phase spec. Always returns a value — driver is constructed with
   *  a non-empty spec list and starts at index 0. */
  current(): PhaseSpec

  /** Attempt to transition to `toPhaseId`. Throws {@link TransitionError} on
   *  policy violation (closed enum). Returns the transition record on success
   *  (direction is "forward" or "skip" — never "rollback"; rollback is
   *  feedback-driven only). */
  transition(toPhaseId: PhaseId): PhaseTransition

  /** Record operator feedback. Throws {@link FeedbackError} on unknown phase
   *  or phase-mismatch. Returns the {@link PhaseTransition} (direction
   *  "rollback") when negative feedback rolled back; returns `null` when
   *  feedback was merely recorded (positive). */
  feedback(result: FeedbackResult): PhaseTransition | null
}
