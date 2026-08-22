/**
 * RFC jun-6 — the sandbox-block → escalation-retry orchestrator.
 *
 * This is the seam the bash tool's result-handling calls when a sandboxed
 * command returns a `denialReason:"sandbox-blocked"` AND the escalation knob is
 * on. It connects the OS-sandbox block discriminant into the EXISTING
 * `post-denial.ts` 3-step re-approval machine (ADR-0046) and re-runs the
 * BYTE-SAME argv WITHOUT the sandbox wrapper THROUGH the normal permission gate.
 *
 * Every collaborator is INJECTED (closed-port DI) so the whole loop is pure +
 * hellgate-testable in isolation, without touching the bash hot-path:
 *
 *   - `store`       : the SAME `PermissionStore` the admissibility-gate consults
 *                     (post-denial records are per-(threadId, actionSignature)).
 *   - `clock`       : injected monotonic clock (no `Date.now()`).
 *   - `cap`         : the per-turn escalation cap (`ExecPolicyAmendmentExhausted`).
 *   - `presentRisk` : the UI/HITL surface that shows the user the concrete risk
 *                     of running unsandboxed (fires `recordRiskSeen` only when
 *                     the surface actually renders).
 *   - `gate`        : the NORMAL permission gate — the escalation is a request
 *                     like any other; it may itself be denied / handed off.
 *   - `rerunUnsandboxed` : re-runs the byte-same argv with the per-call sandbox
 *                          FORCED OFF (one call, NOT a session-wide flip).
 *   - `audit`       : audit-only sink for the free-form justification (per the
 *                     recorder discipline, the justification NEVER hits the
 *                     telemetry funnel — only the hashed signature + decision do,
 *                     which `recordDenial`/`recordRiskSeen`/`recordUserOverride`
 *                     emit themselves).
 *
 * SECURITY INVARIANT (the whole point): escalation NEVER auto-grants. The
 * `recordRiskSeen`-BEFORE-`recordUserOverride` ordering (enforced by the store
 * via timestamps, ADR-0046) is exactly what blocks a fabricated override.
 * Absent a complete, ordered, user-driven 3-step sequence,
 * `hasPostDenialOverride` is false and the command STAYS sandboxed/blocked.
 */

import {
  hasPostDenialOverride,
  type PermissionStore,
  type PostDenialAction,
  type PostDenialClock,
  recordDenial,
  recordRiskSeen,
  recordUserOverride,
} from "@/permission"
import type { SandboxDenial } from "@/runtime/os-sandbox"
import type { EscalationCapKey, SandboxEscalationCap } from "./cap"

/** Outcome of the user-facing risk presentation. The surface MUST show the
 *  concrete risk (running unsandboxed grants FS/network outside the workspace)
 *  + the model's justification, then return whether the user APPROVED. */
export interface RiskPresentation {
  /** Did the user, AFTER seeing the risk, approve the unsandboxed re-run? */
  readonly approved: boolean
}

/** The result of the gate consult on the unsandboxed re-run request. The
 *  escalation does NOT bypass the gate — the gate may classify it
 *  `hand-off-required` (last-line boundary, cannot be downgraded). */
export interface GateDecision {
  /** `true` only when the gate cleared the unsandboxed re-run. */
  readonly allow: boolean
  /** Optional coarse reason (for the model-facing result + audit). */
  readonly reason?: string
}

/** The byte-same argv re-run with the sandbox FORCED OFF for this one call. */
export interface UnsandboxedRerunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** The closed set of injected collaborators. */
export interface SandboxEscalationDeps {
  readonly store: PermissionStore
  readonly clock: PostDenialClock
  readonly cap: SandboxEscalationCap
  /** Show the user the concrete risk + justification; resolve to approval. */
  readonly presentRisk: (ctx: EscalationRiskContext) => Promise<RiskPresentation>
  /** Route the unsandboxed re-run request through the NORMAL permission gate.
   *  Called ONLY after a complete post-denial override exists — the gate is the
   *  final boundary, never bypassed. */
  readonly gate: (action: PostDenialAction) => Promise<GateDecision>
  /** Re-run the byte-same argv WITHOUT the sandbox wrapper (one call). */
  readonly rerunUnsandboxed: () => Promise<UnsandboxedRerunResult>
  /** Audit-only sink for the free-form justification (NEVER telemetry). */
  readonly audit?: (entry: EscalationAuditEntry) => void
}

/** Context handed to `presentRisk` (model-facing + human-facing). */
export interface EscalationRiskContext {
  readonly action: PostDenialAction
  readonly denial: SandboxDenial
  readonly justification: string
}

/** Audit record (justification may quote the offending command — audit log
 *  only, NEVER the metric funnel). */
export interface EscalationAuditEntry {
  readonly threadId: string
  readonly turnId: string
  readonly signal: SandboxDenial["signal"]
  readonly confidence: SandboxDenial["confidence"]
  readonly justification: string
  readonly decision: "approved" | "denied" | "gate-denied" | "exhausted"
}

/** The model's escalation request (mirrors Codex `with_escalated_permissions`
 *  + `justification`). */
export interface EscalationRequest {
  readonly action: PostDenialAction
  readonly turnId: string
  readonly denial: SandboxDenial
  /** Why the model needs to run this unsandboxed (input to the HUMAN decision,
   *  NEVER a grant). */
  readonly justification: string
}

/** Closed outcome union for an escalation attempt. */
export type SandboxEscalationOutcome =
  | { readonly kind: "exhausted"; readonly count: number; readonly max: number }
  | { readonly kind: "user-denied" }
  | { readonly kind: "gate-denied"; readonly reason?: string }
  | { readonly kind: "approved"; readonly result: UnsandboxedRerunResult }

/**
 * Seed the post-denial machine when a sandbox BLOCK first reaches the tool's
 * result handling. This is step (1) of RFC §4.3 — record the block as a denial
 * for THIS exact `(threadId, actionSignature)`, so the 3-step re-approval
 * sequence is keyed correctly. Idempotent re-denial resets a stale sequence
 * (a fresh block is a new event).
 *
 * Returns the structured field the tool surfaces to the model ("this was a
 * SANDBOX block, not a generic fail — re-request with escalate:true").
 */
export const seedSandboxBlockDenial = (
  action: PostDenialAction,
  denial: SandboxDenial,
  deps: Pick<SandboxEscalationDeps, "store" | "clock">,
): {
  readonly blockedBySandbox: true
  readonly signal: SandboxDenial["signal"]
  readonly confidence: SandboxDenial["confidence"]
} => {
  recordDenial(action, `sandbox-blocked: ${denial.signal}`, {
    store: deps.store,
    clock: deps.clock,
  })
  return { blockedBySandbox: true, signal: denial.signal, confidence: denial.confidence }
}

/**
 * Run one escalation attempt (steps 3-4 of RFC §4.3).
 *
 * Pre: `seedSandboxBlockDenial` has already recorded the block as a denial for
 * this action (the tool calls it on the block).
 *
 * Flow:
 *   1. Cap admission FIRST — past `QUANTA_SANDBOX_ESCALATION_MAX` ⇒ `exhausted`,
 *      NO prompt fired.
 *   2. `presentRisk` shows the user the concrete risk + justification. ONLY when
 *      the surface renders do we fire `recordRiskSeen` (the BEFORE-override
 *      step). User declines ⇒ `user-denied`, NO override recorded, command
 *      stays blocked.
 *   3. On user approval ⇒ `recordUserOverride`. Now `hasPostDenialOverride` is
 *      true for this exact `(threadId, actionSignature)` (and ONLY because the
 *      ordered 3-step sequence completed — a fabricated override is impossible).
 *   4. Route the unsandboxed re-run through the NORMAL gate. The gate may deny /
 *      hand off — escalation does NOT bypass it. Gate denies ⇒ `gate-denied`,
 *      NO re-run.
 *   5. Gate allows ⇒ re-run the byte-same argv WITHOUT the sandbox wrapper.
 */
export const runSandboxEscalation = async (
  req: EscalationRequest,
  deps: SandboxEscalationDeps,
): Promise<SandboxEscalationOutcome> => {
  const capKey: EscalationCapKey = { threadId: req.action.threadId, turnId: req.turnId }

  // (1) Cap admission BEFORE any prompt — anti-spam.
  const admission = deps.cap.admit(capKey)
  if (!admission.admitted) {
    audit(deps, req, "exhausted")
    return { kind: "exhausted", count: admission.count, max: admission.max }
  }

  // (2) Present the concrete risk. recordRiskSeen fires ONLY when the surface
  // renders (the BEFORE-override ordering step). A surface that never renders
  // never seeds the override — fail-closed.
  recordRiskSeen(req.action, { store: deps.store, clock: deps.clock })
  const presentation = await deps.presentRisk({
    action: req.action,
    denial: req.denial,
    justification: req.justification,
  })
  if (!presentation.approved) {
    audit(deps, req, "denied")
    return { kind: "user-denied" }
  }

  // (3) User approved AFTER seeing the risk ⇒ record the override. The store
  // enforces deniedAt ≤ seenRiskAt ≤ userOverrideAt; only now does
  // hasPostDenialOverride return true.
  recordUserOverride(req.action, { store: deps.store, clock: deps.clock })

  // Defensive assertion of the NEVER-auto invariant: if the ordered sequence
  // did NOT complete (e.g. a fabricated/out-of-order attempt), the override is
  // false and we refuse to re-run. This can only be false if the store rejected
  // the ordering — fail-closed.
  if (!hasPostDenialOverride(req.action, { store: deps.store })) {
    audit(deps, req, "denied")
    return { kind: "user-denied" }
  }

  // (4) Route the unsandboxed re-run through the NORMAL permission gate. The
  // escalation is a request like any other — it may be denied / handed off.
  const decision = await deps.gate(req.action)
  if (!decision.allow) {
    audit(deps, req, "gate-denied")
    return decision.reason !== undefined
      ? { kind: "gate-denied", reason: decision.reason }
      : { kind: "gate-denied" }
  }

  // (5) Gate cleared ⇒ re-run the byte-same argv WITHOUT the sandbox wrapper.
  const result = await deps.rerunUnsandboxed()
  audit(deps, req, "approved")
  return { kind: "approved", result }
}

const audit = (
  deps: SandboxEscalationDeps,
  req: EscalationRequest,
  decision: EscalationAuditEntry["decision"],
): void => {
  deps.audit?.({
    threadId: req.action.threadId,
    turnId: req.turnId,
    signal: req.denial.signal,
    confidence: req.denial.confidence,
    justification: req.justification,
    decision,
  })
}
