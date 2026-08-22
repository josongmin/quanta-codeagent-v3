/**
 * PDP — Policy Decision Point (jun-10, ticket P2-T3 first decider).
 *
 * The audit (`docs/audits/jun-10-permission-architecture-audit.md`) called for
 * separating the permission DECISION (pure, surface-agnostic, the SSOT) from its
 * ENFORCEMENT (the single dispatch chokepoint). This is the first pure decider:
 * the SECURITY FLOOR — does a tool's `always-confirm` requirement apply
 * UNIVERSALLY (on every surface, regardless of the `hitl.enabled` opt-in)?
 *
 * It exists to un-block ticket P2-T1 (always-confirm secure-by-default). The
 * blocker was that `inferToolTier` collapses TWO different reasons a tool is
 * `always-confirm` into one tier:
 *   - INHERENTLY SENSITIVE (git push, deploy) — should confirm on EVERY surface.
 *   - NEEDS-SANDBOX (bash without a sandbox profile self-reports always-confirm
 *     for ALL commands) — should defer to the sandbox / mode layer, NOT a blanket
 *     confirm; otherwise every shell call on a profile-less surface gets gated
 *     (the ~89-test breakage we measured).
 *
 * The capability spec splits them as DATA, and this decider reads that data. A
 * tool opts INTO the universal floor by declaring `capability.confirm:
 * "sensitive"`. Anything else (needs-sandbox, unspecified, the `inferToolTier`
 * catch-all) DEFERS — byte-identical to today's mode-policy / opt-in behavior.
 *
 * jul-10 (D-1 follow-through): the split is now ALSO a first-class output of
 * tier resolution — `inferToolTierDetailed` returns `{ tier, reason }` (see
 * `HITLTierReason` in `@/shared`), and the gate's `hitl.enabled` branch uses it
 * so a `needs-sandbox`-reason always-confirm tool defers to mode policy under
 * an explicit `bypass` release (mode policy still HARD_DENYs first). This
 * decider's own vocabulary is unchanged: it answers ONLY the universal-floor
 * question.
 */
import type { HITLTier, ToolCapability } from "@/shared"

export type { ToolCapability }

/** The floor decider's verdict. `"universal-floor"` ⇒ enforce the tier on every
 *  surface regardless of opt-in; `"defer"` ⇒ leave it to mode policy / the
 *  `hitl.enabled` opt-in (current behavior). */
export type FloorVerdict = "universal-floor" | "defer"

/**
 * Pure SECURITY-FLOOR decider. NO IO, NO surface knowledge — the SSOT for
 * "should this tier be enforced universally?". hand-off-required is handled by
 * its own (harder) upstream floor; this decider answers ONLY the always-confirm
 * question, and only promotes a tool that declares itself inherently sensitive.
 */
export const decideFloor = (input: {
  readonly tier: HITLTier
  readonly capability: ToolCapability | undefined
}): FloorVerdict =>
  input.tier === "always-confirm" && input.capability?.confirm === "sensitive"
    ? "universal-floor"
    : "defer"
