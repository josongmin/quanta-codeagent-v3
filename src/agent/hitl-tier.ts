/**
 * ADR-0047 — HITL 4-tier gate (registry + handoff seam).
 *
 * This module is the canonical agent-side surface for the 4-tier taxonomy
 * defined by ADR-0020. It is a thin re-export of `HITLTier` (re-exported here
 * via `@/permission`, whose own copy now re-exports the SSOT in `@/shared`),
 * plus the local aliases and seam types the registry / admissibility-gate /
 * handoff callback need.
 *
 * Why re-export instead of redefining: the literal union
 * (`hand-off-required | always-confirm | pre-approval-ok | none`) lives ONCE
 * in `@/shared/types.ts` and every slice re-exports it. ADR-0047 EXTENDS the
 * agent surface (adds annotation registry, override file, handoff event); it
 * does NOT supersede the tier enum. The single canonical type prevents drift
 * between `@/permission`'s gate logic and `@/agent`'s registry layer.
 *
 * Naming: this file standardises on the lower-camel `HitlTier` alias so
 * agent-internal code reads consistently (`tier: HitlTier`). The original
 * `HITLTier` name from `@/permission` remains exported verbatim for callers
 * that match the legacy spelling — both names refer to the SAME type.
 *
 * See also: ADR-0020 (original 4-tier gate), ADR-0026 (admissibility-gate
 * SSOT), ADR-0029 (3-tier reviewer — orthogonal axis), ADR-0046 (permission
 * stack — different scope, owned by a sibling track).
 */

import type { HITLTier } from "@/permission"

/** Lower-camel alias for the HITL 4-tier taxonomy. Same literal union as the
 *  `HITLTier` SSOT in `@/permission`; this spelling reads better in
 *  agent-internal code (`tier: HitlTier`). */
export type HitlTier = HITLTier

/** Re-export the original spelling so callers that match the ADR-0020 name
 *  (`HITLTier`) keep compiling without churn. */
export type { HITLTier } from "@/permission"

/**
 * Typed seam emitted by the admissibility-gate when an action is rejected
 * because it resolves to the `hand-off-required` tier. ADR-0047 R5 §한계:
 * the gate's tier resolution and the deny message it produces have until
 * now been a private signal between the gate and the model — UI surfaces
 * couldn't subscribe without parsing strings.
 *
 * `HandoffRequiredEvent` makes the signal a first-class structured value:
 * the gate constructs one whenever it emits a hand-off deny, and forwards
 * it via `AgentConfig.onHandoff?(event)`. The callback path is opt-in
 * (absent ⇒ no event, byte-identical legacy behaviour), so existing apps
 * are unaffected.
 *
 * Field contracts:
 *  - `kind`           — literal discriminator, always `"hitl-handoff"`.
 *  - `tool`           — the tool name the model attempted to invoke.
 *  - `args`           — the tool input as the model produced it (opaque).
 *  - `handoffMessage` — the user-facing message the gate also returns to
 *                       the model (kept identical so the operator and the
 *                       model see the SAME explanation).
 *  - `reason`         — short kebab-case tag identifying the trigger
 *                       (e.g. `"hard-deny:<rule-name>"` or `"tier:hand-off-required"`).
 *  - `timestamp`      — caller-provided ms-since-epoch. The gate reads
 *                       `Date.now()` exactly once per emit. Pure logic
 *                       (tests, replay) supplies a deterministic value via
 *                       the optional clock seam on the callback site.
 *
 * All fields are required + readonly so the value is safe to log,
 * serialize for trajectory replay, and compare structurally.
 */
export interface HandoffRequiredEvent {
  readonly kind: "hitl-handoff"
  readonly tool: string
  readonly args: unknown
  readonly handoffMessage: string
  readonly reason: string
  readonly timestamp: number
}

/** Type predicate — does `v` shape-match a `HandoffRequiredEvent`? Useful
 *  for stream/trajectory consumers that receive heterogeneous events from
 *  the agent loop and need to dispatch on `kind`. */
export const isHandoffRequiredEvent = (v: unknown): v is HandoffRequiredEvent => {
  if (v === null || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    o.kind === "hitl-handoff" &&
    typeof o.tool === "string" &&
    typeof o.handoffMessage === "string" &&
    typeof o.reason === "string" &&
    typeof o.timestamp === "number"
  )
}
