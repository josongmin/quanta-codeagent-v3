import { EFFORT_LEVELS, effortToTokenBudget } from "@/agent"
import type { Message } from "@/llm"
import { buildCostDashboard, GEN_AI_ATTRS, renderDashboardText } from "@/observability"
import type { SessionEnvelopeRecord } from "@/session"
import type { ImageQueue } from "../image-queue"
import { env } from "../internal"
import { createPromptHistory, type PromptHistory } from "../prompt-history"
import type { RewindSlashState } from "../rewind-cmd"
import type { StatusBar } from "../status-bar"
import type { SessionLoopSinks } from "./session-loop"
import type { SessionSetupResult } from "./session-setup"
import { buildSkillsCallback } from "./skills-surface"
import { buildReplSlashCtx, type ReplaySlashState } from "./slash-surface"

export interface PromptUxOpts {
  readonly promptHistory?: PromptHistory
  readonly multiline?: boolean
}

/** Slice-C: UX opts (history + multiline) the prompt pipeline consumes.
 *  Default-ON when the env knob is unset; explicit `=0` reverts to the
 *  no-history single-line path. */
export const buildPromptUx = (): PromptUxOpts => {
  const historyEnabled = env("QUANTA_HISTORY", "1") !== "0"
  const historyMax = Math.max(1, Number(env("QUANTA_HISTORY_MAX", "1000")))
  const historyFile = env("QUANTA_HISTORY_FILE", "")
  const promptHistoryOpts: Parameters<typeof createPromptHistory>[0] = {
    maxLines: historyMax,
    ...(historyFile !== "" ? { filePath: historyFile } : {}),
  }
  const promptHistory = historyEnabled ? createPromptHistory(promptHistoryOpts) : undefined
  const multilineEnabled = env("QUANTA_MULTILINE", "1") !== "0"
  return {
    ...(promptHistory !== undefined ? { promptHistory } : {}),
    multiline: multilineEnabled,
  }
}

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

/** Track R — build the `/replay` resolver+iterator pair. Default reader is
 *  lazy-imported so `@/session` is not pulled into the boot path for users
 *  who never type `/replay`. The composer un-wraps the {@link iterateSessionFile}
 *  `Result` shape into a bare `AsyncIterable<SessionEnvelopeRecord>` — decode
 *  errors are silently skipped (the projector inside `/inspect` surfaces
 *  warnings; `/replay` is a one-line-per-event view that simply omits the bad
 *  row). The resolver returns `undefined` when the path doesn't exist so the
 *  command renders "session <id> not found" + exit 1. */
const buildReplaySlashState = (): ReplaySlashState => ({
  resolveSession: async (id: string): Promise<string | undefined> => {
    const { sessionEnvelopePath } = await import("@/session")
    const path = sessionEnvelopePath(id)
    const file = Bun.file(path)
    return (await file.exists()) ? path : undefined
  },
  iterate: (path: string): AsyncIterable<SessionEnvelopeRecord> => {
    const inner = async function* (): AsyncIterable<SessionEnvelopeRecord> {
      const { iterateSessionFile } = await import("@/session")
      for await (const r of iterateSessionFile(path)) {
        if (r.ok) yield r.value
      }
    }
    return inner()
  },
})

export const composeSurfaceSlashCtx = (setup: SessionSetupResult, state: SurfaceState) =>
  buildReplSlashCtx({
    skillsCb: buildSkillsCallback(setup.skillsConfig),
    idleMonitor: setup.idleMonitor,
    imageQueue: state.imageQueue,
    rewindState: state.rewindState,
    mcpSurface: setup.mcpSurface,
    costPanel: setup.costPanel,
    planStore: setup.planStore,
    branchProgress: setup.branchProgress,
    getHistory: () => state.history,
    sessionDeps: setup.sessionDeps,
    abortSignal: setup.abort.signal,
    debugHandle: setup.debugHandle,
    // ADR-0271 — `/why` meta-LLM reasoning query wiring. The REPL
    // surface always has these three (the loop cannot start without an
    // LLMPort or a sessionId), so we never gate this slot.
    llm: setup.llm,
    sessionId: setup.sessionId,
    model: setup.model,
    // Track I — `/inspect` wire. Empty session id ⇒ omit so the slash
    // exits 1 with "no active session" (parity with surface-only cmds
    // needing a session).
    inspect:
      typeof setup.sessionId === "string" && setup.sessionId.length > 0
        ? { sessionId: setup.sessionId }
        : undefined,
    // Track R — `/replay` resolver+iterator (default-ON wire; the slash
    // still 1-arg-required and renders "session not found" when the id
    // doesn't resolve).
    replay: buildReplaySlashState(),
    // `/effort` wire — single seam mutates BOTH the store the loop reads
    // AND the status pill the chrome paints. Defining it inline (vs an
    // installPills callback) keeps the slash adapter the single owner of
    // the "render + persist" pair.
    effort: {
      get: () => setup.effortStore.get(),
      set: (lvl) => {
        setup.effortStore.set(lvl)
        setup.pills.update({ effort: lvl })
      },
      levels: EFFORT_LEVELS,
      budgetTokens: effortToTokenBudget,
    },
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
  setup.lifecyclePills.flush()
}

const renderTurnError = (error: unknown, statusBar: StatusBar): void => {
  const msg = error instanceof Error ? error.message : String(error)
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
