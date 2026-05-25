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
 *     wire a backend), the slash prints "voice backend missing" with a
 *     typed-error suffix and exits 1. Surfaces that DO wire `recorder`
 *     but skip `transcriber` print "transcriber not wired" — same
 *     posture.
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
import type { TranscribeReq, TranscriberPort, VoiceTranscript } from "@/voice/transcriber"

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
  /** Optional transcriber. When the surface wired the recorder but
   *  didn't wire a transcriber (no API key), the slash records + plays
   *  back the byte count without sending to a vendor. */
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

const runTranscribe = async (args: TranscribeArgs): Promise<VoiceTranscript | null> => {
  args.err("/voice: transcribing...\n")
  const req: TranscribeReq = {
    audio: args.audio,
    format: "wav",
    ...(args.language !== undefined ? { language: args.language } : {}),
  }
  const r = await args.transcriber.transcribe(req)
  if (!r.ok) {
    const e = r.error
    if (e.kind === "auth-failed") {
      args.err(`/voice: transcriber auth failed (status ${e.status})\n`)
      return null
    }
    if (e.kind === "rate-limited") {
      args.err(`/voice: transcriber rate-limited (status ${e.status})\n`)
      return null
    }
    if (e.kind === "empty-audio") {
      args.err("/voice: no audio captured\n")
      return null
    }
    if (e.kind === "timeout") {
      args.err(`/voice: transcriber timed out after ${e.elapsedMs} ms\n`)
      return null
    }
    if (e.kind === "aborted") {
      args.err("/voice: transcription aborted\n")
      return null
    }
    if (e.kind === "unsupported-format") {
      args.err(`/voice: transcriber rejected format=${e.format}\n`)
      return null
    }
    if (e.kind === "no-transcription") {
      args.err(`/voice: ${e.degradeReason}\n`)
      return null
    }
    if (e.kind === "network-error") {
      args.err(`/voice: transcriber network error (${e.degradeReason})\n`)
      return null
    }
    // transcription-failed
    args.err(`/voice: transcription failed (status ${e.status}): ${e.degradeReason}\n`)
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
}

const runRecordAndTranscribe = async (args: RunRecordAndTranscribeArgs): Promise<number> => {
  const { ctx, recorder } = args
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
  if (ctx.transcriber === undefined) {
    ctx.out(`/voice: captured ${audio.byteLength} bytes (transcriber not wired)\n`)
    return 0
  }
  const t = await runTranscribe({
    transcriber: ctx.transcriber,
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
    ctx.err(
      "/voice: voice backend missing (no recorder injected). Install `sox` then wire the recorder port.\n",
    )
    return 1
  }
  return runRecordAndTranscribe({ ctx, recorder: ctx.recorder })
}
