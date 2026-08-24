/**
 * In-REPL `/voice` subcommand handler (ADR-0208).
 *
 * S3 voice slice: a 4-vendor convergence absorption of Claude desktop's
 * `/voice` (Deepgram), Aider's `/voice` (Whisper), Windsurf voice input,
 * and Codex realtime WebRTC. quanta absorbs the STRUCTURAL surface (port
 * + adapters + slash) without committing to any single vendor — each
 * adapter is opt-in via env at construction time.
 *
 * Slice discipline:
 *   - Runs in `apps/cli` only.
 *   - Imports only `@/voice` (recorder + transcriber ports + adapters)
 *     and `@/agent/plan-queue` types (read-only — we instantiate no new
 *     plan-queue, the surface owns it; we call its public `enqueue`).
 *   - `out`/`err` are injected ports so tests don't touch stdio.
 *   - Default-OFF: when `ctx.recorder` is undefined (the surface didn't
 *     wire a backend), the slash prints "voice backend missing" + a
 *     `hint:` line and exits 1. Surfaces that DO wire `recorder` but skip
 *     `transcriber` are refused BEFORE any audio is captured (exit 1 +
 *     hint) — the pre-fix flow recorded, printed the byte count, threw
 *     the audio away and exited 0 (UUX-6-27's capture-then-exit-0 lie;
 *     fixed under D-9 / UUX-2-05 + UUX-1-10).
 *
 * Subcommands:
 *   - `/voice` — start recording; press Enter to stop, Esc to cancel.
 *     The captured transcript is enqueued into the plan-queue (if
 *     wired) as a `voice_transcript` follow-up that the next turn
 *     drains.
 *   - `/voice status` — print recorder backend + transcriber selection.
 *   - `/voice cancel` — abort the in-flight recording (no-op when none
 *     active).
 *
 * Confirm-always: the transcript is ALWAYS prefilled/enqueued — never
 * auto-submitted. ADR-0202's HELL-VC-01 invariant carries over to this
 * sibling slice; surfaces MUST surface the transcript to the user
 * before any send.
 */

import type { PlanQueueStore } from "@/agent/plan-queue"
import type { AudioRecorderPort } from "@/voice"
import type {
  TranscribeReq,
  TranscriberError,
  TranscriberPort,
  VoiceTranscript,
} from "@/voice/transcriber"

/** Subset of {@link PlanQueueStore} the slash command depends on. Keeps
 *  the ctx port minimal so tests inject a tiny shim without building
 *  the full store. */
export interface VoiceQueueSink {
  enqueue(input: {
    readonly threadId: string
    readonly text: string
    readonly source: "voice_transcript"
    readonly pausedReason: "other"
    readonly arrivedDuringTurn: number
    readonly urgent: boolean
    readonly metadata: Readonly<Record<string, string>>
    readonly label?: string
  }): { readonly id: string; readonly collapsed: boolean }
}

/** Reader port — abstracts whether the surface uses readline / raw-mode
 *  keypress / web-postmessage. Returns `"enter"` when the user wants to
 *  stop AND transcribe, `"esc"` when the user wants to cancel + discard,
 *  or `null` when the stream closed unexpectedly. */
export interface VoiceKeyReader {
  awaitStopOrCancel(signal: AbortSignal): Promise<"enter" | "esc" | null>
}

export interface VoiceCmdCtx {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
  /** Optional recorder backend. When omitted, slash prints the
   *  backend-missing message and exits 1 — explicit default-OFF gate. */
  readonly recorder?: AudioRecorderPort
  /** Optional transcriber. When the surface wired the recorder but didn't
   *  wire a transcriber (no API key), `/voice` REFUSES to record (exit 1 +
   *  hint) — capturing audio that could only be discarded was the UUX-6-27
   *  false success. `/voice status` still reports the wire state. */
  readonly transcriber?: TranscriberPort
  /** Optional plan-queue sink. When wired, the transcript is enqueued
   *  as a `voice_transcript` follow-up the next turn drains. When
   *  unwired, the transcript is printed to stdout so the user can copy. */
  readonly planQueue?: VoiceQueueSink
  /** Thread id for the enqueue. When omitted, defaults to
   *  `"default"` — the surface SHOULD inject the active session id. */
  readonly threadId?: string
  /** Current turn index for the enqueue's `arrivedDuringTurn` field.
   *  Defaults to 0. */
  readonly currentTurn?: number
  /** Default language hint (`-l` / vendor `?language=`). When omitted,
   *  the transcriber auto-detects. */
  readonly language?: string
  /** Keypress reader. When omitted, the slash records for a fixed
   *  duration (`fixedDurationMs`) before stopping — useful for tests
   *  + headless surfaces that can't capture keystrokes. */
  readonly reader?: VoiceKeyReader
  /** Fixed-duration fallback when no `reader` is wired. Defaults to
   *  10 seconds. */
  readonly fixedDurationMs?: number
  /** Sleep impl — tests pin to a synchronous fake. Defaults to
   *  `setTimeout` Promise. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** The surface-composed half of {@link VoiceCmdCtx} — everything except the
 *  io sinks, which the slash dispatcher supplies from its own `SlashContext`.
 *  This is the shape the `/voice` registry entry's `ctx.voice` slot carries
 *  (D-9 register-or-degrade). */
export type VoiceSlashDeps = Omit<VoiceCmdCtx, "out" | "err">

const DEFAULT_FIXED_DURATION_MS = 10_000

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })

/** `/voice status` — print backend + transcriber selection. */
const runStatus = (ctx: VoiceCmdCtx): number => {
  if (ctx.recorder === undefined) {
    ctx.err("/voice: recorder not wired (no recorder backend injected)\n")
    return 1
  }
  const backend = ctx.recorder.availability()
  if (backend === null) {
    ctx.err("/voice: backend missing (install one of: `sox` (brew/apt), `arecord`, `parec`)\n")
    return 1
  }
  const t = ctx.transcriber !== undefined ? "wired" : "not wired"
  const q = ctx.planQueue !== undefined ? "wired" : "not wired (will print transcript)"
  ctx.out(`/voice: backend=${backend} transcriber=${t} plan-queue=${q}\n`)
  return 0
}

interface RecordOutcome {
  readonly outcome: "ok" | "cancelled" | "error"
  readonly bytes?: Uint8Array
  readonly errorMsg?: string
}

interface RecordArgs {
  readonly recorder: AudioRecorderPort
  readonly reader: VoiceKeyReader | undefined
  readonly fixedMs: number
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly out: (s: string) => void
  readonly err: (s: string) => void
}

const runRecord = async (args: RecordArgs): Promise<RecordOutcome> => {
  const startRes = await args.recorder.start({ format: "wav", rate: 16000, channels: 1 })
  if (!startRes.ok) {
    const e = startRes.error
    if (e.kind === "backend-missing") {
      args.err(`/voice: ${e.degradeReason}\n`)
      return { outcome: "error", errorMsg: "backend-missing" }
    }
    args.err(`/voice: recorder.start failed (${e.kind})\n`)
    return { outcome: "error", errorMsg: e.kind }
  }
  const handle = startRes.value
  const ctrl = new AbortController()
  args.out(
    args.reader !== undefined
      ? "/voice: recording... (Enter to stop, Esc to cancel)\n"
      : `/voice: recording for ${Math.round(args.fixedMs / 1000)}s...\n`,
  )
  let userAction: "enter" | "esc" | null = "enter"
  if (args.reader !== undefined) {
    userAction = await args.reader.awaitStopOrCancel(ctrl.signal)
  } else {
    await args.sleep(args.fixedMs, ctrl.signal)
  }
  if (userAction === "esc") {
    handle._internal.kill("SIGTERM")
    // still drain so the child reaps cleanly
    await args.recorder.stop(handle)
    args.out("/voice: cancelled\n")
    return { outcome: "cancelled" }
  }
  const stopRes = await args.recorder.stop(handle)
  if (!stopRes.ok) {
    const e = stopRes.error
    if (e.kind === "oversize") {
      args.err(`/voice: recording exceeded ${e.maxBytes} bytes; discarded\n`)
      return { outcome: "error", errorMsg: "oversize" }
    }
    args.err(`/voice: recorder.stop failed (${e.kind})\n`)
    return { outcome: "error", errorMsg: e.kind }
  }
  return { outcome: "ok", bytes: stopRes.value.bytes }
}

interface TranscribeArgs {
  readonly transcriber: TranscriberPort
  readonly audio: Uint8Array
  readonly language: string | undefined
  readonly err: (s: string) => void
}

/** One operator-facing line per {@link TranscriberError} kind — the whole
 *  reason the union is closed. A unit because every branch does the SAME two
 *  things (say why, give up); only the wording differs, so the wording is what
 *  gets to live on its own. Each line keeps its trailing newline: it is written
 *  straight to stderr. */
const describeTranscriberError = (e: TranscriberError): string => {
  switch (e.kind) {
    case "auth-failed":
      return `/voice: transcriber auth failed (status ${e.status})\n`
    case "rate-limited":
      return `/voice: transcriber rate-limited (status ${e.status})\n`
    case "empty-audio":
      return "/voice: no audio captured\n"
    case "timeout":
      return `/voice: transcriber timed out after ${e.elapsedMs} ms\n`
    case "aborted":
      return "/voice: transcription aborted\n"
    case "unsupported-format":
      return `/voice: transcriber rejected format=${e.format}\n`
    case "no-transcription":
      return `/voice: ${e.degradeReason}\n`
    case "network-error":
      return `/voice: transcriber network error (${e.degradeReason})\n`
    default:
      return `/voice: transcription failed (status ${e.status}): ${e.degradeReason}\n`
  }
}

const runTranscribe = async (args: TranscribeArgs): Promise<VoiceTranscript | null> => {
  args.err("/voice: transcribing...\n")
  const req: TranscribeReq = {
    audio: args.audio,
    format: "wav",
    ...(args.language !== undefined ? { language: args.language } : {}),
  }
  const r = await args.transcriber.transcribe(req)
  if (!r.ok) {
    args.err(describeTranscriberError(r.error))
    return null
  }
  return r.value
}

/** Build the "voice text was captured" output. Branches on whether the
 *  plan-queue is wired: when wired ⇒ enqueue as a follow-up; when not
 *  ⇒ print the transcript to stdout. */
const emitTranscript = (
  ctx: VoiceCmdCtx,
  t: VoiceTranscript,
): { delivered: "queued" | "printed" } => {
  if (ctx.planQueue !== undefined) {
    const threadId = ctx.threadId ?? "default"
    const turn = ctx.currentTurn ?? 0
    const lang = t.language
    const metadata: Record<string, string> = {}
    if (lang !== undefined) metadata.language = lang
    if (t.segments !== undefined) metadata.segments = String(t.segments.length)
    const res = ctx.planQueue.enqueue({
      threadId,
      text: t.text,
      source: "voice_transcript",
      pausedReason: "other",
      arrivedDuringTurn: turn,
      urgent: false,
      metadata,
    })
    ctx.out(`/voice: queued (${res.collapsed ? "dedup" : "new"}, id=${res.id}): ${t.text}\n`)
    return { delivered: "queued" }
  }
  ctx.out(`/voice: ${t.text}\n`)
  return { delivered: "printed" }
}

interface RunRecordAndTranscribeArgs {
  readonly ctx: VoiceCmdCtx
  readonly recorder: AudioRecorderPort
  /** Required BY CONSTRUCTION: the dispatcher gates on transcriber presence
   *  BEFORE any audio is captured (UUX-6-27 — never capture-then-discard). */
  readonly transcriber: TranscriberPort
}

const runRecordAndTranscribe = async (args: RunRecordAndTranscribeArgs): Promise<number> => {
  const { ctx, recorder, transcriber } = args
  const rec = await runRecord({
    recorder,
    reader: ctx.reader,
    fixedMs: ctx.fixedDurationMs ?? DEFAULT_FIXED_DURATION_MS,
    sleep: ctx.sleep ?? defaultSleep,
    out: ctx.out,
    err: ctx.err,
  })
  if (rec.outcome === "cancelled") return 0
  if (rec.outcome === "error") return 1
  const audio = rec.bytes as Uint8Array
  if (audio.byteLength === 0) {
    ctx.err("/voice: no audio captured\n")
    return 1
  }
  const t = await runTranscribe({
    transcriber,
    audio,
    language: ctx.language,
    err: ctx.err,
  })
  if (t === null) return 1
  emitTranscript(ctx, t)
  return 0
}

/** Dispatch entry: `runVoiceCmd("/voice", ctx)`. Returns the slash exit
 *  code (0 success / cancelled, 1 failure). Unknown subcommands print
 *  the usage banner and exit 1. */
export const runVoiceCmd = async (line: string, ctx: VoiceCmdCtx): Promise<number> => {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  const sub = tokens[1]
  if (sub === "status") return runStatus(ctx)
  if (sub === "cancel") {
    // Stateless slash: a real cancel needs the surface to track the
    // in-flight handle. We surface the contract here so a future
    // surface can register a cancel hook; today we no-op + exit 0.
    ctx.out("/voice: nothing to cancel (cancel-while-running needs surface state)\n")
    return 0
  }
  if (sub !== undefined && sub !== "record") {
    ctx.err(`/voice: unknown subcommand "${sub}" (use: /voice | /voice status | /voice cancel)\n`)
    return 1
  }
  if (ctx.recorder === undefined) {
    ctx.err("/voice: voice backend missing (no recorder injected)\n")
    ctx.err(
      "hint: install `sox` (brew/apt) and run a surface that composes the voice recorder port; /voice-live (QUANTA_VOICE_LIVE=1) is the realtime alternative\n",
    )
    return 1
  }
  // D-9 honesty gate — refuse BEFORE capturing: without a transcriber the
  // recording could only be discarded, and the pre-fix "captured N bytes
  // (transcriber not wired)" + exit 0 was a false success (UUX-6-27).
  if (ctx.transcriber === undefined) {
    ctx.err("/voice: transcriber not wired — refusing to record audio that would be discarded\n")
    ctx.err(
      "hint: wire a transcriber (OpenAI Whisper / Deepgram / local whisper — see @/voice/transcriber) at the surface composition root\n",
    )
    return 1
  }
  return runRecordAndTranscribe({ ctx, recorder: ctx.recorder, transcriber: ctx.transcriber })
}
