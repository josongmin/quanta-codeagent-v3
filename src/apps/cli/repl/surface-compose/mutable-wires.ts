import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { defaultPlanQueueStore, type SendNowInjection } from "@/agent/plan-queue"
import type { Message } from "@/llm"
import type { RuntimeSideConversationArgs, RuntimeSideConversationResult } from "@/sdk/runtime"
import { errMessage, gateOn, type ItemStreamSink, itemStreamEnabled, logger } from "@/shared"
import type { SideStartUnwired } from "../../side-cmd"
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
  ): Promise<RuntimeSideConversationResult | SideStartUnwired> => {
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
    // aug-27 — the SURFACE-owned store, not `runtimeContext.stickyModelStore()`:
    // the interactive CLI's runtime overlay never carried that slot (only the
    // headless `apps/agent` composition root resolves one), so reading it here
    // was always `undefined` ⇒ adapter omitted ⇒ `/model` printed "not wired in
    // this surface". The surface mints the store in `core-state` and threads the
    // SAME instance down onto the per-turn config (`runtime-compose.ts`), so the
    // slash write and the loop's read are one cell.
    stickyStore: core.stickyModel,
    bootModel: setup.model,
    routing: core.routing.authority,
    provider: setup.provider,
    // THE live-mode getter, minted once in `core-state`: it mirrors the loop's
    // `resolveLiveAgentMode` (the shift+tab posture wins over `--plan`), and the
    // sticky key contains the mode — so the adapter's WRITE key and the slot's
    // `effectiveModel` READ key have to be the same function, not two
    // identical-looking constructions that can drift apart.
    currentMode: core.liveMode,
    candidateIds: () => core.modelCatalog.ids(),
    refresh: core.modelCatalog.refresh,
    // A resumed session's persisted pick needs no seed here any more: the store
    // this adapter reads through (`peek`) is itself seeded from the boot snapshot,
    // so `current()` is right on the FIRST paint.
  })
  const modelAdapter = modelWire.modelAdapter
  if (modelAdapter !== undefined) {
    setup.liveModelSource.source = () => modelAdapter.current()
  }

  return {
    convCheckpointWire,
    composerHandle,
    textInbox,
    playbookSeam,
    liveHistorySwap,
    setReplaceMessages,
    sessionSwitchWire:
      state.rewindState === undefined
        ? undefined
        : createSessionSwitchWire(state.rewindState.sessionId),
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
