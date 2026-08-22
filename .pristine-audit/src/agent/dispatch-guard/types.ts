/**
 * Dispatch-guard typed shapes (ADR-0229).
 *
 * Plane-clean leaf — depends only on `@/shared` (currently not even that, since
 * the union is parameter-free). Adding an arm to {@link GuardDecision} forces
 * a compile error at every consumer switch (closed union).
 *
 *   "allow"  — admit (most-permissive). No detector flagged.
 *   "deny"   — terminal. `hardDeny` indicates the deny crossed a security
 *               boundary (git-write-escape or off-allowlist host) and MUST
 *               NOT be retried. A non-hard deny is still terminal at the
 *               dispatch seam, but downstream consumers may treat it as a
 *               recoverable failure (e.g. surface to the model).
 *   "ask"    — needs HITL escalation. Today the wire collapses this to a
 *               terminal deny with preview tag `"guard-ask"` so a future
 *               HITL re-routing can recognise the tag without surface
 *               changes. The composer never converts `ask` to `allow`.
 */
export type GuardDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string; readonly hardDeny: boolean }
  | { readonly kind: "ask"; readonly reason: string }

/** Canonical literal tuple — runtime guard the union does not silently drift
 *  from consumer switches. Tested by HELL-DG (exhaustive shape probe). */
export const ALL_GUARD_DECISION_KINDS = ["allow", "deny", "ask"] as const satisfies ReadonlyArray<
  GuardDecision["kind"]
>
