/**
 * ADR-0512 L3 — skill-scope ESCALATION decision.
 *
 * When skill-scope v2 is ON and the model calls a tool outside the active
 * skill's allowlist, this is NOT a flat error (the old `skill-scoped` deny).
 * It is a fork:
 *
 *   hand-off-required tier  → HARD DENY (security boundary, never escalatable).
 *   no onConfirm wired      → DENY (fail-closed: never silently admit out-of-scope).
 *   else                    → ASK the user via `onConfirm`, carrying `scopeContext`
 *                             so the surface renders an "outside skill scope" card.
 *                             allow → caller dispatches normally (the tool's OWN
 *                             permission gate STILL runs downstream, so HARD_DENY /
 *                             always-confirm are enforced a second time — this ask
 *                             only widens the SKILL scope, never the security policy).
 *
 * PURE: no IO beyond the injected `onConfirm`. The caller (stream-callbacks) owns
 * the actual `dispatchTool` re-entry on `{ kind: "dispatch" }` and the scope
 * widening — this module only renders the decision.
 */

import type { PermissionMode, ToolAction } from "@/permission"
import type { HITLTier } from "@/shared"
import type { EscalationOption, ToolRiskMirror } from "@/stream"
import { type ConfirmDecision, normalizeConfirm } from "./confirm-decision"

/** What the caller must do with an out-of-scope call. */
export type ScopeVerdict =
  | { kind: "hard_deny" } // hand-off-required — security boundary
  | { kind: "dispatch" } // approved — caller dispatches (downstream gate still applies)
  | { kind: "deny" } // user declined, or no onConfirm wired (fail-closed)
  | { kind: "deny_and_steer"; steer: string } // declined + corrective steer

/**
 * ADR-0512 P3 — the surface-agnostic payload for the `permission_escalation_requested`
 * stream event (the approval CARD). Fired EXACTLY when the path is about to ASK
 * the user (auto-run tier + an onConfirm is wired) — NEVER for the security
 * short-circuits (hand-off-required / no-onConfirm / bypass / always-confirm),
 * so a security-boundary tool can never reach a card. The caller (stream-callbacks)
 * maps this onto `config.stream.emit({ type: "permission_escalation_requested", … })`.
 */
export interface EscalationRequest {
  readonly id: string
  readonly tool: string
  readonly risk: ToolRiskMirror
  readonly activeSkill: string
  readonly reason: string
  readonly justification?: string
  readonly options: readonly EscalationOption[]
}

/** ADR-0512 P3 — the payload for `permission_escalation_resolved`, carrying the
 *  user's 4-verb decision. `id` pairs it with the matching {@link EscalationRequest}. */
export interface EscalationResolution {
  readonly id: string
  readonly decision: EscalationOption
}

/** The 4 verbs offered on every escalation card (stable order — drives both the
 *  card buttons and the e2e contract).
 *
 *  KNOWN LIMITATION (audit-flagged, not a silent cap): `allow_once` is PRESENTED
 *  but not yet distinctly RETURNABLE. The host touchpoint is `onConfirm`, whose
 *  `ConfirmDecision` only carries `allow` / `deny` / `deny_and_steer` — it has no
 *  once-vs-session bit. So an approval resolves to `allow_session` (widen) via
 *  {@link resolutionOf} regardless of which approve button the surface drew. True
 *  `allow_once` (dispatch this one call WITHOUT widening, re-ask next time) needs a
 *  `ConfirmDecision` extension carrying the scope choice — tracked as follow-up. A
 *  surface SHOULD therefore treat the two approve buttons as equivalent for now. */
export const ESCALATION_OPTIONS: readonly EscalationOption[] = [
  "allow_once",
  "allow_session",
  "deny",
  "deny_and_steer",
]

export interface ScopeEscalationCtx {
  readonly tool: string
  readonly input: unknown
  readonly isReadOnly: boolean
  /** Pre-resolved effective tier (caller resolves via `inferToolTier`). A
   *  `hand-off-required` tier short-circuits to `hard_deny` WITHOUT asking; an
   *  `always-confirm` tier defers to the tool's OWN gate (no double-prompt). */
  readonly tier: HITLTier
  /** Active permission mode. `bypass`/`acceptEdits` ⇒ the user lowered the gate,
   *  so a scope prompt is suppressed (auto-dispatch). */
  readonly mode: PermissionMode
  readonly activeSkill: string
  readonly scopeReason: string
  /** ADR-0512 P3 — the model's one-line rationale for reaching outside scope,
   *  shown on the approval card (Codex `on-request` justification). Optional. */
  readonly justification?: string
  /** Required but nullable: the caller passes `config.onConfirm` verbatim
   *  (which is `… | undefined`); `undefined` ⇒ fail-closed deny. */
  readonly onConfirm: ((a: ToolAction) => Promise<boolean | ConfirmDecision>) | undefined
  /** ADR-0512 P3 — fired EXACTLY when about to ASK the user (this is the only
   *  path that reaches `onConfirm`). NEVER fired on the security short-circuits
   *  (hand-off-required / no-onConfirm / bypass / always-confirm), so a
   *  security-boundary tool can never produce a card. Optional ⇒ absent surface
   *  is byte-identical. */
  readonly onEscalationRequested?: (req: EscalationRequest) => void
  /** ADR-0512 P3 — fired after the ask resolves, carrying the 4-verb decision. */
  readonly onEscalationResolved?: (res: EscalationResolution) => void
}

/** ADR-0512 P3 — read-only-vs-mutating is the distinction the approval card
 *  draws (ADR mock: "위험 ✎ mutating" / "read-only"). Derived from the same
 *  `isReadOnly` predicate the ask already carries, so the card's risk and the
 *  dispatch decision can never disagree. */
const riskOf = (isReadOnly: boolean): ToolRiskMirror => (isReadOnly ? "read-only" : "mutating")

/** ADR-0512 P3 — map a `ConfirmDecision` verb to the card's resolution verb.
 *  `allow` ⇒ `allow_session` (the approve path WIDENS the skill scope so the
 *  same tool is not re-asked — see `widenScope` in the caller). */
const resolutionOf = (decision: ConfirmDecision): EscalationOption =>
  decision.decision === "allow"
    ? "allow_session"
    : decision.decision === "deny"
      ? "deny"
      : "deny_and_steer"

/** Monotonic counter so paired request/resolution ids are unique within a
 *  process (the surface correlates the card with its resolution by this id). */
let escalationSeq = 0

export const decideScopeEscalation = async (ctx: ScopeEscalationCtx): Promise<ScopeVerdict> => {
  // Security boundary: a hand-off-required tool is NEVER escalatable — we do not
  // even ask. (Defense-in-depth: even if this check were skipped, dispatching an
  // approved hand-off-required tool is still hard-denied by its own gate.)
  if (ctx.tier === "hand-off-required") return { kind: "hard_deny" }
  // The user already lowered the gate (bypass / acceptEdits) — do NOT add a
  // scope prompt on top. (hand-off-required above is still denied even here.)
  if (ctx.mode === "bypass" || ctx.mode === "acceptEdits") return { kind: "dispatch" }
  // A tool that prompts on its OWN every use (`always-confirm`) is already a
  // single human touchpoint downstream — asking a SEPARATE scope question would
  // double-prompt. Defer: dispatch, and the tool's own gate asks (the user
  // approving the action implicitly admits it past the skill scope).
  if (ctx.tier === "always-confirm") return { kind: "dispatch" }
  // Remaining: a tool that would AUTO-RUN (`none` / `pre-approval-ok`) in an
  // ask-mode — this is the case where an out-of-scope tool would silently
  // execute, so this is exactly where we ask. Fail-closed with no asker.
  if (ctx.onConfirm === undefined) return { kind: "deny" }
  const action: ToolAction = {
    tool: ctx.tool,
    input: ctx.input,
    isReadOnly: ctx.isReadOnly,
    scopeContext: { activeSkill: ctx.activeSkill, reason: ctx.scopeReason },
  }
  // ADR-0512 P3 — we are NOW in the ONLY branch that asks the user. Emit the
  // `permission_escalation_requested` card payload IMMEDIATELY before the ask
  // (the security short-circuits above already returned, so a hand-off-required
  // / no-onConfirm / bypass / always-confirm call never reaches this card). A
  // stable id pairs the request with its resolution.
  const id = ctx.tool === "" ? "esc" : `esc-${ctx.tool}-${escalationSeq++}`
  ctx.onEscalationRequested?.({
    id,
    tool: ctx.tool,
    risk: riskOf(ctx.isReadOnly),
    activeSkill: ctx.activeSkill,
    reason: ctx.scopeReason,
    ...(ctx.justification !== undefined ? { justification: ctx.justification } : {}),
    options: ESCALATION_OPTIONS,
  })
  const decision = normalizeConfirm(await ctx.onConfirm(action))
  ctx.onEscalationResolved?.({ id, decision: resolutionOf(decision) })
  switch (decision.decision) {
    case "allow":
      return { kind: "dispatch" }
    case "deny":
      return { kind: "deny" }
    case "deny_and_steer":
      return { kind: "deny_and_steer", steer: decision.steer }
  }
}
