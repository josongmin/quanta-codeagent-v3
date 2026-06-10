import { attrs, endSpan, SPAN_NAMES, type Span, startSpan } from "@/observability"
import { withEgressProxy } from "@/runtime/network-proxy"
import { attachLspDiagnosticsHookIfEnabled } from "../lsp-bridge"
import { runMemoryConsolidatorHook } from "../memory-consolidator-hook"
import { sessionSpanAttrs } from "../session-resources"
import { completedCategory, interruptedCategory } from "../stop-category"
import type { AgentConfig, AgentOutcome } from "../types"
import { createRunAgentContext } from "./session-bootstrap"
import { runSessionStartSequence } from "./session-lifecycle"
import { runAgentTurnLoop } from "./turn-loop"

export const runAgent = async (config: AgentConfig): Promise<AgentOutcome> => {
  const sessionId = config.sessionId ?? "default"
  const sessionSpan: Span = startSpan(SPAN_NAMES.sessionLoop, sessionSpanAttrs(sessionId))
  let spanStatus: "ok" | "error" | "aborted" = "ok"
  try {
    const outcome = await runAgentInnerWithEgressProxy(config)
    spanStatus =
      outcome.reason === "aborted" ? "aborted" : outcome.reason === "error" ? "error" : "ok"
    if (spanStatus === "ok") {
      const consolidate = (): Promise<unknown> =>
        runMemoryConsolidatorHook(
          {
            sessionOk: true,
            consolidator: config.memoryConsolidator,
            sessionId: config.sessionId,
            rolloutMessages: outcome.messages,
            turnCount: outcome.turns,
            ...(config.stage1OutputsStore !== undefined
              ? { stage1OutputsStore: config.stage1OutputsStore }
              : {}),
            signal: config.signal,
          },
          (event) => {
            if (event.kind === "error") {
              config.stream.emit({
                type: "error",
                message: `memory consolidator hook failed: ${event.message}`,
              })
            }
          },
        )
      // Phase-1 distill is a full-rollout LLM call (tens of seconds on a large
      // transcript). When the host wired a `defer` lane, hand the run off so
      // the outcome — and with it the surface's turn-completion path (spinner,
      // turn summary, input re-enable) — is not held hostage by memory
      // bookkeeping. The lane owner drains before closing the stage-1 store.
      const deferLane = config.memoryConsolidator?.defer
      if (deferLane !== undefined) deferLane(consolidate)
      else await consolidate()
    }
    return outcome
  } catch (e) {
    spanStatus = "error"
    throw e
  } finally {
    endSpan(sessionSpan, spanStatus, attrs({}))
  }
}

export const runAgentInnerWithEgressProxy = (config: AgentConfig): Promise<AgentOutcome> =>
  withEgressProxy(config.networkProxy, (ctx) =>
    runAgentInner(
      ctx.proxyEnv.address !== undefined ? { ...config, proxyEnv: ctx.proxyEnv } : config,
    ),
  )

export const runAgentInner = async (config: AgentConfig): Promise<AgentOutcome> => {
  const ctx = await createRunAgentContext(config)
  const diagnosticsHook = attachLspDiagnosticsHookIfEnabled(ctx.cfg)
  try {
    const startOutcome = await runSessionStartSequence({
      cfg: ctx.cfg,
      wm: ctx.wm,
      sessionId: ctx.sessionId,
      taskRegistry: ctx.features.taskRegistry,
    })
    if (startOutcome === "aborted") {
      return ctx.finish("aborted", 0, interruptedCategory("user"))
    }
    const finished = await runAgentTurnLoop(ctx)
    if (finished !== undefined) {
      return finished
    }
    return ctx.finish("max_turns", ctx.cfg.maxTurns, completedCategory("max_turns"))
  } finally {
    await diagnosticsHook?.dispose()
    await ctx.features.browserDispose?.().catch(() => {})
    await ctx.features.appshotDispose?.().catch(() => {})
  }
}
