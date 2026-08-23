/**
 * RFC jun-6 — bash-side host seam for the sandbox-block → escalation-retry loop.
 *
 * The escalation MACHINE lives in `@/agent/sandbox-escalation` (the orchestrator)
 * + `@/runtime/os-sandbox` (the `classifySandboxDenial` discriminant) +
 * `@/permission/post-denial` (the 3-step re-approval store). The `@/tool` slice
 * is FENCE-ISOLATED from `@/agent` and `@/permission` (RFC §3.1) — so the bash
 * tool can NOT import those directly. This module owns the duck-typed HANDLER
 * CONTRACT the COMPOSITION ROOT (`@/host/runtime`) adapts the orchestrator +
 * classifier + store + HITL gate into, and the bash tool invokes when a
 * `mode="read"` sandboxed command exits nonzero.
 *
 * PER-SESSION, NOT PROCESS-GLOBAL (aug-23 audit fix): this seam used to be a
 * module-level `let installed` singleton (the `per-call-factory.ts` precedent).
 * That was WRONG here — the handler closes over SESSION-UNIQUE authority (the
 * session `PermissionStore`, its `onConfirm` HITL gate, and its ONE escalation
 * cap), so a process hosting two sessions (`@/sdk` `embed` re-assembles on every
 * `run()`) got last-writer-wins: session A's approval prompt went to session B's
 * operator, the ADR-0046 override landed in B's store, and a knob-less `run()`
 * DISARMED a live sibling. The handler now rides the session's `AgentConfig`
 * (`cfg.bashSandboxEscalation`, minted ONCE per session so the cap accumulates)
 * and dispatch projects it per turn onto `ToolContext.sandboxEscalation` — the
 * same 2-stage mint/bind shape as `writeBudget`.
 *
 * DEFAULT-OFF / byte-identical: no handler on the ctx ⇒ the bash tool never calls
 * this ⇒ a sandboxed nonzero exit surfaces exactly as today (a plain failure).
 * The host wires a handler ONLY when `QUANTA_SANDBOX_ESCALATION` is on. The
 * handler itself ALSO classifies; an unrecognised result returns `undefined` so
 * the bash tool yields its normal result unchanged.
 *
 * SECURITY: escalation NEVER auto-grants (the orchestrator enforces the ADR-0046
 * 3-step ordered re-approval + routes the unsandboxed re-run through the NORMAL
 * permission gate). This seam only TRANSPORTS the request; all the security lives
 * in the machine it adapts.
 */

/** The byte-same argv re-run with the sandbox FORCED OFF (the bash tool supplies
 *  this closure — it re-invokes `runShell` WITHOUT the per-call wrap). */
export type UnsandboxedRerun = () => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** What the bash tool hands the seam when a sandboxed command exited nonzero. */
export interface BashSandboxEscalationRequest {
  /** The exact shell command (byte-same argv on the re-run). */
  readonly command: string
  readonly cwd: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Stable caller identity for the post-denial `(threadId, action)` key. */
  readonly agentLabel?: string
  readonly turnId?: string
  /** Re-run the byte-same command WITHOUT the per-call sandbox wrap (one call). */
  readonly rerunUnsandboxed: UnsandboxedRerun
}

/** The seam's verdict. `undefined` (the no-handler / not-a-block / knob-off case)
 *  ⇒ the bash tool yields its ORIGINAL result, byte-identical. A defined result
 *  ⇒ the command WAS a sandbox block; `rerun` carries the approved unsandboxed
 *  output (when present) and `note` is a model-facing line appended to the
 *  output (e.g. "escalation denied" / "escalation exhausted"). */
export interface BashSandboxEscalationOutcome {
  /** The replacement shell result after an APPROVED + gate-cleared unsandboxed
   *  re-run. Absent ⇒ no re-run happened (denied / gate-denied / exhausted). */
  readonly rerun?: { exitCode: number; stdout: string; stderr: string }
  /** A model-facing note describing the block + its disposition. Always present
   *  when the result is defined (the model SEES this was a sandbox block, not a
   *  generic failure — RFC §4.3 step 2). */
  readonly note: string
}

/**
 * The handler the composition root installs. Returns `undefined` when the result
 * is NOT a recognised sandbox block (so the bash tool is byte-identical), or a
 * {@link BashSandboxEscalationOutcome} when it IS (carrying the re-run output
 * and/or a model-facing note).
 */
export type BashSandboxEscalationHandler = (
  req: BashSandboxEscalationRequest,
) => Promise<BashSandboxEscalationOutcome | undefined>
