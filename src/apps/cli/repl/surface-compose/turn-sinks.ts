import type { Message } from "@/llm"
import { buildCostDashboard, GEN_AI_ATTRS, renderDashboardText } from "@/observability"
import { errMessage } from "@/shared"
import type { ImageQueue } from "../../image-queue"
import { overlayServerHealth } from "../../mcp-health"
import type { RewindSlashState } from "../../rewind-cmd"
import type { StatusBar } from "../../status-bar"
import { deriveMcpPillServers } from "../factories/lifecycle"
import type { SessionLoopSinks } from "../session-loop"
import type { SessionSetupResult } from "../session-setup"

interface CostPanelDeltaBaseline {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface SurfaceState {
  readonly imageQueue: ImageQueue | undefined
  readonly rewindState: RewindSlashState | undefined
  history: readonly Message[]
  readonly costDeltaPrev: CostPanelDeltaBaseline
}

export const createSurfaceState = (args: {
  readonly imageQueue: ImageQueue | undefined
  readonly rewindState: RewindSlashState | undefined
  readonly history: readonly Message[]
}): SurfaceState => ({
  imageQueue: args.imageQueue,
  rewindState: args.rewindState,
  history: args.history,
  costDeltaPrev: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
})

const foldCostPanelDelta = (
  panel: {
    incrementTurn: (delta: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
    }) => void
  },
  snap: { counters: Record<string, number> },
  prev: CostPanelDeltaBaseline,
): void => {
  const curIn = snap.counters[GEN_AI_ATTRS.usage.inputTokens] ?? 0
  const curOut = snap.counters[GEN_AI_ATTRS.usage.outputTokens] ?? 0
  const curCache = snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens] ?? 0
  const dIn = Math.max(0, curIn - prev.inputTokens)
  const dOut = Math.max(0, curOut - prev.outputTokens)
  const dCache = Math.max(0, curCache - prev.cacheReadTokens)
  prev.inputTokens = curIn
  prev.outputTokens = curOut
  prev.cacheReadTokens = curCache
  panel.incrementTurn({ inputTokens: dIn, outputTokens: dOut, cacheReadTokens: dCache })
}

const foldCostPanelIfWired = (
  panel:
    | {
        incrementTurn: (delta: {
          inputTokens: number
          outputTokens: number
          cacheReadTokens: number
        }) => void
      }
    | undefined,
  metrics: { snapshot: () => { counters: Record<string, number> } } | undefined,
  prev: CostPanelDeltaBaseline,
): void => {
  if (panel === undefined || metrics === undefined) return
  foldCostPanelDelta(panel, metrics.snapshot(), prev)
}

const snapshotAndFlushLifecyclePills = (setup: SessionSetupResult): void => {
  if (setup.lifecycleTaskRegistry !== undefined) {
    const running = setup.lifecycleTaskRegistry.pendingIds().length
    const total = setup.lifecycleTaskRegistry.list().length
    setup.lifecyclePills.update({ subagent: { running, total } })
  }
  if (setup.lifecycleFollowUpQueue !== undefined) {
    setup.lifecyclePills.update({ followUp: { queued: setup.lifecycleFollowUpQueue.size() } })
  }
  // WS-G (UUX-6-22) — the MCP pill used to be BOOT-ONCE (set exactly once by
  // bootstrap); re-derive it per flush from the live tools + the health
  // registry so a server that died mid-session shows ✗ (and a load-failed
  // server appears at all). Skipped when nothing would render (threshold
  // parity with the boot behavior — no empty patch churn).
  const downServers = setup.mcpHealth?.downServers()
  const mcpServers = overlayServerHealth(
    deriveMcpPillServers(setup.mcpTools),
    downServers ?? new Map(),
  )
  if (mcpServers.length > 0) {
    setup.lifecyclePills.update({ mcp: { servers: mcpServers } })
  }
  setup.lifecyclePills.flush()
}

const renderTurnError = (error: unknown, statusBar: StatusBar): void => {
  const msg = errMessage(error)
  process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
  statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
}

export const composeTurnSinks = (
  setup: SessionSetupResult,
  state: SurfaceState,
): SessionLoopSinks => {
  const { model, slog, metrics, turnSummary, statusBar } = setup
  return {
    renderTurnDashboard: (): void => {
      if (!metrics) return
      const snap = metrics.snapshot()
      slog.info("metrics.snapshot", { snapshot: snap })
      process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
      foldCostPanelIfWired(setup.costPanel, metrics, state.costDeltaPrev)
    },
    renderAndResetSummary: (outcome): void => {
      state.history = outcome.messages
      const summary = turnSummary.render(outcome as Parameters<typeof turnSummary.render>[0])
      if (summary !== "") process.stderr.write(summary)
      turnSummary.reset()
    },
    flushLifecyclePills: (): void => {
      snapshotAndFlushLifecyclePills(setup)
    },
    renderTurnError: (error): void => renderTurnError(error, statusBar),
  }
}
