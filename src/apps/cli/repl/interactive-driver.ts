import { type RunInteractiveInput, runInteractive } from "@/runner"
import type { IdleMonitor } from "../idle-monitor"
import type { ImageQueue } from "../image-queue"
import { assembleConfig, env } from "../internal"
import { createPromptHistory } from "../prompt-history"
import type { SkillRow } from "../slash-commands"
import type { ReplContext } from "./assemble-context"
import { buildImageQueue } from "./image-queue-wire"
import { wrapPromptSourceWithIdleGate } from "./idle-wire"
import { snapshotAndFlushLifecyclePills } from "./lifecycle-wire"
import { buildCliPromptSource } from "./prompt-source"
import { buildSkillsCallback } from "./skills-callback"
import { installTurnCancel } from "./turn-cancel"
import { renderTurnDashboard, renderTurnError } from "./turn-render"

/** Build the optional bash-style prompt history. Default ON
 *  (QUANTA_HISTORY=0 to disable). Path/max overridable via env. */
const buildPromptHistory = (): ReturnType<typeof createPromptHistory> | undefined => {
  const historyEnabled = env("QUANTA_HISTORY", "1") !== "0"
  if (!historyEnabled) return undefined
  const historyMax = Math.max(1, Number(env("QUANTA_HISTORY_MAX", "1000")))
  const historyFile = process.env.QUANTA_HISTORY_FILE
  const promptHistoryOpts: Parameters<typeof createPromptHistory>[0] = {
    maxLines: historyMax,
    ...(historyFile !== undefined ? { filePath: historyFile } : {}),
  }
  return createPromptHistory(promptHistoryOpts)
}

/** Build the slash-command context the prompt source passes through on each
 *  in-REPL `/<cmd>` dispatch (skills callback + idle monitor + image queue). */
const buildSlashCtx = (
  ctx: ReplContext,
  imageQueue: ImageQueue | undefined,
): Partial<{
  skills: () => Promise<SkillRow[]>
  idle: IdleMonitor
  imageQueue: ImageQueue
}> => {
  const skillsCb = buildSkillsCallback(ctx.skillsConfig)
  return {
    ...(skillsCb !== undefined ? { skills: skillsCb } : {}),
    idle: ctx.idleMonitor,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
  }
}

/** Build the per-turn `wrapTurn` hook passed to `runInteractive`. Mirrors the
 *  prior in-`runRepl` closure body byte-identically — Esc-Esc cancel
 *  install/dispose, runOnce dispatch, cost dashboard + turn-summary panel,
 *  REPL-survives-on-error semantics. */
type WrapTurn = NonNullable<RunInteractiveInput["wrapTurn"]>
const buildWrapTurn = (ctx: ReplContext): WrapTurn => {
  const { abort, statusBar, sessionDeps, turnSummary, metrics, model, slog } = ctx
  return async (run) => {
    const turnAbort = new AbortController()
    const turnSignal = AbortSignal.any([abort.signal, turnAbort.signal])
    const cancel = installTurnCancel(turnAbort, abort, statusBar)
    let result: Awaited<ReturnType<typeof run>> | undefined
    try {
      result = await run({ ...sessionDeps, signal: turnSignal })
      renderTurnDashboard(metrics, model, slog)
      const summary = turnSummary.render(result.outcome)
      if (summary !== "") process.stderr.write(summary)
      turnSummary.reset()
    } catch (e) {
      if (!(turnAbort.signal.aborted && !abort.signal.aborted)) {
        renderTurnError(e, statusBar)
      }
      result = undefined
    } finally {
      cancel.dispose()
      turnSummary.reset()
    }
    process.stderr.write("\n")
    return result
  }
}

/** Drive the interactive REPL via the Layer-2 `runInteractive` driver.
 *  Composes the prompt source (raw-line reader + slash + idle gate), wires
 *  the per-turn `wrapTurn` hook (Esc-Esc + dashboard + survives-on-error),
 *  and the `onTurnEnd` hook (history sync + lifecycle pills flush).
 *
 *  Byte-identical relocation of the `else` branch of the argv-prompt
 *  dispatch inside `runRepl`. */
export const runInteractiveRepl = async (ctx: ReplContext): Promise<void> => {
  const {
    abort,
    statusBar,
    sessionDeps,
    pills,
    lifecyclePills,
    lifecycleTaskRegistry,
    lifecycleFollowUpQueue,
    state,
    idMeta,
  } = ctx

  // Pills dispose first so any late paint cannot resurrect a stale row
  // AFTER the scroll region is reset.
  process.once("exit", () => {
    pills.dispose()
    statusBar.teardown()
  })

  // ADR-0083 multi-modal: per-REPL image queue. Default-ON; disabled
  // entirely via `QUANTA_IMAGE_QUEUE=0` so a paranoid surface can keep
  // the original text-only path (`/image …` then prints unknown
  // command). Capacity from `QUANTA_IMAGE_MAX_QUEUE` (default 5).
  const imageQueue: ImageQueue | undefined = buildImageQueue()

  const slashCtx = buildSlashCtx(ctx, imageQueue)
  const promptHistory = buildPromptHistory()
  const multilineEnabled = env("QUANTA_MULTILINE", "1") !== "0"

  // Initial blank row matches the prior `runReplLoopRaw` header write so
  // the very first composer row sits one line below the resume log.
  process.stderr.write("\n")

  const innerPromptSource = buildCliPromptSource(slashCtx, {
    ...(promptHistory !== undefined ? { promptHistory } : {}),
    multiline: multilineEnabled,
  })
  const cliPromptSource = wrapPromptSourceWithIdleGate({
    inner: innerPromptSource,
    idle: ctx.idleMonitor,
    rejects: ctx.rejectCounter,
    statusBar,
  })

  await runInteractive({
    deps: sessionDeps,
    assembleConfig,
    promptSource: cliPromptSource,
    history: ctx.history,
    state,
    idMeta,
    signal: abort.signal,
    seedImages: ctx.pendingImages,
    wrapTurn: buildWrapTurn(ctx),
    onTurnEnd: ({ messages }) => {
      ctx.history = messages
      snapshotAndFlushLifecyclePills(lifecyclePills, lifecycleTaskRegistry, lifecycleFollowUpQueue)
    },
  })
}
