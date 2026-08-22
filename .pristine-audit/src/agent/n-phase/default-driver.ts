/**
 * N-phase HITL — default driver (ADR-0243).
 *
 * Sequential state machine with a per-phase feedback ledger. Plane-clean
 * sibling — imports only `./types` + `./port`. No `@/llm`, no `@/tool`, no
 * `@/permission`, no time / random / I/O. Pure-functional; deterministic.
 *
 * Algorithm:
 *
 *   - Construct with a non-empty `PhaseSpec[]`. The list defines BOTH the
 *     allowed phase ids AND their order (index in the list). Duplicate ids
 *     throw at construction (closed-set invariant).
 *
 *   - `current()` reads the cursor index → `specs[idx]`.
 *
 *   - `transition(toId)` rules (in order):
 *       (a) `toId` must be in the spec list else `unknown-phase`.
 *       (b) targetIdx <= currentIdx ⇒ `backward-not-permitted` (only
 *           feedback() may drive rollback; manual backward is rejected).
 *       (c) currentSpec.requiresFeedback && !ledger.has(currentSpec.id)
 *           ⇒ `feedback-required`.
 *       (d) targetIdx > currentIdx + 1 (non-adjacent forward):
 *             - currentSpec.allowSkip === false ⇒ `skip-not-allowed`.
 *             - else direction === "skip".
 *       (e) targetIdx === currentIdx + 1 ⇒ direction === "forward".
 *       (f) (no "no-next-phase" path under sequential transition because the
 *           target id MUST exist in the spec list per (a). The error code is
 *           reserved for an alternate "advance to next" API surface; current
 *           transition() reaches it iff the spec list is exhausted AND the
 *           caller asks for an id past the last — which is already caught by
 *           (a).) Reserved for future `transitionToNext()` helper.
 *
 *   - On a successful forward/skip, the ledger entry for the SOURCE phase is
 *     consumed (cleared) — re-entering a `requiresFeedback` phase requires
 *     fresh feedback.
 *
 *   - `feedback(result)` rules:
 *       (a) `result.phase` must be in the spec list else `unknown-phase`.
 *       (b) `result.phase !== current().id` ⇒ `phase-mismatch`.
 *       (c) `positive: true` ⇒ records the positive flag in the ledger,
 *           returns null. The caller's next `transition()` may now proceed
 *           past the feedback gate.
 *       (d) `positive: false` AND currentIdx > 0 ⇒ ROLLBACK: cursor moves to
 *           currentIdx - 1, and BOTH endpoints' ledger entries are cleared —
 *           the now-current (rolled-into) phase AND the phase rolled back FROM.
 *           Clearing the rolled-into phase forces fresh feedback before
 *           advancing again; clearing the rolled-from phase mirrors the
 *           forward-transition consume semantics (a phase you LEAVE requires
 *           fresh feedback on re-entry — otherwise a stale positive entry would
 *           silently satisfy its requiresFeedback gate). Returns the {@link
 *           PhaseTransition} (direction "rollback").
 *       (e) `positive: false` AND currentIdx === 0 ⇒ no rollback possible,
 *           returns null (semantically a no-op — caller decides to abort).
 *
 *   - Optional `context` payload on `FeedbackResult` is preserved verbatim
 *     (shallow-copied via Object.freeze + spread to preserve reference
 *     immutability for the original input). HELL-NP-15 round-trips a
 *     `files_to_modify: string[]` and verifies deep equality.
 */

import type { NPhaseDriver } from "./port"
import {
  FeedbackError,
  type FeedbackResult,
  type PhaseId,
  type PhaseSpec,
  type PhaseTransition,
  TransitionError,
} from "./types"

/** Construction error — duplicate id in the spec list, or empty list. */
export class NPhaseDriverConfigError extends Error {
  readonly code: "empty-specs" | "duplicate-id"
  constructor(code: "empty-specs" | "duplicate-id", detail: string) {
    super(`NPhaseDriverConfigError(${code}): ${detail}`)
    this.code = code
    this.name = "NPhaseDriverConfigError"
  }
}

/** Frozen feedback ledger entry. `context` is omitted when caller did not
 *  supply one (exactOptionalPropertyTypes — never `undefined`). */
interface LedgerEntry {
  readonly positive: true
  readonly context?: Readonly<Record<string, unknown>>
}

/**
 * Create the default N-phase driver.
 *
 *   - `specs` is the ordered, non-empty list of {@link PhaseSpec}. Order
 *     defines the sequence; ids must be unique.
 *   - Driver starts at index 0 (the first spec).
 *   - State is closed-over local variables — no globals, no module-scope.
 *     Re-invoking the factory yields an independent driver.
 */
export const createDefaultNPhaseDriver = (specs: ReadonlyArray<PhaseSpec>): NPhaseDriver => {
  if (specs.length === 0) {
    throw new NPhaseDriverConfigError("empty-specs", "specs[] must be non-empty")
  }

  // ── Build the id→idx index, detecting duplicates. ────────────────────────
  const idIndex = new Map<PhaseId, number>()
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i]
    if (spec === undefined) {
      // Unreachable per `specs: ReadonlyArray<PhaseSpec>` typing, but the
      // index guard satisfies noUncheckedIndexedAccess.
      continue
    }
    if (idIndex.has(spec.id)) {
      throw new NPhaseDriverConfigError("duplicate-id", `duplicate phase id: ${spec.id}`)
    }
    idIndex.set(spec.id, i)
  }

  // ── Mutable state. ───────────────────────────────────────────────────────
  let cursor = 0
  const ledger = new Map<PhaseId, LedgerEntry>()

  const specAt = (idx: number): PhaseSpec => {
    const s = specs[idx]
    if (s === undefined) {
      // Should be unreachable given the construction guarantees, but
      // noUncheckedIndexedAccess + total-functions discipline forces a guard.
      throw new TransitionError(
        "no-next-phase",
        `internal: spec index out of range: ${idx} (specs.length=${specs.length})`,
      )
    }
    return s
  }

  const current = (): PhaseSpec => specAt(cursor)

  const transition = (toPhaseId: PhaseId): PhaseTransition => {
    const targetIdx = idIndex.get(toPhaseId)
    if (targetIdx === undefined) {
      throw new TransitionError("unknown-phase", `target id not in spec list: ${toPhaseId}`)
    }

    if (targetIdx === cursor) {
      // Self-transition — no rollback, no forward — categorize as backward
      // (no progress) for consistency with "only feedback may stay put".
      throw new TransitionError(
        "backward-not-permitted",
        `self-transition rejected: cursor already at ${toPhaseId} (idx=${cursor})`,
      )
    }

    if (targetIdx < cursor) {
      throw new TransitionError(
        "backward-not-permitted",
        `manual backward transition rejected (use feedback({positive:false}) to roll back): ` +
          `${current().id}(idx=${cursor}) → ${toPhaseId}(idx=${targetIdx})`,
      )
    }

    const currentSpec = current()
    if (currentSpec.requiresFeedback && !ledger.has(currentSpec.id)) {
      throw new TransitionError(
        "feedback-required",
        `phase ${currentSpec.id} requires feedback before advancing`,
      )
    }

    const isAdjacent = targetIdx === cursor + 1
    if (!isAdjacent && !currentSpec.allowSkip) {
      throw new TransitionError(
        "skip-not-allowed",
        `non-adjacent target (${targetIdx} from ${cursor}) but phase ${currentSpec.id} ` +
          `does not allow skipping`,
      )
    }

    const direction: PhaseTransition["direction"] = isAdjacent ? "forward" : "skip"
    const fromId = currentSpec.id
    // Consume the source phase's ledger entry — re-entry requires fresh feedback.
    ledger.delete(fromId)
    cursor = targetIdx
    return { from: fromId, to: toPhaseId, direction }
  }

  const feedback = (result: FeedbackResult): PhaseTransition | null => {
    const targetIdx = idIndex.get(result.phase)
    if (targetIdx === undefined) {
      throw new FeedbackError("unknown-phase", `feedback against unknown phase id: ${result.phase}`)
    }
    const currentSpec = current()
    if (result.phase !== currentSpec.id) {
      throw new FeedbackError(
        "phase-mismatch",
        `feedback target (${result.phase}) does not match current phase (${currentSpec.id})`,
      )
    }

    if (result.positive) {
      // Freeze the entry's context — shallow copy so caller mutations after
      // submission don't leak into our ledger. HELL-NP-15 verifies exact
      // round-trip equality.
      const entry: LedgerEntry =
        result.context === undefined
          ? { positive: true }
          : { positive: true, context: Object.freeze({ ...result.context }) }
      ledger.set(result.phase, entry)
      return null
    }

    // positive === false → rollback (if possible).
    if (cursor === 0) {
      // No prior phase; caller decides whether to abort. Returning null keeps
      // the contract simple — no "rollback-impossible" error code.
      return null
    }
    const fromId = currentSpec.id
    cursor -= 1
    const toId = current().id
    // Clear BOTH endpoints of the rollback:
    //   - `toId` (the now-current phase) — a rollback into a requiresFeedback
    //     phase forces fresh feedback before advancing again.
    //   - `fromId` (the phase we rolled back FROM) — identical to the
    //     forward-transition consume semantics (line ~175): a phase you LEAVE
    //     must require fresh feedback on re-entry. Without this, a stale
    //     positive entry on `fromId` would silently satisfy the requiresFeedback
    //     gate when the cursor later advances back into it.
    ledger.delete(toId)
    ledger.delete(fromId)
    return { from: fromId, to: toId, direction: "rollback" }
  }

  return { current, transition, feedback }
}
