/**
 * H8 last-mile — heartbeat enqueue → thread-resume + posture binding (ADR-0480).
 *
 * The scheduler runtime already FORWARDS `{ targetThreadId, inheritedPolicy }`
 * into `AgentLoopPort.enqueueUserMessage` (`scheduler/runtime.ts:243-256`), but
 * every host `AgentLoopPort` impl historically DROPPED the second `opts`
 * argument (a bare `externalPromptQueue.push(message)`), so a heartbeat fire
 * silently degraded to a fresh prompt on the CURRENT session's queue — no
 * resume of the TARGET thread, no re-application of the inherited posture.
 *
 * This is the bind: a closed `HeartbeatThreadBinder` port + a CLI
 * implementation that, for a heartbeat fire (`targetThreadId` present):
 *   1. resolves the target thread against the LIVE session
 *      (same-thread fast path; a foreign thread this REPL is not driving ⇒ a
 *      LOUD typed `thread-not-found`, never a silent mis-route);
 *   2. re-applies the inherited approval posture into the SAME per-turn
 *      permission cell the mode-cycle writes (`session-loop.ts:534`), so the
 *      resumed turn runs under the captured stance;
 *   3. enqueues the prompt onto that thread's queue.
 *
 * SECURITY (the load-bearing core): the posture clamp. A heartbeat must NEVER
 * grant more than the MOST-RESTRICTIVE of {inherited, current}. The
 * `inheritedPolicy` is round-tripped through JSONL as OPAQUE strings
 * (`store-jsonl.ts:218`); a forged/tampered snapshot must not widen authority.
 * Two fail-closed disciplines:
 *   - an `approvalPolicy` value OUTSIDE the closed `PermissionMode` vocabulary
 *     maps to the MOST-restrictive mode (`default`), NEVER the most permissive;
 *   - the resolved snapshot mode is then CLAMPED against the current cell's
 *     mode by taking the safer (more-restrictive) of the two — the heartbeat
 *     can re-apply a SNAPSHOT but never escalate beyond what is live.
 *
 * Closed-port DI: the binder reaches into NO global. The live-thread id, the
 * permission cell, and the push sink are all injected. No `Date.now` /
 * `Math.random` / `process.env` here (the runtime stamps `at`; the binder needs
 * no clock — it is a pure routing + clamp over injected cells).
 */

import { isPermissionMode, type PermissionMode } from "@/permission"
import type { PermissionModeSessionState } from "@/runner/assemble/session-state"
import type { HeartbeatPolicySnapshot } from "@/scheduler"

/**
 * Why a heartbeat resume did not bind. NO-THROW: the binder returns this as a
 * value so a failed resume never crashes the scheduler tick (the runtime treats
 * an enqueue throw as an observable `scheduler.error`, `runtime.ts:257-277`).
 *   - `thread-not-found`  — `targetThreadId` is not the thread this REPL drives
 *                            (cross-thread / missing); NO push onto a wrong queue.
 *   - `posture-rejected`  — the inherited snapshot could not be mapped onto the
 *                            host vocabulary (reserved; the current host
 *                            fail-closes corrupt values to `default` rather than
 *                            rejecting, so this arm is for future strict hosts).
 *   - `enqueue-failed`    — the push sink itself threw.
 */
export type HeartbeatResumeReason = "thread-not-found" | "posture-rejected" | "enqueue-failed"

export type HeartbeatResumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HeartbeatResumeReason }

/** A thread-targeted heartbeat resume. */
export interface HeartbeatResumeRequest {
  readonly targetThreadId: string
  readonly prompt: string
  readonly inheritedPolicy?: HeartbeatPolicySnapshot
  readonly modelOverride?: string
  readonly signal?: AbortSignal
}

/**
 * Closed port — resume `targetThreadId` with `prompt`, re-applying the inherited
 * posture for the turn. Injected (not reached-into) so the scheduler/CLI slices
 * stay testable with a fake. NO-THROW (returns a typed verdict).
 */
export interface HeartbeatThreadBinder {
  resume(req: HeartbeatResumeRequest): Promise<HeartbeatResumeResult>
}

/**
 * Restrictiveness rank for the loop's `PermissionMode` vocabulary —
 * HIGHER = SAFER (more confirmation / less authority). Voice-matches the
 * `APPROVAL_SAFETY` polarity in `permission/profile-layer-merge.ts` so the
 * "most-restrictive" meet is the SAME discipline used by the provenance-gate.
 *
 *   - `default`     — every action prompts (the normal HITL gate): SAFEST.
 *   - `acceptEdits` — edits auto-approved, other actions still prompt.
 *   - `auto`        — classifier-driven (degrades to "ask" with no port): mid.
 *   - `bypass`      — all gates suppressed: MOST permissive.
 */
const PERMISSION_MODE_SAFETY: Readonly<Record<PermissionMode, number>> = Object.freeze({
  default: 3,
  acceptEdits: 2,
  auto: 1,
  bypass: 0,
})

/** The MOST-restrictive mode — the fail-closed floor for an unknown/forged
 *  `approvalPolicy`. NEVER pick a more-permissive default. */
const MOST_RESTRICTIVE_MODE: PermissionMode = "default"

/**
 * Map the inherited snapshot's opaque `approvalPolicy` string onto the host's
 * closed `PermissionMode` vocabulary. FAIL-CLOSED: an unknown value (a forged /
 * tampered JSONL snapshot) maps to the MOST-restrictive mode, never the most
 * permissive. Pure + total.
 */
export const mapInheritedApprovalToMode = (approvalPolicy: string): PermissionMode =>
  isPermissionMode(approvalPolicy) ? approvalPolicy : MOST_RESTRICTIVE_MODE

/**
 * The "never escalate" meet — return the SAFER (more-restrictive) of two modes.
 * Commutative + idempotent (a per-axis meet over the safety rank). A heartbeat
 * re-applies its captured SNAPSHOT but can never widen beyond the CURRENT cell:
 * if the live session is stricter, the live mode wins; if the snapshot is
 * stricter, the snapshot wins. The result is never-less-safe than either input.
 */
export const clampToMostRestrictive = (a: PermissionMode, b: PermissionMode): PermissionMode =>
  PERMISSION_MODE_SAFETY[a] >= PERMISSION_MODE_SAFETY[b] ? a : b

/** Injected dependencies for the CLI same-thread binder. */
export interface CreateHeartbeatBinderDeps {
  /** The thread id this REPL process is driving (`surfaceState.sessionId`).
   *  Read at resume time (a getter) so a session that re-keys mid-run resolves
   *  against the CURRENT id. Absent (no session id) ⇒ every resume is
   *  `thread-not-found` (this process drives no resolvable thread). */
  readonly liveThreadId: () => string | undefined
  /** The engine-owned per-turn permission cell the mode-cycle writes
   *  (`runtimeContext.permissionModeState()`). Absent ⇒ no posture cell to
   *  re-apply into; the resume still binds the prompt but applies no posture
   *  (byte-identical to a host with no mode cell). */
  readonly permissionCell: () => PermissionModeSessionState | undefined
  /** Push the resumed prompt onto the live thread's out-of-band queue
   *  (`externalPromptQueue.push`). MAY throw (full / closed queue) ⇒
   *  `enqueue-failed`. */
  readonly pushPrompt: (prompt: string) => void
}

/**
 * Construct the CLI same-thread `HeartbeatThreadBinder`. Same-thread resume
 * (`targetThreadId === liveThreadId()`): clamp + re-apply the inherited posture,
 * then push the prompt. Cross-thread / missing: a loud `thread-not-found` with
 * NO push (the future multi-thread host supplies a binder that CAN load a
 * foreign thread; this port is that seam).
 */
export const createHeartbeatBinder = (deps: CreateHeartbeatBinderDeps): HeartbeatThreadBinder => ({
  resume: async (req: HeartbeatResumeRequest): Promise<HeartbeatResumeResult> => {
    const live = deps.liveThreadId()
    // Cross-thread / missing thread ⇒ loud typed verdict. A single CLI process
    // drives ONE interactive session; it cannot resume an arbitrary other
    // thread in-process. Fail loud rather than mis-route onto the wrong queue.
    if (live === undefined || req.targetThreadId !== live) {
      return { ok: false, reason: "thread-not-found" }
    }

    // Posture re-application — write the inherited snapshot into the SAME
    // per-turn cell the mode-cycle writes, CLAMPED so the heartbeat can never
    // grant more than the most-restrictive of {inherited, current}.
    if (req.inheritedPolicy !== undefined) {
      const cell = deps.permissionCell()
      if (cell !== undefined) {
        const inheritedMode = mapInheritedApprovalToMode(req.inheritedPolicy.approvalPolicy)
        const currentMode = cell.get()
        cell.set(clampToMostRestrictive(inheritedMode, currentMode))
      }
    }

    // Enqueue onto the live thread (which IS the target). NO-THROW out of
    // `resume`: a push fault becomes `enqueue-failed`, forwarded to the
    // runtime as a typed non-delivery so it emits `scheduler.error` and
    // retries the occurrence (bounded) instead of counting it as fired.
    try {
      deps.pushPrompt(req.prompt)
    } catch {
      return { ok: false, reason: "enqueue-failed" }
    }
    return { ok: true }
  },
})

/**
 * Adapt a `HeartbeatThreadBinder` into the branching `AgentLoopPort`-shaped
 * `enqueueUserMessage` handler. The CRON path (`opts?.targetThreadId ===
 * undefined`) is BYTE-IDENTICAL to today: a bare `pushPrompt(message)`.
 * Only a heartbeat fire (target present) routes through the binder.
 *
 * WS-D effect receipt (jul-10, UUX-4-01): the binder verdict is HONORED, not
 * swallowed. `{ok:false}` — a PROVABLE non-delivery (no push happened) — is
 * forwarded to the scheduler runtime as a typed `EnqueueRejected` resolution,
 * so the runtime emits `scheduler.error` (never `scheduler.fired`) and keeps
 * the occurrence for a bounded retry. Resolving `undefined` remains the
 * delivery receipt. A binder that THROWS/rejects (contract violation — the
 * port is no-throw) propagates as an unknown/hard failure so the runtime
 * takes the M7 hard-fail path (advanced anchor + status error).
 */
export const heartbeatEnqueueHandler =
  (deps: {
    readonly binder: HeartbeatThreadBinder
    readonly pushPrompt: (prompt: string) => void
  }) =>
  async (
    message: string,
    opts?: {
      signal?: AbortSignal
      modelOverride?: string
      targetThreadId?: string
      inheritedPolicy?: HeartbeatPolicySnapshot
    },
    // biome-ignore lint/suspicious/noConfusingVoidType: mirrors the scheduler AgentLoopPort contract — `void` keeps the CRON leg's bare `return` (delivery receipt) assignable; see @/scheduler types.ts.
  ): Promise<void | { readonly delivered: false; readonly reason: string }> => {
    // CRON path — no target thread. Byte-identical to the historical handler.
    if (opts?.targetThreadId === undefined) {
      deps.pushPrompt(message)
      return
    }
    // HEARTBEAT path — resume the target thread under its inherited posture.
    const result = await deps.binder.resume({
      targetThreadId: opts.targetThreadId,
      prompt: message,
      ...(opts.inheritedPolicy !== undefined ? { inheritedPolicy: opts.inheritedPolicy } : {}),
      ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (!result.ok) {
      return { delivered: false, reason: result.reason }
    }
  }
