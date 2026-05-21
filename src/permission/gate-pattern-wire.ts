/**
 * Pattern-grant auto-pass predicate (ADR-0061 wire-up).
 *
 * Pure module — the admissibility-gate calls into this to decide whether a
 * pending action's `rememberPatterns` are ALREADY fully covered by the
 * session's {@link PatternGrantStore}, and therefore can be auto-passed with
 * a synthetic `config_allowed` decision WITHOUT invoking the reviewer port.
 *
 * Why a dedicated module: keeps `admissibility-gate.ts` minimal (one small
 * call site + a synthesized decision) and centralizes the hardening rules so
 * a single audit point owns:
 *
 *   1. ZERO-pattern guard — `rememberPatterns.length === 0` ⇒ NEVER auto-pass.
 *      A request without remembered patterns must be explicitly granted; this
 *      mirrors v0.dev's `length>0` guard inside `autoResolvable`.
 *   2. Dangerous gate — `isMaybeDangerous === true` ⇒ NEVER auto-pass unless
 *      the caller opts in via `allowDangerous: true`. Hardening over v0,
 *      which had no dangerous gate on the cascade.
 *   3. Coverage — every pattern in `rememberPatterns` MUST be granted in
 *      `store`; partial coverage falls through.
 *
 * Slice rules: lives in `@/permission`. Imports only `./remember-patterns`
 * (for `PatternGrantStore`) and `./outcome` (for `buildDecision`). NEVER
 * reaches into `@/agent` or `@/llm`.
 */

import { buildDecision } from "./outcome"
import type { PatternGrantStore } from "./remember-patterns"
import type { ApprovalDecision } from "./types"

/** Inputs to {@link autoPassByPatterns}. All optional fields are read with
 *  defensive guards so callers can pass through whatever the action surface
 *  has (the model-facing schema is still pending — see ADR-0061 §TODO). */
export interface AutoPassInput {
  /** Patterns the action declares it would be satisfied by. Absent / empty
   *  ⇒ never auto-pass (per rule 1). */
  readonly rememberPatterns?: readonly string[] | undefined
  /** Model self-flag. `true` blocks auto-pass unless `allowDangerous` is set
   *  (per rule 2). Absent ⇒ treated as `false`. */
  readonly isMaybeDangerous?: boolean | undefined
}

/** Optional knobs from the caller (gate). */
export interface AutoPassOptions {
  /** Operator-set override allowing dangerous auto-pass. Default `false`. */
  readonly allowDangerous?: boolean | undefined
  /** Injected clock for deterministic decision timestamps (pure logic never
   *  reads the wall clock). Default `() => Date.now()` — set explicitly in
   *  tests / trajectory replay. */
  readonly decidedAt?: () => number
}

/** Result discriminant. `kind: "auto_pass"` ⇒ caller short-circuits with the
 *  embedded `ApprovalDecision`. `kind: "fall_through"` ⇒ caller continues to
 *  the legacy reviewer path. */
export type AutoPassResult =
  | { readonly kind: "auto_pass"; readonly decision: ApprovalDecision }
  | { readonly kind: "fall_through"; readonly reason: FallThroughReason }

/** Reason-code surface for fall-through paths. Stable strings so observability
 *  / tests can pin the exact branch the gate took without parsing rationale. */
export type FallThroughReason =
  | "no_store"
  | "no_patterns"
  | "empty_patterns"
  | "dangerous_blocked"
  | "uncovered"

/** Pure predicate: should the gate short-circuit this action with a synthetic
 *  `config_allowed` decision, or fall through to the reviewer?
 *
 *  Returns a discriminated union (never throws) so the gate can route on the
 *  `kind` field without try/catch. The synthesized decision uses
 *  `reviewer: "auto_review"` + `outcome: "config_allowed"` (the only
 *  reviewer/outcome pair the invariant matrix admits for a policy-driven
 *  auto-allow that did not require human / guardian review).
 *
 *  Hardening (matches `remember-patterns.ts`):
 *    - `store === undefined`            ⇒ fall_through "no_store"
 *    - `rememberPatterns === undefined` ⇒ fall_through "no_patterns"
 *    - `rememberPatterns.length === 0`  ⇒ fall_through "empty_patterns"
 *    - `isMaybeDangerous && !allow`     ⇒ fall_through "dangerous_blocked"
 *    - `!store.isCovered(patterns)`     ⇒ fall_through "uncovered"
 *    - otherwise                        ⇒ auto_pass with synthesized decision
 */
export const autoPassByPatterns = (
  store: PatternGrantStore | undefined,
  action: AutoPassInput,
  opts: AutoPassOptions = {},
): AutoPassResult => {
  if (store === undefined) return { kind: "fall_through", reason: "no_store" }
  const patterns = action.rememberPatterns
  if (patterns === undefined) return { kind: "fall_through", reason: "no_patterns" }
  if (patterns.length === 0) return { kind: "fall_through", reason: "empty_patterns" }
  const dangerous = action.isMaybeDangerous === true
  const allowDangerous = opts.allowDangerous === true
  if (dangerous && !allowDangerous) {
    return { kind: "fall_through", reason: "dangerous_blocked" }
  }
  if (!store.isCovered(patterns)) {
    return { kind: "fall_through", reason: "uncovered" }
  }
  const clock = opts.decidedAt ?? Date.now
  const decision = buildDecision({
    reviewer: "auto_review",
    outcome: "config_allowed",
    riskLevel: dangerous ? "high" : "low",
    rationale: "pattern-covered auto-pass",
    decidedAt: clock(),
  })
  return { kind: "auto_pass", decision }
}

/** Cascade helper: grant a non-empty batch of patterns into `store` AND
 *  return the toolCallIds of any pending requests now satisfied by the new
 *  set. Empty `patterns` is a no-op (no grant, no cascade). Idempotent —
 *  calling repeatedly with the same patterns is safe.
 *
 *  The `pending` queue is OPTIONAL because the LLM-facing pending-permission
 *  surface is still TODO (ADR-0061); a caller that only wants the grant side-
 *  effect can omit it.
 *
 *  TODO(absorb #2): wire this into a real dispatch cascade once the model
 *  surface exposes pending permissions — the returned ids are currently a
 *  pure value for the caller to act on (e.g. re-evaluate queued tool calls).
 */
export const grantAndCascade = (
  store: PatternGrantStore,
  patterns: readonly string[],
  opts: {
    pending?: ReadonlyArray<import("./remember-patterns").PendingPermission>
    justResolvedId?: string
    alreadyResolved?: ReadonlySet<string>
    allowDangerous?: boolean
  } = {},
): readonly string[] => {
  if (patterns.length === 0) return []
  store.grant(patterns)
  const pending = opts.pending
  if (pending === undefined || pending.length === 0) return []
  const justResolvedId = opts.justResolvedId ?? ""
  const cascadeOpts: { alreadyResolved?: ReadonlySet<string>; allowDangerous?: boolean } = {}
  if (opts.alreadyResolved !== undefined) cascadeOpts.alreadyResolved = opts.alreadyResolved
  if (opts.allowDangerous !== undefined) cascadeOpts.allowDangerous = opts.allowDangerous
  return store.cascade(pending, justResolvedId, cascadeOpts)
}
