import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { InboundMode } from "@/agent/inbound-mode"
import type { ObjectivePort } from "@/objective"
import type { PlanQueueStore, SendNowInjection } from "@/agent/plan-queue"
import type { Message } from "@/llm"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import type { ModeCycleStore } from "../../mode-cycle"
import type { ConvCheckpointSlashState } from "../../rewind-conv-cmd"
import type { SessionIoState } from "../../session-cmd"
import type { TextInbox } from "../../text-inbox"
import type { BackgroundTurnPortal } from "../background-turn-portal"
import type { ContextUsageHolder } from "../context-usage-snapshot"
import type { ConvCheckpointWire } from "../conv-checkpoint-wire"
import type { ConversationActionSurface } from "../conversation-action-surface"
import type { ComposerHandle } from "../ctx-adapters/composer-edit-adapter"
import type { PlaybookTriggerSurfaceSeam } from "../playbook-trigger-surface-seam"
import type { SessionSwitchWire } from "../session-switch-wire"
import type { ReplSlashCtx } from "../slash-surface"

/** ADR-0310 — public contract for the REPL-side wires constructed once per
 *  session. Kept separate from the composition implementation so additions to
 *  the contract do not grow the already-dense composition root. */
export interface ReplSurfaceWires {
  readonly slashCtx: ReplSlashCtx
  readonly convCheckpointSlot: ConvCheckpointSlashState | undefined
  readonly sessionIo: SessionIoState
  readonly dispatchSlash: (input: string) => Promise<boolean>
  readonly convCheckpointWire: ConvCheckpointWire | null
  readonly convStore: ConversationCheckpointStore
  readonly playbookSeam: PlaybookTriggerSurfaceSeam
  readonly composerHandle: ComposerHandle
  readonly textInbox: TextInbox
  readonly runtimeFacadeCompose: RuntimeFacadeComposeOptions
  readonly setReplaceMessages: (fn: (msgs: ReadonlyArray<Message>) => Promise<void>) => void
  readonly setSwitchSession?: SessionSwitchWire["setSwitchSession"]
  readonly setSideConversationStart: (
    fn: ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>) | undefined,
  ) => void
  readonly planQueueStore: PlanQueueStore
  readonly objectiveStore: ObjectivePort
  readonly setPlanQueueSendNow: (
    fn: ((inj: SendNowInjection) => { ok: true } | { ok: false; reason: string }) | undefined,
  ) => void
  readonly setAutomationSlash: (
    fn: import("../../slash/cron-cmd").AutomationSlashState | undefined,
  ) => void
  readonly conversationActions?: ConversationActionSurface
  readonly inboundMode: { current: InboundMode }
  readonly modeCycleStore?: ModeCycleStore
  readonly promptAssembledSink: ContextUsageHolder["sink"]
  readonly contextUsageView: ContextUsageHolder["view"]
  readonly backgroundPortal?: BackgroundTurnPortal
  readonly disposePerToolRecord?: () => void
}
