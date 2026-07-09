/**
 * Session turn driver — ADR-0303 thin-surface extraction.
 *
 * The `append → turn.run → (if approvalRequest) respond → loop` turn-completion
 * primitive, hoisted OUT of the CLI surface (`apps/cli/repl/session-loop.ts`)
 * into the surface-agnostic `@/runner` layer so EVERY surface funnels through
 * ONE definition. Before this, the CLI owned the approval-resolution loop while
 * `apps/headless` re-implemented the same turn primitive WITHOUT it — a
 * divergence (headless would hang/ignore a tool that requests approval). The
 * loop is reusable runtime semantics, not a host concern, so it belongs below
 * `src/apps/**`.
 *
 * Surface-agnostic by construction: NO terminal / readline / render / status-bar
 * deps (those stay in the surface and feed this driver via the injected
 * {@link ApprovalResolver} port + the optional `beforeTurn` host hook). Only the
 * `@/sdk/runtime` session contract + `@/llm`/`@/agent` value-free types are
 * referenced — fence-clean for `@/runner` (verified: `@/sdk` has no fence and
 * does not import `@/runner`, so no cycle).
 */

import type { AgentOutcome } from "@/agent"
import type { ImageBlock, Message } from "@/llm"
import type { RuntimeSession, SessionDispatchResult } from "@/sdk/runtime"
import { type ApprovalDecisionResult, normalizeApprovalDecision } from "./approval-decision"
import { attachCrashResumePartial, withCrashResumeMarker } from "./crash-resume-wire"

/** The SDK turn payload (the non-undefined `turn` of a dispatch result). */
type SessionTurnPayload = NonNullable<SessionDispatchResult["turn"]>
/** The pending-approval view carried on a turn payload when the gate asks. */
type PendingApproval = NonNullable<SessionTurnPayload["approvalRequest"]>

// WS-A (jul-10) — the wire union + its SSOT normalizer live in
// `./approval-decision`; re-exported here so existing `@/runner/orchestrate`
// consumers keep their import path (byte-identical type).
export type { ApprovalDecisionResult } from "./approval-decision"

/** Host-injected approval resolver — mirrors the CLI's `setup.approvalPrompt`.
 *  Receives the pending approval and returns the operator decision. The surface
 *  owns the prompt UX (TTY prompt / Web modal / headless auto-policy); the
 *  driver only awaits the decision. */
export type ApprovalResolver = (approval: PendingApproval) => Promise<ApprovalDecisionResult>

/** Normalized turn-completion result (the SDK envelope dropped). `outcome` is
 *  the full {@link AgentOutcome} (additive — host surfaces that only need the
 *  reason ignore it; headless returns it verbatim for byte-identical output). */
export interface SessionTurnResult {
  readonly messages: readonly Message[]
  readonly outcome: AgentOutcome
  readonly outcomeReason?: AgentOutcome["reason"]
}

export interface RunSessionTurnArgs {
  readonly session: RuntimeSession
  /** Operator decision port. CLI passes `setup.approvalPrompt`; headless passes
   *  an auto-policy (default approve) so a tool that requests approval does not
   *  deadlock a no-operator run. */
  readonly resolveApproval: ApprovalResolver
  readonly text: string
  readonly images?: readonly ImageBlock[]
  readonly turnSignal: AbortSignal
  /** Optional host hook run BEFORE `input.append` (after the surface has
   *  prepared `images`). The CLI uses it to sync the engine-owned
   *  `permissionModeState` from its slash-local mode-cycle store (§3.1
   *  state-authority). Absent ⇒ byte-identical no-op. */
  readonly beforeTurn?: () => void
  /** ADR-0528 — the DURABLE session id (id-mode). When present, this single
   *  live turn chokepoint is bracketed with a crash-resume marker so a process
   *  death mid-turn is recoverable on restart. Absent (ephemeral/headless-fake
   *  session) OR gate off ⇒ byte-identical no-op. */
  readonly sessionId?: string
  /** ADR-0528 — env THREADED from the composition root (apps/cli / host), NOT
   *  read from `process.env` here. The crash-resume marker drives its gate
   *  (`gateOn(env, CRASH_RESUME_GATE)`) off this exact env, so a feature-gate
   *  input must arrive through the args — not an ambient raw `process.env`
   *  literal (the `@/session` slice is env-pure by design; see
   *  `src/session/crash-resume.ts`). Surfaces that never set `sessionId` (the
   *  ephemeral/escalation paths) still thread it so the gate is deterministic. */
  readonly env: Record<string, string | undefined>
}

const requireTurnPayload = (result: SessionDispatchResult): SessionTurnPayload => {
  if (result.turn === undefined) {
    throw new Error("runtime session turn completed without a turn payload")
  }
  return result.turn
}

const completeRuntimeTurn = (turn: SessionTurnPayload): SessionTurnResult => ({
  messages: turn.messages,
  outcome: turn.outcome,
  ...(turn.outcome.reason !== undefined ? { outcomeReason: turn.outcome.reason } : {}),
})

const resolvePendingApproval = async (
  session: RuntimeSession,
  resolveApproval: ApprovalResolver,
  approval: PendingApproval,
  turnSignal: AbortSignal,
): Promise<void> => {
  const raw = await resolveApproval(approval)
  // WS-A (jul-10) — the SSOT normalizer replaces the prior inline mapping so
  // every consumer of the wire union reads it identically (UUX-1-02 class).
  const norm = normalizeApprovalDecision(raw)
  // ADR-0512 P3 — forward the escalation's once/session scope + corrective steer
  // so the host lease carries the operator's rich decision. Empty ⇒ `undefined`
  // meta, byte-identical to the legacy 2-verb respond.
  const meta = {
    ...(norm.scope !== undefined ? { scope: norm.scope } : {}),
    ...(norm.steer !== undefined ? { steer: norm.steer } : {}),
  }
  await session.approval.respond(
    approval.approvalId,
    norm.decision,
    Object.keys(meta).length > 0 ? meta : undefined,
    { signal: turnSignal },
  )
  // A NORMAL approval deny aborts the turn (byte-identical legacy). An ESCALATION
  // deny (the approval carries `scopeContext`) is RECOVERABLE: the loop re-runs,
  // claims the deny lease, and the model receives a `skill-scoped: declined` /
  // `steered` tool_result — so we do NOT throw, letting the loop continue.
  if (norm.decision === "deny" && approval.scopeContext === undefined) {
    throw new Error(`runtime session approval denied (${approval.reason})`)
  }
}

/**
 * Run ONE session turn end-to-end against a {@link RuntimeSession}, draining the
 * approval loop: `beforeTurn → append → turn.run → (if approvalRequest) respond
 * → loop`. Surface-agnostic — the CLI interactive + one-shot branches AND
 * headless all funnel through this so the approval-resolution loop is defined
 * exactly ONCE.
 */
export const runSessionTurn = async (args: RunSessionTurnArgs): Promise<SessionTurnResult> => {
  const { session, resolveApproval, text, images, turnSignal, beforeTurn, sessionId, env } = args
  const body = async (): Promise<SessionTurnResult> => {
    beforeTurn?.()
    const imgs = images ?? []
    await session.input.append(text, imgs.length > 0 ? { images: imgs } : undefined, {
      signal: turnSignal,
    })
    for (;;) {
      const turn = requireTurnPayload(await session.turn.run(undefined, { signal: turnSignal }))
      if (turn.approvalRequest === undefined) return completeRuntimeTurn(turn)
      await resolvePendingApproval(session, resolveApproval, turn.approvalRequest, turnSignal)
    }
  }
  // ADR-0528 — crash-resume LIVE wiring at the SINGLE turn chokepoint every
  // surface (CLI interactive + one-shot + headless) funnels through. Mark the
  // turn in-progress before it runs, clear when it resolves (reaching here ⇒ the
  // process survived; only a hard crash leaves the marker). Gate-gated + only
  // when a durable `sessionId` is known ⇒ byte-identical otherwise.
  if (sessionId === undefined) return body()
  const markerArgs = { sessionId, userText: text, env }
  // ADR-0528 L3 (P2) — keep the marker's partial FRESH during the turn by
  // subscribing to the session stream (no-op unless QUANTA_CRASH_RESUME_PARTIAL).
  const detachPartial = attachCrashResumePartial(session, markerArgs)
  try {
    return await withCrashResumeMarker(markerArgs, body)
  } finally {
    detachPartial()
  }
}
