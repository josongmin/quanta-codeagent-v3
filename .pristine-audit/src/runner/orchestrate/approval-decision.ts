/**
 * WS-A (jul-10 uiux structural) — the SSOT normalizer for
 * {@link ApprovalDecisionResult}.
 *
 * `ApprovalDecisionResult` is a WIRE union: bare strings (`"approve"|"deny"`,
 * the legacy 2-verb form) plus rich objects carrying the operator's once/session
 * SCOPE and corrective STEER. Before this module the only normalization lived
 * INLINE in `session-turn-driver.ts`, so every other consumer re-interpreted
 * the union by hand — the precompact confirm compared `decision === "approve"`
 * strictly and misread `{decision:"approve", scope:"session"}` (the operator's
 * "[a]lways" answer) as a deferral (UUX-1-02).
 *
 * RULES (mirrors `@/agent/confirm-decision`):
 *   - This module is the ONLY reader of raw shapes. Consumers call
 *     {@link normalizeApprovalDecision} / {@link isApprovedDecision}; a bare
 *     `decision === "approve"` comparison elsewhere is banned by the grep-gate
 *     in `tests/unit/approval-decision-normalize.hellgate.test.ts`.
 *   - NO FALLBACK / NO SWALLOW: garbage (unknown literal, invalid scope) throws
 *     {@link ApprovalDecisionResultError} — a malformed decision is a wiring
 *     bug in the surface, not a policy outcome.
 *   - An empty-after-trim steer is dropped to a plain deny (an operator who
 *     typed nothing gave no steer — never thread a phantom `""` steer).
 *
 * PURE: no IO, no shared state.
 */

/** ADR-0512 P3 — the operator's decision. A bare `"approve"`/`"deny"` is the
 *  legacy 2-verb form (still accepted, byte-identical). A skill-scope escalation
 *  surface may instead return the RICH form so the once/session SCOPE and the
 *  corrective STEER reach the host: `{decision:"approve", scope:"once"}` ⇒
 *  allow_once (dispatch WITHOUT widening); `{decision:"deny", steer}` ⇒
 *  deny_and_steer (a recoverable decline carrying the steer). */
export type ApprovalDecisionResult =
  | "approve"
  | "deny"
  // #20 — `session_prefix` joins the approve scopes: the deferred surface (web
  // card / CLI fallback) can also mint the standing "always allow `<program> …`
  // this session" prefix grant (the controller derives a safe prefix key, see
  // `@/permission/session-grant-prefix`).
  | { readonly decision: "approve"; readonly scope?: "once" | "session" | "session_prefix" }
  | { readonly decision: "deny"; readonly steer?: string }

/** The canonical (always-object) projection of {@link ApprovalDecisionResult}. */
export interface NormalizedApprovalDecision {
  readonly decision: "approve" | "deny"
  readonly scope?: "once" | "session" | "session_prefix"
  readonly steer?: string
}

/** Named error for wiring-level invariant violations (unknown discriminant /
 *  invalid scope literal / non-string steer). Thrown, never swallowed into a
 *  silent deny — the surface learns its wiring is broken. */
export class ApprovalDecisionResultError extends Error {
  readonly field: string
  constructor(field: string, detail: string) {
    super(`ApprovalDecisionResultError: ${field} — ${detail}`)
    this.name = "ApprovalDecisionResultError"
    this.field = field
  }
}

const VALID_SCOPES: ReadonlyArray<string> = ["once", "session", "session_prefix"]

/** Approve arm — validate + preserve the optional scope. Extracted (mirrors
 *  `normalizeAllowScope` in `@/agent/confirm-decision`) to keep the normalizer
 *  under biome's cognitive-complexity cap. */
const normalizeApproveArm = (raw: object): NormalizedApprovalDecision => {
  const scope = (raw as { scope?: unknown }).scope
  if (scope !== undefined && !VALID_SCOPES.includes(scope as string)) {
    throw new ApprovalDecisionResultError(
      "scope",
      `approve scope must be "once" | "session" | "session_prefix" (got ${String(scope)})`,
    )
  }
  return scope === undefined
    ? { decision: "approve" }
    : { decision: "approve", scope: scope as "once" | "session" | "session_prefix" }
}

/** Deny arm — validate the optional steer. Empty-after-trim ⇒ plain deny: the
 *  operator gave no steer; a phantom "" steer must never reach the host lease
 *  (UUX-2-18's silent-empty-steer class). */
const normalizeDenyArm = (raw: object): NormalizedApprovalDecision => {
  const steer = (raw as { steer?: unknown }).steer
  if (steer !== undefined && typeof steer !== "string") {
    throw new ApprovalDecisionResultError(
      "steer",
      `deny steer must be a string when present (got ${typeof steer})`,
    )
  }
  if (typeof steer !== "string" || steer.trim().length === 0) return { decision: "deny" }
  return { decision: "deny", steer }
}

/** Normalize a raw {@link ApprovalDecisionResult} into its canonical object
 *  form. Bare strings map byte-identically (`"approve"` ⇒ `{decision:"approve"}`).
 *  Garbage throws {@link ApprovalDecisionResultError} — no silent coercion. */
export const normalizeApprovalDecision = (
  raw: ApprovalDecisionResult,
): NormalizedApprovalDecision => {
  if (raw === "approve") return { decision: "approve" }
  if (raw === "deny") return { decision: "deny" }
  if (raw === null || typeof raw !== "object" || !("decision" in raw)) {
    throw new ApprovalDecisionResultError(
      "decision",
      `expected "approve" | "deny" | rich object (got ${raw === null ? "null" : typeof raw})`,
    )
  }
  if (raw.decision === "approve") return normalizeApproveArm(raw)
  if (raw.decision === "deny") return normalizeDenyArm(raw)
  throw new ApprovalDecisionResultError(
    "decision",
    `unknown decision literal: ${String((raw as { decision: unknown }).decision)}`,
  )
}

/** The ONLY sanctioned boolean projection of a raw decision. Rich session-scoped
 *  approves are approves (the UUX-1-02 regression this module exists to kill). */
export const isApprovedDecision = (raw: ApprovalDecisionResult): boolean =>
  normalizeApprovalDecision(raw).decision === "approve"
