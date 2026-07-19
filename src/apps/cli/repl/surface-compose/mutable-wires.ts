import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { defaultPlanQueueStore, type SendNowInjection } from "@/agent/plan-queue"
import type { Message } from "@/llm"
import type {
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import { errMessage, gateOn, type ItemStreamSink, itemStreamEnabled, logger } from "@/shared"
import type { AutomationSlashState } from "../../slash/cron-cmd"
import type { McpResourceDirRecord } from "../../slash/mcp-resources-cmd"
import { createTextInbox } from "../../text-inbox"
import { startConvCheckpointWire } from "../conv-checkpoint-wire"
import { createComposerHandle } from "../ctx-adapters/composer-edit-adapter"
import { createItemStore } from "../item-store"
import { createPlaybookTriggerSurfaceSeam } from "../playbook-trigger-surface-seam"
import type { SessionSetupResult } from "../session-setup"
import { createSessionSwitchWire } from "../session-switch-wire"
import type { SurfaceCoreState } from "./core-state"
import { buildKbSlashSlot } from "./kb-slot"
import type { SurfaceState } from "./turn-sinks"
import { buildDefaultSessionIo, buildModelAdapterWire } from "./wire-builders"

type SideConversationStart = (
  args: RuntimeSideConversationArgs,
) => Promise<RuntimeSideConversationResult>
type SendNow = (injection: SendNowInjection) => { ok: true } | { ok: false; reason: string }

export const buildMutableSurfaceWires = (
  setup: SessionSetupResult,
  state: SurfaceState,
  env: NodeJS.ProcessEnv,
  convStore: ConversationCheckpointStore,
  core: SurfaceCoreState,
) => {
  const convCheckpointWire = gateOn(env, "QUANTA_CHECKPOINT_CONV")
    ? startConvCheckpointWire({ store: convStore })
    : null
  const composerHandle = createComposerHandle("")
  const textInbox = createTextInbox()
  const playbookSeam = createPlaybookTriggerSurfaceSeam()

  let replaceMessages: (messages: ReadonlyArray<Message>) => Promise<void> = async () => undefined
  const liveHistorySwap = async (messages: ReadonlyArray<Message>): Promise<void> => {
    try {
      await replaceMessages(messages)
    } catch (error) {
      logger.warn(`live-history swap threw: ${errMessage(error)}`)
    }
  }
  const setReplaceMessages = (
    replacement: (messages: ReadonlyArray<Message>) => Promise<void>,
  ): void => {
    replaceMessages = replacement
  }

  let sideConversationStart: SideConversationStart | undefined
  const setSideConversationStart = (start: SideConversationStart | undefined): void => {
    sideConversationStart = start
  }
  const startSideConversation = async (
    args: RuntimeSideConversationArgs,
  ): Promise<RuntimeSideConversationResult> => {
    if (sideConversationStart === undefined) return "not-wired"
    return await sideConversationStart(args)
  }

  let sendNow: SendNow | undefined
  const planQueueStore = defaultPlanQueueStore({
    sendNowSink: {
      inject: (injection) =>
        sendNow?.(injection) ?? {
          ok: false,
          reason: "send target not installed yet",
          retryable: true,
        },
    },
  })
  const setPlanQueueSendNow = (next: SendNow | undefined): void => {
    sendNow = next
  }

  let automationSlash: AutomationSlashState | undefined
  const setAutomationSlash = (next: AutomationSlashState | undefined): void => {
    automationSlash = next
  }

  const itemStore = itemStreamEnabled(env) ? createItemStore() : undefined
  const itemStreamSink: ItemStreamSink | undefined =
    itemStore === undefined
      ? undefined
      : {
          capture: (item) => {
            itemStore.capture(item)
            logger.debug(`item-stream fleet core: ${JSON.stringify(item)}`)
          },
        }
  const mcpResourcesSlot: (() => readonly McpResourceDirRecord[]) | undefined =
    setup.mcpResourceCapture === undefined
      ? undefined
      : () => setup.mcpResourceCapture?.snapshot() ?? []
  const modelWire = buildModelAdapterWire({
    stickyStore: setup.runtimeContext.stickyModelStore(),
    bootModel: setup.model,
    planMode: setup.planMode,
    candidateIds: [
      ...new Set([setup.model, ...core.retryCandidates.map((candidate) => candidate.id)]),
    ],
  })
  if (modelWire.modelAdapter !== undefined) {
    setup.liveModelSource.source = () => modelWire.modelAdapter?.current() ?? setup.model
  }

  return {
    convCheckpointWire,
    composerHandle,
    textInbox,
    playbookSeam,
    liveHistorySwap,
    setReplaceMessages,
    sessionSwitchWire:
      state.rewindState === undefined ? undefined : createSessionSwitchWire(state.rewindState.sessionId),
    setSideConversationStart,
    startSideConversation,
    isSideConversationWired: () => sideConversationStart !== undefined,
    planQueueStore,
    setPlanQueueSendNow,
    setAutomationSlash,
    automationSlash: () => automationSlash,
    sessionIo: buildDefaultSessionIo(),
    itemStore,
    itemStreamSink,
    projectsKbSlot: buildKbSlashSlot(setup.projectsKbStore),
    mcpResourcesSlot,
    modelWire,
  }
}

export type MutableSurfaceWires = ReturnType<typeof buildMutableSurfaceWires>
