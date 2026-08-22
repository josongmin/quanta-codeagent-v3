import type { AgentConfig } from "@/agent"
import type { InboundMode } from "@/agent/inbound-mode"
import type { ObjectivePort } from "@/objective"
import type { LastTurnOutcome } from "@/reactor"
import type { ImageQueue } from "../../image-queue"
import type { NotificationPort } from "../../notify"
import type { TextInbox } from "../../text-inbox"
import type { BackgroundTurnPortal } from "../background-turn-portal"
import type { ConvCheckpointWire } from "../conv-checkpoint-wire"
import type { ConversationActionSurface } from "../conversation-action-surface"
import type { ExternalPromptQueue } from "../external-prompt-queue"
import type { heartbeatEnqueueHandler } from "../heartbeat-binder"
import type { ComposePromptPipelineDeps, DispatchSlash } from "../prompt-pipeline"
import type { SessionSetupResult } from "../session-setup"
import type { SessionState } from "../session-state"
import type { CloseStackEntry } from "./close-stack"
import type { RunSessionTurn } from "./turn-driver"
import type { SessionLoopSinks } from "./types"

/** The mutable surface/outcome/timing state both branches read+write. Modeled
 *  as explicit getter/setter callbacks so the extracted branch helpers mutate
 *  the SAME `let` bindings `runSessionLoop` owns (byte-identical to the prior
 *  in-scope reassignments). */
export interface LoopMutableRefs {
  readonly getSurfaceState: () => SessionState
  readonly setSurfaceState: (next: SessionState) => void
  readonly setLastTurnOutcome: (outcome: LastTurnOutcome) => void
}

/** Shared context for {@link runOneShotBranch}. */
export interface OneShotBranchCtx extends LoopMutableRefs {
  readonly setup: SessionSetupResult
  readonly sinks: SessionLoopSinks
  readonly withInTurnCapture: <R>(run: () => Promise<R>) => Promise<R>
  readonly runSessionTurn: RunSessionTurn
  readonly externalPromptQueue: ExternalPromptQueue
  readonly convCheckpointWire: ConvCheckpointWire | null | undefined
  readonly notify: NotificationPort | undefined
  readonly notifyCwdBasename: string | undefined
  readonly drainCloseStack: () => Promise<void>
}

/** Shared context for the interactive branch (setup + loop). Extends the
 *  one-shot ctx with the interactive-only wires. */
export interface InteractiveBranchCtx extends LoopMutableRefs {
  readonly setup: SessionSetupResult
  readonly sinks: SessionLoopSinks
  readonly withInTurnCapture: <R>(run: () => Promise<R>) => Promise<R>
  readonly runSessionTurn: RunSessionTurn
  readonly externalPromptQueue: ExternalPromptQueue
  readonly convCheckpointWire: ConvCheckpointWire | null | undefined
  readonly notify: NotificationPort | undefined
  readonly notifyCwdBasename: string | undefined
  readonly drainCloseStack: () => Promise<void>
  readonly closeStack: Array<CloseStackEntry>
  readonly getLastTurnOutcome: () => LastTurnOutcome | undefined
  readonly setLastUserInputAt: (at: number) => void
  readonly getLastUserInputAt: () => number
  readonly backgroundPortal: BackgroundTurnPortal | undefined
  readonly inboundMode: { current: InboundMode } | undefined
  readonly conversationActions: ConversationActionSurface | undefined
  // Interactive SETUP inputs (consumed by `wireInteractiveSetup`).
  readonly liveAutomationSlot: NonNullable<AgentConfig["automationEngine"]> | undefined
  readonly dispatchSlash: DispatchSlash
  readonly imageQueue: ImageQueue | undefined
  readonly textInbox: TextInbox | undefined
  readonly ux: ComposePromptPipelineDeps["ux"]
  readonly contextWarning: (() => string) | undefined
  readonly objectiveStore: ObjectivePort | undefined
  readonly activeIdentityModeState: { get: () => string } | undefined
  readonly enqueueWithHeartbeat: ReturnType<typeof heartbeatEnqueueHandler>
}
