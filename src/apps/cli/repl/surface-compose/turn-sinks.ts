import type { Message } from "@/llm"
import { buildCostDashboard, renderDashboardText } from "@/observability"
import { errMessage } from "@/shared"
import type { ImageQueue } from "../../image-queue"
import { overlayServerHealth } from "../../mcp-health"
import type { RewindSlashState } from "../../rewind-cmd"
import type { StatusBar } from "../../status-bar"
import { deriveMcpPillServers } from "../factories/lifecycle"
import type { SessionLoopSinks } from "../session-loop"
import type { SessionSetupResult } from "../session-setup"

export interface SurfaceState {
  readonly imageQueue: ImageQueue | undefined
  readonly rewindState: RewindSlashState | undefined
  history: readonly Message[]
}

export const createSurfaceState = (args: {
  readonly imageQueue: ImageQueue | undefined
  readonly rewindState: RewindSlashState | undefined
  readonly history: readonly Message[]
}): SurfaceState => ({
  imageQueue: args.imageQueue,
  rewindState: args.rewindState,
  history: args.history,
})

const snapshotAndFlushLifecyclePills = (
  setup: SessionSetupResult,
  live?: { readonly externalQueued: number },
): void => {
  if (setup.lifecycleTaskRegistry !== undefined) {
    const running = setup.lifecycleTaskRegistry.pendingIds().length
    const total = setup.lifecycleTaskRegistry.list().length
    setup.lifecyclePills.update({ subagent: { running, total } })
  }
  // UUX-6-23 — the pill must count BOTH pending-prompt sources: the agent-level
  // follow-up queue (ADR-0037, drained by control-poll) AND the session loop's
  // externalPromptQueue (where mid-turn captured lines wait for the next-turn
  // drain). The loop threads its live count via `live`; reading only the
  // lifecycle queue desynced the pill from a prompt queued mid-turn. Neither
  // source wired ⇒ no patch (legacy byte-identical); `queued: 0` renders
  // nothing, so patching the sum is safe once either source exists.
  if (setup.lifecycleFollowUpQueue !== undefined || live !== undefined) {
    const lifecycleQueued = setup.lifecycleFollowUpQueue?.size() ?? 0
    setup.lifecyclePills.update({
      followUp: { queued: lifecycleQueued + (live?.externalQueued ?? 0) },
    })
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
      // A3-S1 — the turn count is a UI fact and must not hide behind the
      // metrics guard: a metrics-less session still has turns.
      setup.costPanel?.noteTurn()
      if (!metrics) return
      const snap = metrics.snapshot()
      slog.info("metrics.snapshot", { snapshot: snap })
      process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
    },
    renderAndResetSummary: (outcome): void => {
      state.history = outcome.messages
      const summary = turnSummary.render(outcome as Parameters<typeof turnSummary.render>[0])
      if (summary !== "") process.stderr.write(summary)
      turnSummary.reset()
    },
    flushLifecyclePills: (live): void => {
      snapshotAndFlushLifecyclePills(setup, live)
    },
    renderTurnError: (error): void => renderTurnError(error, statusBar),
  }
}
