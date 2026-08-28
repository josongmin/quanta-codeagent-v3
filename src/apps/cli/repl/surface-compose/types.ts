import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { InboundMode } from "@/agent/inbound-mode"
import type { PlanQueueStore, SendNowInjection } from "@/agent/plan-queue"
import type { Message } from "@/llm"
import type { ObjectivePort } from "@/objective"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import type { ModeCycleStore } from "../../mode-cycle"
import type { ConvCheckpointSlashState } from "../../rewind-conv-cmd"
import type { SessionIoState } from "../../session-cmd"
import type { SlashContext } from "../../slash-commands"
import type { TextInbox } from "../../text-inbox"
import type { BackgroundTurnPortal } from "../background-turn-portal"
import type { ContextUsageHolder } from "../context-usage-snapshot"
import type { ConvCheckpointWire } from "../conv-checkpoint-wire"
import type { ConversationActionSurface } from "../conversation-action-surface"
import type { ComposerHandle } from "../ctx-adapters/composer-edit-adapter"
import type { GoalWakeSignalSlot } from "../goal-wake-signal"
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
  /** aug-28 — the `/model` adapter (absent when no sticky store is wired). The
   *  dispatcher installs it as the live `ctx.model`; exposing it here lets a
   *  wiring proof assert what the picker OFFERS without hand-building the slot. */
  readonly modelAdapter?: SlashContext["model"]
  readonly setReplaceMessages: (fn: (msgs: ReadonlyArray<Message>) => Promise<void>) => void
  readonly setSwitchSession?: SessionSwitchWire["setSwitchSession"]
  readonly setSideConversationStart: (
    fn: ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>) | undefined,
  ) => void
  readonly planQueueStore: PlanQueueStore
  /** RFC-03 H1 — the surface-owned objective authority, PRESENT only under
   *  `QUANTA_OBJECTIVE_TOOLS` (undefined ⇒ `/goal` not-wired + no `objective_*`
   *  tools, the `objective_set` SSOT `cli: "opt-in"` default). Gated by
   *  `QUANTA_PROPOSE_GOAL` when present. */
  readonly objectiveStore: ObjectivePort | undefined
  /** Session-local event bridge for the edge-triggered goal wake controller. */
  readonly goalWakeSlot?: GoalWakeSignalSlot
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
