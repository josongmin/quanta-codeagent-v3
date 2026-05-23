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
/** Type predicate — does `v` shape-match a `HandoffRequiredEvent`? Useful
 *  for stream/trajectory consumers that receive heterogeneous events from
 *  the agent loop and need to dispatch on `kind`. */
export const isHandoffRequiredEvent = (v) => {
    if (v === null || typeof v !== "object")
        return false;
    const o = v;
    return (o["kind"] === "hitl-handoff" &&
        typeof o["tool"] === "string" &&
        typeof o["handoffMessage"] === "string" &&
        typeof o["reason"] === "string" &&
        typeof o["timestamp"] === "number");
};
