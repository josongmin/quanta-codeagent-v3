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

/** The SDK turn payload (the non-undefined `turn` of a dispatch result). */
type SessionTurnPayload = NonNullable<SessionDispatchResult["turn"]>
/** The pending-approval view carried on a turn payload when the gate asks. */
type PendingApproval = NonNullable<SessionTurnPayload["approvalRequest"]>

/** Host-injected approval resolver — mirrors the CLI's `setup.approvalPrompt`.
 *  Receives the pending approval and returns the operator decision. The surface
 *  owns the prompt UX (TTY prompt / Web modal / headless auto-policy); the
 *  driver only awaits the decision. */
export type ApprovalResolver = (approval: PendingApproval) => Promise<"approve" | "deny">

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
  const decision = await resolveApproval(approval)
  await session.approval.respond(approval.approvalId, decision, undefined, {
    signal: turnSignal,
  })
  if (decision === "deny") {
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
  const { session, resolveApproval, text, images, turnSignal, beforeTurn } = args
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
