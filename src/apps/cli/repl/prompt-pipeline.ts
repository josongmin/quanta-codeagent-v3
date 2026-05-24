import type { PromptPayload, PromptSource } from "@/runner"
import type { IdleMonitor } from "../idle-monitor"
import type { ImageQueue } from "../image-queue"
import type { PromptHistory } from "../prompt-history"
import { AbortError, readLine } from "../raw-line-reader"
import type { RejectCounter } from "../reject-counter"
import { describeSlashCommand, slashCompleter } from "../slash-commands"
import type { StatusBar } from "../status-bar"

/** Slice-C: surface-stateful slash dispatch is OUT of this module. The
 *  pipeline is given a single `dispatchSlash` callback that returns `true`
 *  iff the input was routed (caller `continue`s) and `false` iff the input
 *  must be forwarded to the model. The host owns the actual slash-context
 *  composition; the pipeline only KNOWS whether a slash hit. */
export type DispatchSlash = (input: string) => Promise<boolean>

/** UX-only knobs the raw-line reader consumes. Default off when undefined
 *  ⇒ behavior matches the no-history single-line path byte-identically. */
export interface PromptPipelineUxOpts {
  readonly promptHistory?: PromptHistory
  readonly multiline?: boolean
}

/** Dependencies for {@link composePromptPipeline}. Every dep is EXPLICIT so
 *  the pipeline owns ZERO closure captures over the surface state — the
 *  host can swap any field without re-allocating the prompt source. */
export interface ComposePromptPipelineDeps {
  /** Try to handle `input` as an in-REPL slash command. Returns true iff
   *  the input was routed (the pipeline `continue`s); false ⇒ the pipeline
   *  forwards the input as the next user turn. */
  readonly dispatchSlash: DispatchSlash
  /** Optional image queue. When wired + non-empty, drain on every accepted
   *  prompt and attach the images to THAT turn's payload (PromptPayload
   *  `{ text, images }`); empty ⇒ plain string form (byte-identical). */
  readonly imageQueue?: ImageQueue
  /** Idle/snooze gate (Cursor §4.1). Drives the snooze hint banners + the
   *  `markActive()` call after each accepted line. */
  readonly idleMonitor: IdleMonitor
  /** Consecutive-denial graceful auto-exit (Cursor §4.2). When the
   *  threshold trips, the pipeline returns `null` from `next()` so the
   *  driver tears down the loop without `process.exit` (the `finally` of
   *  `runRepl` still shuts MCP + the status bar). */
  readonly rejectCounter: RejectCounter
  /** Status bar handle for the snooze hint paint. */
  readonly statusBar: StatusBar
  /** UX-only knobs (history, multiline). Default off ⇒ byte-identical to
   *  the single-line no-history path. */
  readonly ux?: PromptPipelineUxOpts
}

/** Read one trimmed line from the raw-mode reader. Returns `null` on
 *  AbortError (the prompt was aborted via `signal`). Other exceptions
 *  propagate to the caller. */
const readReplLine = async (
  signal: AbortSignal | undefined,
  ux?: PromptPipelineUxOpts,
): Promise<string | null> => {
  try {
    const raw = await readLine({
      prompt: "› ",
      completer: (line) => slashCompleter(line)[0],
      describe: describeSlashCommand,
      ...(signal !== undefined ? { signal } : {}),
      ...(ux?.promptHistory !== undefined ? { history: ux.promptHistory } : {}),
      ...(ux?.multiline === true ? { multiline: true } : {}),
    })
    return raw.trim()
  } catch (e) {
    if (e instanceof AbortError) return null
    throw e
  }
}

/** Read one REPL line and classify it: `null` ⇒ loop exit, `undefined` ⇒
 *  caller should keep looping (blank line or in-REPL slash handled here),
 *  `string` ⇒ forward as the next user prompt. */
const classifyReplLine = async (
  signal: AbortSignal | undefined,
  dispatchSlash: DispatchSlash,
  ux: PromptPipelineUxOpts | undefined,
): Promise<string | null | undefined> => {
  const input = await readReplLine(signal, ux)
  if (input === null) return null
  if (input === "/exit" || input === "/quit") return null
  const handled = input === "" || (await dispatchSlash(input))
  if (handled) {
    process.stderr.write("\n")
    return undefined
  }
  return input
}

/** CLI `PromptSource` adapter for the Layer-2 `runInteractive` driver.
 *  Wraps the raw-mode line reader + resolves `/exit` + in-REPL slash
 *  dispatch + blank-line behavior inline — the driver only sees clean
 *  prompt strings (or `null` for loop exit). */
const buildCliPromptSource = (
  dispatchSlash: DispatchSlash,
  imageQueue: ImageQueue | undefined,
  ux: PromptPipelineUxOpts | undefined,
): PromptSource => ({
  next: async (signal) => {
    while (signal?.aborted !== true) {
      const next = await classifyReplLine(signal, dispatchSlash, ux)
      if (next === undefined) continue
      if (next === null) return null
      const queued = imageQueue?.drain() ?? []
      if (queued.length === 0) return next
      return { text: next, images: queued.map((e) => e.block) }
    }
    return null
  },
})

/** Wrap an inner CLI {@link PromptSource} with the Cursor-inspired idle /
 *  snooze gate + reject-counter graceful exit. */
const wrapPromptSourceWithIdleGate = (args: {
  readonly inner: PromptSource
  readonly idle: IdleMonitor
  readonly rejects: RejectCounter
  readonly statusBar: StatusBar
}): PromptSource => {
  const { inner, idle, rejects, statusBar } = args
  const paintGateBanners = (): void => {
    if (idle.isSnoozed()) {
      statusBar.transient("⏸ snoozed — type /resume to wake", 4000)
      process.stderr.write("[snoozed — type /resume to wake, or wait for the snooze window]\n")
      return
    }
    if (idle.isIdle()) {
      statusBar.transient("[idle 60s — auto-paused. type or /resume]", 3000)
    }
  }
  const readOneGated = async (signal?: AbortSignal): Promise<PromptPayload | null | undefined> => {
    if (rejects.shouldAutoExit()) {
      process.stderr.write("\n[20 consecutive denials — exiting. To re-enable, restart quanta]\n")
      return null
    }
    paintGateBanners()
    const next = await inner.next(signal)
    if (next === null) return null
    if (idle.isSnoozed()) {
      process.stderr.write("(snoozed — input declined; type /resume to wake)\n")
      return undefined
    }
    idle.markActive()
    return next
  }
  return {
    next: async (signal) => {
      while (signal?.aborted !== true) {
        const out = await readOneGated(signal)
        if (out === null) return null
        if (out !== undefined) return out
      }
      return null
    },
  }
}

/** Compose the full CLI prompt pipeline: raw line reader ➜ slash short-
 *  circuit ➜ image queue drain ➜ idle/snooze gate ➜ reject auto-exit.
 *  Single entry point — the host passes the constructed pipeline straight
 *  to `runInteractive.promptSource` without further wrapping. */
export const composePromptPipeline = (deps: ComposePromptPipelineDeps): PromptSource => {
  const inner = buildCliPromptSource(deps.dispatchSlash, deps.imageQueue, deps.ux)
  return wrapPromptSourceWithIdleGate({
    inner,
    idle: deps.idleMonitor,
    rejects: deps.rejectCounter,
    statusBar: deps.statusBar,
  })
}
