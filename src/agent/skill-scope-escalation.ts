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

import type { ToolAction } from "@/permission"
import type { HITLTier } from "@/shared"
import { type ConfirmDecision, normalizeConfirm } from "./confirm-decision"

/** What the caller must do with an out-of-scope call. */
export type ScopeVerdict =
  | { kind: "hard_deny" } // hand-off-required — security boundary
  | { kind: "dispatch" } // approved — caller dispatches (downstream gate still applies)
  | { kind: "deny" } // user declined, or no onConfirm wired (fail-closed)
  | { kind: "deny_and_steer"; steer: string } // declined + corrective steer

export interface ScopeEscalationCtx {
  readonly tool: string
  readonly input: unknown
  readonly isReadOnly: boolean
  /** Pre-resolved effective tier (caller resolves via `inferToolTier`). A
   *  `hand-off-required` tier short-circuits to `hard_deny` WITHOUT asking. */
  readonly tier: HITLTier
  readonly activeSkill: string
  readonly scopeReason: string
  /** Required but nullable: the caller passes `config.onConfirm` verbatim
   *  (which is `… | undefined`); `undefined` ⇒ fail-closed deny. */
  readonly onConfirm: ((a: ToolAction) => Promise<boolean | ConfirmDecision>) | undefined
}

export const decideScopeEscalation = async (ctx: ScopeEscalationCtx): Promise<ScopeVerdict> => {
  // Security boundary: a hand-off-required tool is NEVER escalatable — we do not
  // even ask. (Defense-in-depth: even if this check were skipped, dispatching an
  // approved hand-off-required tool is still hard-denied by its own gate.)
  if (ctx.tier === "hand-off-required") return { kind: "hard_deny" }
  // Fail-closed: with no human to ask, an out-of-scope tool stays denied — never
  // silently admitted.
  if (ctx.onConfirm === undefined) return { kind: "deny" }
  const action: ToolAction = {
    tool: ctx.tool,
    input: ctx.input,
    isReadOnly: ctx.isReadOnly,
    scopeContext: { activeSkill: ctx.activeSkill, reason: ctx.scopeReason },
  }
  const decision = normalizeConfirm(await ctx.onConfirm(action))
  switch (decision.decision) {
    case "allow":
      return { kind: "dispatch" }
    case "deny":
      return { kind: "deny" }
    case "deny_and_steer":
      return { kind: "deny_and_steer", steer: decision.steer }
  }
}
