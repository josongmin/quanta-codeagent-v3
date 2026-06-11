import type { AtCandidateProvider } from "../at-autocomplete"
import { DEFAULT_IDLE_MS, type IdleMonitor } from "../idle-monitor"
import type { ImageQueue } from "../image-queue"
import type { KeybindingMap } from "../keybindings/types"
import type { NotificationPort } from "../notify"
import type { PromptHistory } from "../prompt-history"
import { AbortError, readLine } from "../raw-line-reader"
import type { ExternalEditorPort } from "../raw-line-reader-editor"
import { DEFAULT_THRESHOLD, type RejectCounter } from "../reject-counter"
import { idleBanner, rejectExitBanner } from "../repl-banners"
import { describeSlashCommand, slashCompleter } from "../slash-commands"
import type { StatusBar } from "../status-bar"
import { renderInboxPreamble, type TextInbox } from "../text-inbox"
import type { ExternalPromptQueue } from "./external-prompt-queue"
import type { CliPromptInput, CliPromptSource } from "./prompt-types"

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
  /** RFC-12 / ADR-0439 — optional `@`-mention autocomplete provider. When
   *  present, the raw-line reader opens an `@`-completion dropdown; absent ⇒
   *  `@` is an ordinary char (byte-identical). */
  readonly atProvider?: AtCandidateProvider
  /** RFC-08 / ADR-0443 — initial pill+desc meta line (under the prompt) +
   *  the shift+tab cycle hook. Built together off one ModeCycleStore; both
   *  absent ⇒ no meta row, shift+tab ignored (byte-identical). */
  readonly modeMeta?: string
  readonly onCycleMode?: () => { meta?: string } | undefined
  /** RFC-11 / ADR-0446 — external `$EDITOR` composition port. When present,
   *  `ctrl+x ctrl+e` opens the draft in `$EDITOR`. Absent ⇒ byte-identical. */
  readonly openEditor?: ExternalEditorPort
  /** RFC-11 / ADR-0447 — loaded keybinding map (merged over defaults). When
   *  present, keys remap to bound actions. Absent ⇒ byte-identical. */
  readonly keybindings?: KeybindingMap
  /** jun-6 (Codex paste-burst) — large-paste coalescing. When present
   *  (`{ minChars }`), a paste of ≥minChars chars echoes a `[Pasted Content N
   *  chars]` placeholder while the full text still submits. Built at the host
   *  from the `QUANTA_PASTE_BURST` knob; absent ⇒ paste echoes inline
   *  (byte-identical). */
  readonly pasteBurst?: { readonly minChars: number }
  /** #10 (jun-11) — bracketed-paste mode. When `true`, the raw-line reader
   *  enables DECSET 2004 so a multi-line paste accumulates into one buffer
   *  instead of submitting at its first embedded newline. Built at the host from
   *  the `QUANTA_BRACKETED_PASTE` CLI gate; absent ⇒ byte-identical (a pasted
   *  newline still early-submits, the legacy behavior). */
  readonly bracketedPaste?: boolean
}

type PromptLineReader = (
  signal: AbortSignal | undefined,
  ux: PromptPipelineUxOpts | undefined,
) => Promise<string | null>

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
  /** ADR-0291 — optional text inbox. When wired + non-empty on an accepted
   *  local prompt, drain on every accepted prompt and prepend the inbox
   *  preamble to the user's literal text. Empty ⇒ no preamble, no
   *  allocation beyond the dep slot (byte-identical to absent inbox). */
  readonly textInbox?: TextInbox
  /** Optional out-of-band prompt ingress (reactor/scheduler). When present,
   *  `next()` races the raw-line reader against this queue so a background
   *  wake can resolve the prompt loop without synthetic stdin writes. */
  readonly externalPromptQueue?: ExternalPromptQueue
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
  /** Optional hook fired only for LOCAL accepted prompts (not external
   *  reactor/scheduler wakes). Lets the host keep the quiet-window anchor
   *  authoritative without conflating self-wake with human input. */
  readonly onLocalPromptAccepted?: () => void
  /** Narrow test seam for local input classification. Undefined keeps the
   *  raw-line-reader runtime path byte-identical. */
  readonly readPromptLine?: PromptLineReader
  /** RFC-09 (A) — completion-notify port. When present, the idle gate fires
   *  `onIdleAwaitingInput` ONCE on idle entry (latched) and `markActive` on
   *  every accepted prompt (latch reset). Absent ⇒ no notify calls
   *  (byte-identical). */
  readonly notify?: NotificationPort
  /** RFC-09 (A) — short cwd label for the idle-notify title. Only read when
   *  `notify` is present. */
  readonly notifyCwdBasename?: string
  /** RFC-09 (B) — pre-compaction warning provider. Called just BEFORE the
   *  prompt is painted; a non-empty string is written as a one-line preamble
   *  (inbox-preamble idiom). Absent / returns `""` ⇒ no preamble
   *  (byte-identical). */
  readonly contextWarning?: () => string
}

/** Read one trimmed line from the raw-mode reader. Returns `null` on
 *  AbortError (the prompt was aborted via `signal`). Other exceptions
 *  propagate to the caller. */
const defaultPromptLineReader: PromptLineReader = async (
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
      ...(ux?.atProvider !== undefined ? { atProvider: ux.atProvider } : {}),
      ...(ux?.modeMeta !== undefined ? { meta: ux.modeMeta } : {}),
      ...(ux?.onCycleMode !== undefined ? { onCycleMode: ux.onCycleMode } : {}),
      ...(ux?.openEditor !== undefined ? { openEditor: ux.openEditor } : {}),
      ...(ux?.keybindings !== undefined ? { keybindings: ux.keybindings } : {}),
      ...(ux?.pasteBurst !== undefined ? { pasteBurst: ux.pasteBurst } : {}),
      ...(ux?.bracketedPaste === true ? { bracketedPaste: true } : {}),
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
  readPromptLine: PromptLineReader,
): Promise<string | null | undefined> => {
  const input = await readPromptLine(signal, ux)
  if (input === null) return null
  if (input === "/exit" || input === "/quit") return null
  const handled = input === "" || (await dispatchSlash(input))
  if (handled) {
    process.stderr.write("\n")
    return undefined
  }
  return input
}

/** CLI prompt-source adapter for the runtime-SDK backed interactive loop.
 *  Wraps the raw-mode line reader + resolves `/exit` + in-REPL slash
 *  dispatch + blank-line behavior inline — the loop only sees clean
 *  prompt strings (or `null` for loop exit). */
const buildCliPromptSource = (
  dispatchSlash: DispatchSlash,
  imageQueue: ImageQueue | undefined,
  textInbox: TextInbox | undefined,
  externalPromptQueue: ExternalPromptQueue | undefined,
  ux: PromptPipelineUxOpts | undefined,
  onLocalPromptAccepted: (() => void) | undefined,
  readPromptLine: PromptLineReader,
): CliPromptSource => ({
  next: async (signal) => {
    while (signal?.aborted !== true) {
      const next = await readNextPrompt({
        signal,
        dispatchSlash,
        imageQueue,
        textInbox,
        externalPromptQueue,
        ux,
        onLocalPromptAccepted,
        readPromptLine,
      })
      if (next === undefined) continue
      if (next === null) return null
      return next
    }
    return null
  },
})

const combineSignals = (
  signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined => {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

const localPayload = (
  text: string,
  imageQueue: ImageQueue | undefined,
  textInbox: TextInbox | undefined,
): CliPromptInput => {
  // ADR-0291 — drain the text inbox FIRST so the slash-side enqueue ("/web",
  // "/paste") sees its content on the very next turn. The preamble is empty
  // when the inbox is empty so this is byte-identical when the inbox is
  // never used.
  const inboxEntries = textInbox?.drain() ?? []
  const preamble = renderInboxPreamble(inboxEntries)
  const fullText = preamble === "" ? text : `${preamble}${text}`
  const queued = imageQueue?.drain() ?? []
  if (queued.length === 0) return fullText
  return { text: fullText, images: queued.map((entry) => entry.block) }
}

const readNextPrompt = async (args: {
  readonly signal: AbortSignal | undefined
  readonly dispatchSlash: DispatchSlash
  readonly imageQueue: ImageQueue | undefined
  readonly textInbox: TextInbox | undefined
  readonly externalPromptQueue: ExternalPromptQueue | undefined
  readonly ux: PromptPipelineUxOpts | undefined
  readonly onLocalPromptAccepted: (() => void) | undefined
  readonly readPromptLine: PromptLineReader
}): Promise<CliPromptInput | null | undefined> => {
  const {
    signal,
    dispatchSlash,
    imageQueue,
    textInbox,
    externalPromptQueue,
    ux,
    onLocalPromptAccepted,
    readPromptLine,
  } = args
  if (externalPromptQueue === undefined) {
    const next = await classifyReplLine(signal, dispatchSlash, ux, readPromptLine)
    if (typeof next !== "string") return next
    onLocalPromptAccepted?.()
    return localPayload(next, imageQueue, textInbox)
  }

  const localAbort = new AbortController()
  const externalAbort = new AbortController()
  const abortLocal = (): void => localAbort.abort()
  const abortExternal = (): void => externalAbort.abort()
  signal?.addEventListener("abort", abortLocal, { once: true })
  signal?.addEventListener("abort", abortExternal, { once: true })
  try {
    const winner = await Promise.race([
      classifyReplLine(
        combineSignals([signal, localAbort.signal]),
        dispatchSlash,
        ux,
        readPromptLine,
      ).then((value) => ({
        source: "local" as const,
        value,
      })),
      externalPromptQueue.next(combineSignals([signal, externalAbort.signal])).then((value) => ({
        source: "external" as const,
        value,
      })),
    ])
    if (winner.source === "local") {
      externalAbort.abort()
      if (typeof winner.value !== "string") return winner.value
      onLocalPromptAccepted?.()
      return localPayload(winner.value, imageQueue, textInbox)
    }
    localAbort.abort()
    return winner.value
  } finally {
    signal?.removeEventListener("abort", abortLocal)
    signal?.removeEventListener("abort", abortExternal)
  }
}

/** Wrap an inner CLI {@link PromptSource} with the Cursor-inspired idle /
 *  snooze gate + reject-counter graceful exit. */
const wrapPromptSourceWithIdleGate = (args: {
  readonly inner: CliPromptSource
  readonly idle: IdleMonitor
  readonly rejects: RejectCounter
  readonly statusBar: StatusBar
  readonly notify?: NotificationPort
  readonly notifyCwdBasename?: string
  readonly contextWarning?: () => string
}): CliPromptSource => {
  const { inner, idle, rejects, statusBar, notify, notifyCwdBasename, contextWarning } = args
  const paintGateBanners = (): void => {
    if (idle.isSnoozed()) {
      statusBar.transient("⏸ snoozed — type /resume to wake", 4000)
      process.stderr.write("[snoozed — type /resume to wake, or wait for the snooze window]\n")
      return
    }
    if (idle.isIdle()) {
      // #22 — interpolate the RESOLVED idle threshold (not a hardcoded "60s")
      // so the banner number matches the gate the monitor actually enforces.
      statusBar.transient(idleBanner(idle.thresholdMs ?? DEFAULT_IDLE_MS), 3000)
      // RFC-09 (A) — input-needed notify. The adapter latches so a long idle
      // wait fires exactly ONCE; `markActive` on the next accepted prompt
      // resets the latch. Absent ⇒ no-op (byte-identical).
      notify?.onIdleAwaitingInput({ cwdBasename: notifyCwdBasename ?? "" })
    }
  }
  const readOneGated = async (signal?: AbortSignal): Promise<CliPromptInput | null | undefined> => {
    if (rejects.shouldAutoExit()) {
      // #22 — interpolate the RESOLVED reject limit (not a hardcoded "20").
      process.stderr.write(rejectExitBanner(rejects.limit ?? DEFAULT_THRESHOLD))
      return null
    }
    paintGateBanners()
    // RFC-09 (B) — pre-compaction warning preamble. Same "prompt-front
    // preamble" slot as the inbox preamble; `""` ⇒ no write (byte-identical).
    const warn = contextWarning?.() ?? ""
    if (warn !== "") process.stderr.write(`${warn}\n`)
    const next = await inner.next(signal)
    if (next === null) return null
    if (idle.isSnoozed()) {
      process.stderr.write("(snoozed — input declined; type /resume to wake)\n")
      return undefined
    }
    idle.markActive()
    // RFC-09 (A) — a prompt was accepted ⇒ reset the idle notify latch so the
    // NEXT idle wait notifies again. Absent ⇒ no-op.
    notify?.markActive()
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
 *  to the runtime-sdk backed session loop without further wrapping. */
export const composePromptPipeline = (deps: ComposePromptPipelineDeps): CliPromptSource => {
  const inner = buildCliPromptSource(
    deps.dispatchSlash,
    deps.imageQueue,
    deps.textInbox,
    deps.externalPromptQueue,
    deps.ux,
    deps.onLocalPromptAccepted,
    deps.readPromptLine ?? defaultPromptLineReader,
  )
  return wrapPromptSourceWithIdleGate({
    inner,
    idle: deps.idleMonitor,
    rejects: deps.rejectCounter,
    statusBar: deps.statusBar,
    ...(deps.notify !== undefined ? { notify: deps.notify } : {}),
    ...(deps.notifyCwdBasename !== undefined ? { notifyCwdBasename: deps.notifyCwdBasename } : {}),
    ...(deps.contextWarning !== undefined ? { contextWarning: deps.contextWarning } : {}),
  })
}
