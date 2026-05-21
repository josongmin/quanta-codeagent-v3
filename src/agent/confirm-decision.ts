/**
 * Structured confirm-decision verb (ADR-0076 Gap-4 — `deny_and_steer`).
 *
 * Cursor's REJECT_AND_TELL gap: a surface can reject an action AND, atomically,
 * tell the agent what to do differently. Our legacy `onConfirm` returns a bare
 * boolean — it can only say allow (`true`) / deny (`false`); there is no seam
 * to attach a corrective steer to a denial.
 *
 * This module introduces the {@link ConfirmDecision} discriminated union and a
 * `normalizeConfirm` adapter so the legacy boolean stays BYTE-IDENTICAL:
 *   - `true`  → `{ decision: "allow" }`
 *   - `false` → `{ decision: "deny" }`
 * while a new surface MAY return `{ decision: "deny_and_steer", steer }` to
 * deny the call AND carry a non-empty corrective instruction the loop injects
 * as the next-turn user message.
 *
 * PURE: this module performs no IO and reaches into no shared state. It only
 * defines the type, validates it, and maps it. The admissibility-gate consumes
 * `normalizeConfirm` + `buildDenySteerMessage`; the loop consumes the
 * `DispatchResult.steerInjection` the gate surfaces (wiring is the loop's job —
 * see the ADR-0076 hand-off note in `admissibility-gate.ts`).
 *
 * NO FALLBACK / NO SWALLOW: an invalid decision (unknown discriminant, empty
 * `steer` on a `deny_and_steer`) THROWS {@link ConfirmDecisionError} rather
 * than silently degrading to `deny` — a malformed decision is a programming
 * bug in the surface's wiring, not a user-facing policy outcome.
 */

/**
 * Structured outcome a surface may return from `AgentConfig.onConfirm`. Three
 * arms; the `decision` literal is the discriminant.
 *
 *  - `allow` — admit the action (legacy boolean `true`).
 *  - `deny` — refuse the action (legacy boolean `false`).
 *  - `deny_and_steer` — refuse the action AND carry a non-empty `steer`
 *    instruction the loop injects as the next-turn user message (Cursor
 *    REJECT_AND_TELL). The `steer` MUST be a non-empty (post-trim) string;
 *    an empty steer is a wiring bug and throws {@link ConfirmDecisionError}.
 */
export type ConfirmDecision =
  | { decision: "allow" }
  | { decision: "deny" }
  | { decision: "deny_and_steer"; steer: string }

/** All decision literals enumerated — runtime exhaustiveness without `as
 *  const` drift (mirrors the project's ALL_* convention). */
export const ALL_CONFIRM_DECISIONS: ReadonlyArray<ConfirmDecision["decision"]> = [
  "allow",
  "deny",
  "deny_and_steer",
]

/**
 * Named error for programming-level invariant violations of a
 * {@link ConfirmDecision}: an unknown discriminant or an empty `steer` on a
 * `deny_and_steer`. Thrown — never swallowed into a silent `deny` — so the
 * surface learns its wiring is broken (project rule: no fallback, no sentinel).
 */
export class ConfirmDecisionError extends Error {
  readonly field: string
  constructor(field: string, detail: string) {
    super(`ConfirmDecisionError: ${field} — ${detail}`)
    this.name = "ConfirmDecisionError"
    this.field = field
  }
}

/**
 * Normalize the raw `onConfirm` return value into a {@link ConfirmDecision}.
 *
 * BYTE-IDENTICAL legacy mapping for the boolean form (every existing caller
 * returns a boolean):
 *   - `true`  → `{ decision: "allow" }`
 *   - `false` → `{ decision: "deny" }`
 *
 * A ConfirmDecision is validated structurally:
 *   - unknown `decision` literal ⇒ {@link ConfirmDecisionError};
 *   - `deny_and_steer` with a missing / non-string / empty-after-trim `steer`
 *     ⇒ {@link ConfirmDecisionError}.
 *
 * Any other shape (null/undefined/number/…) is a wiring bug ⇒
 * {@link ConfirmDecisionError}. There is no silent coercion.
 */
export const normalizeConfirm = (r: boolean | ConfirmDecision): ConfirmDecision => {
  if (typeof r === "boolean") {
    return r ? { decision: "allow" } : { decision: "deny" }
  }
  if (r === null || typeof r !== "object" || !("decision" in r)) {
    throw new ConfirmDecisionError(
      "decision",
      `onConfirm must return a boolean or a ConfirmDecision (got ${r === null ? "null" : typeof r})`,
    )
  }
  switch (r.decision) {
    case "allow":
    case "deny":
      return { decision: r.decision }
    case "deny_and_steer": {
      const steer = (r as { decision: "deny_and_steer"; steer: unknown }).steer
      if (typeof steer !== "string") {
        throw new ConfirmDecisionError(
          "steer",
          `deny_and_steer requires a string steer (got ${typeof steer})`,
        )
      }
      if (steer.trim().length === 0) {
        throw new ConfirmDecisionError("steer", "deny_and_steer requires a non-empty steer")
      }
      return { decision: "deny_and_steer", steer }
    }
    default: {
      throw new ConfirmDecisionError(
        "decision",
        `unknown decision literal: ${String((r as { decision: unknown }).decision)}`,
      )
    }
  }
}

/** True iff the (already-normalized) decision admits the action. Only `allow`
 *  is truthy; both `deny` and `deny_and_steer` are refusals. */
export const isAllowed = (d: ConfirmDecision): boolean => d.decision === "allow"

/**
 * Extract the corrective steer text from a `deny_and_steer` decision. Returns
 * `null` for `allow` / `deny` (no steer to inject). Throws
 * {@link ConfirmDecisionError} if invoked with a malformed `deny_and_steer`
 * (empty steer) — the invariant is also enforced by {@link normalizeConfirm},
 * so a normalized value never trips this; the guard makes the function safe to
 * call on a raw, un-normalized union too.
 */
export const buildDenySteerMessage = (d: ConfirmDecision): string | null => {
  if (d.decision !== "deny_and_steer") return null
  if (typeof d.steer !== "string" || d.steer.trim().length === 0) {
    throw new ConfirmDecisionError("steer", "deny_and_steer requires a non-empty steer")
  }
  return d.steer
}
