import type { HookPromptInject } from "../hooks"
import type { TurnSession, TurnState } from "../turn-context"
import { prepareTurnContext } from "./context-assembler"
import { applyAction, EMPTY_TOOL_HISTORY, resolveTurnAction } from "./recovery-executor"
import { resolveActiveModelId } from "./skill-gate"
import { streamConsume } from "./stream-consume"
import { buildTurnSessionView, classifyTurnAbort } from "./turn-gate"
import type { TurnResult } from "./types"

export const runTurn = async (
  turn: number,
  session: TurnSession,
  state: TurnState,
): Promise<TurnResult> => {
  const { config, recorder, activeSkills, archive, hookPromptPending, bgCompaction } = session
  const { wm, rec, breaker, toolHistory, workingState, citations } = state
  const { turnSession, gate } = buildTurnSessionView(session)
  const turnConfig = turnSession.config
  const turnInjects: readonly HookPromptInject[] | undefined =
    hookPromptPending !== undefined && hookPromptPending.length > 0
      ? [...hookPromptPending]
      : undefined
  if (hookPromptPending !== undefined) hookPromptPending.length = 0
  for (;;) {
    if (config.signal.aborted || gate?.wasInterrupted() === true) {
      bgCompaction?.cancelIfPending()
      return classifyTurnAbort(gate, config.signal)
    }
    // D4 (jun-7) — resolve the model that will ACTUALLY process this turn
    // (sticky-model / skill override), so compaction's window threshold tracks
    // the ACTIVE model, not the base `config.llm`. Resolved here, before
    // compaction; `streamConsume` re-resolves the full `turnLlm` for the stream.
    const activeModel = await resolveActiveModelId(turnConfig, session.skillGate?.activeOverride())
    const { ctx, breakerVerdict } = await prepareTurnContext(
      turnConfig,
      wm,
      recorder,
      breaker,
      activeSkills,
      workingState,
      archive,
      turn,
      citations,
      turnInjects,
      state.taskSpend,
      bgCompaction,
      state.tokenBaseline,
      activeModel,
    )
    if (breakerVerdict.abort) return { kind: "error", reason: breakerVerdict.reason }
    const result = await streamConsume(turnSession, state, ctx)
    if ("aborted" in result) return classifyTurnAbort(gate, config.signal)
    const action = resolveTurnAction(turnConfig.stopReasonPolicy, result, rec)
    const step = await applyAction(
      turnSession,
      state,
      action,
      result,
      ctx.system,
      toolHistory ?? EMPTY_TOOL_HISTORY,
    )
    if (step.done) return step.result
  }
}
