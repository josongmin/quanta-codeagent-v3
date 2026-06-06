/**
 * Shared loop types — Phase-1 decomposition (SRP / ISP).
 *
 * Pure type surface; no runtime values. Imported by loop orchestration modules
 * and re-exported through `loop.ts` where historically public.
 */

import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import type { BgSummaryPayload } from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { CompactionBreaker } from "../compaction-breaker"
import type { buildSessionFeatures } from "../features"
import type { TurnDiffSession } from "../git-observability"
import type { HookPromptInject } from "../hooks"
import type { buildGitDirectiveEmit } from "../loop-helpers"
import type { AgentRecorder } from "../metrics"
import type { PlanExitOutcome } from "../plan-exit"
import type { AssembledMessage } from "../recovery"
import type { ShellSnapshotSession } from "../shell-snapshot-session"
import type { StopCategory } from "../stop-category"
import type { TurnSession, TurnState } from "../turn-context"
import type { AgentConfig, AgentOutcome, StopReason } from "../types"

/** Outcome of one logical turn. Only `tools` advances the maxTurns counter;
 *  `retry` re-enters the SAME turn (transient/PTL/output/malformed/empty
 *  recovery) without consuming a turn slot. */
export type TurnResult =
  | { kind: "tools"; message: AssembledMessage; resultBlocks: AssembledMessage["content"] }
  | { kind: "completed"; message?: AssembledMessage }
  | { kind: "aborted" }
  | { kind: "interrupted" }
  | { kind: "error"; reason: string }
  | { kind: "refusal"; rationale: string; message: AssembledMessage }

/** A successfully streamed turn. */
export type StreamSuccess = {
  message: AssembledMessage
  stopReason: string
  resultBlocks: AssembledMessage["content"]
}

export type StreamConsumeResult =
  | StreamSuccess
  | { error: unknown; message: string }
  | { aborted: true }

export type PendingPlanExit = {
  readonly plan: string
  readonly outcome: PlanExitOutcome
}

export type TurnLoopResolution =
  | { readonly kind: "continue" }
  | { readonly kind: "park"; readonly turns: number }
  | {
      readonly kind: "finish"
      readonly reason: StopReason
      readonly turns: number
      readonly stopCategory?: StopCategory
      readonly refusal?: { readonly rationale: string }
    }

export type FinishAgentSession = (
  reason: StopReason,
  turns: number,
  stopCategory?: StopCategory,
  refusal?: { readonly rationale: string },
) => Promise<AgentOutcome>

export type RunAgentTurnStateSeed = Omit<TurnState, "rec" | "collector">

export interface RunAgentContext {
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly recorder: AgentRecorder | undefined
  readonly breaker: CompactionBreaker | undefined
  readonly localizePhaseState: import("../localize-phase-guard").LocalizePhaseState | undefined
  readonly dedupGate: unknown
  readonly hookPromptPending: HookPromptInject[]
  readonly pendingPlanExitRef: { current: PendingPlanExit | null }
  readonly shellSnapshotSession: ShellSnapshotSession | undefined
  readonly turnDiffSession: TurnDiffSession | undefined
  readonly gitDirectiveCollector: ReturnType<typeof buildGitDirectiveEmit> | undefined
  readonly session: TurnSession
  readonly turnStateSeed: RunAgentTurnStateSeed
  readonly finish: FinishAgentSession
  readonly bgCompaction: BackgroundSummarizationController<BgSummaryPayload> | undefined
}

export type Step = { done: false } | { done: true; result: TurnResult }
