/**
 * In-REPL `/voice-live` subcommand handler (ADR-0439, RFC-03 §5).
 *
 * Sibling to `voice-cmd.ts` (one-shot dictation). This is LIVE bidirectional
 * spoken dialog: streaming mic-up + streaming transcript/audio-down with a
 * 5-state machine, mute, barge-in/interrupt, server-VAD + push-to-talk. It
 * drives the `RealtimeVoiceSessionPort` (`@/realtime/voice-session`).
 *
 * Slice discipline:
 *   - Runs in `apps/cli` only — the surface is the ONLY place that crosses
 *     planes (it owns the session construction, the recorder, the auth
 *     resolution). The slash itself only sees an injected
 *     `RealtimeVoiceSessionPort` + injected `out`/`err`.
 *   - Default-OFF: when `ctx.session` is undefined (surface didn't wire it),
 *     the slash prints "realtime voice not wired" and exits 1 — explicit
 *     default-OFF gate (RFC §3.5). Existing CLI paths are byte-identical.
 *   - Headless (no `keys` reader): the slash DECLINES and exits 0 with a
 *     one-line notice (RFC §5.3) — we never auto-run a live mic session.
 *
 * REPL labels mirror Codex's `composer.realtime.*` set (RFC §2.4):
 *   start/listening, responding, ending, closed, muted/unmuted, interrupted,
 *   connectionError, microphonePermissionError.
 */

import type {
  RealtimeVoiceSessionPort,
  VoiceSessionError,
  VoiceSessionEvent,
  VoiceTurnMode,
} from "@/realtime/voice-session"

/** Key reader for the live session. Distinct from `voice-cmd`'s stop/cancel
 *  reader: live voice has more controls (mute toggle, push-to-talk commit,
 *  interrupt, end). Returns the next control the user pressed, or `null` when
 *  the stream closed. The surface implements this over raw-mode keypress;
 *  tests inject a scripted reader. */
export interface VoiceLiveKeyReader {
  /** Resolve with the next control key, or `null` if input closed. */
  next(signal: AbortSignal): Promise<VoiceLiveControl | null>
}

/** Controls the live REPL maps to session ops. */
export type VoiceLiveControl = "mute" | "push" | "interrupt" | "end"

export interface VoiceLiveCtx {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
  /** The live session port. Undefined ⇒ default-OFF gate (exit 1). */
  readonly session?: RealtimeVoiceSessionPort
  /** Key reader. Undefined ⇒ headless decline (exit 0). */
  readonly keys?: VoiceLiveKeyReader
  /** Turn-detection mode. Defaults to `server_vad`. */
  readonly mode?: VoiceTurnMode
  /** Resolved WS endpoint (surface builds it from config). */
  readonly endpoint?: string
  /** Resolved bearer (surface resolves via the llm factory/oauth seam). */
  readonly auth?: string
  /** Realtime model id (from config). */
  readonly model?: string
  /** Output voice. */
  readonly voice?: string
}

const DEFAULT_ENDPOINT = "wss://api.openai.com/v1/realtime"
const DEFAULT_MODEL = "gpt-realtime"

/** Render a session error to the REPL with the mirrored composer label. */
const renderError = (ctx: VoiceLiveCtx, e: VoiceSessionError): void => {
  switch (e.kind) {
    case "auth-failed":
    case "connect-failed":
    case "connection":
      ctx.err(`/voice-live: connection error (${e.degradeReason})\n`)
      break
    case "mic-permission":
      ctx.err(`/voice-live: microphone permission error (${e.degradeReason})\n`)
      break
    case "illegal-state":
      ctx.err(`/voice-live: cannot ${e.op} while ${e.state}\n`)
      break
    case "not-started":
      ctx.err("/voice-live: session not started\n")
      break
    default:
      ctx.err(`/voice-live: error (${e.kind})\n`)
      break
  }
}

/** `/voice-live status` — print state + mute + mode. */
const runStatus = (ctx: VoiceLiveCtx): number => {
  if (ctx.session === undefined) {
    ctx.err("/voice-live: realtime voice not wired (no session injected)\n")
    return 1
  }
  const mode = ctx.mode ?? "server_vad"
  ctx.out(`/voice-live: state=${ctx.session.state()} muted=${ctx.session.muted()} mode=${mode}\n`)
  return 0
}

/** Map a control key to a session op + REPL label. */
const applyControl = (
  ctx: VoiceLiveCtx,
  session: RealtimeVoiceSessionPort,
  c: VoiceLiveControl,
): void => {
  switch (c) {
    case "mute": {
      const next = !session.muted()
      const r = session.setMuted(next)
      if (!r.ok) renderError(ctx, r.error)
      else ctx.out(next ? "/voice-live: muted\n" : "/voice-live: unmuted\n")
      break
    }
    case "push": {
      const r = session.commitTurn()
      if (!r.ok) renderError(ctx, r.error)
      else ctx.out("/voice-live: turn committed\n")
      break
    }
    case "interrupt": {
      const r = session.interrupt()
      if (!r.ok) renderError(ctx, r.error)
      else ctx.out("/voice-live: interrupted\n")
      break
    }
    case "end":
      // handled by the loop (breaks out)
      break
  }
}

/** Render an incoming session event to the REPL. Transcript is the always-on
 *  channel; audio-delta is handled by the playback port (we just note state). */
const renderEvent = (ctx: VoiceLiveCtx, e: VoiceSessionEvent): void => {
  switch (e.kind) {
    case "state":
      if (e.state === "listening") ctx.out("/voice-live: listening...\n")
      else if (e.state === "responding") ctx.out("/voice-live: responding...\n")
      else if (e.state === "closed") ctx.out("/voice-live: closed\n")
      break
    case "transcript-delta":
      ctx.out(e.text)
      break
    case "transcript-done":
      ctx.out("\n")
      break
    case "error":
      renderError(ctx, e.error)
      break
    case "audio-delta":
      // routed to the playback port inside the session; nothing to print.
      break
  }
}

/** Run the live loop: start → drive controls until end/close. */
const runLive = async (ctx: VoiceLiveCtx, session: RealtimeVoiceSessionPort): Promise<number> => {
  if (ctx.keys === undefined) {
    // Headless / no key reader — decline (never auto-run a live mic session).
    ctx.out("/voice-live: realtime voice requires an interactive terminal\n")
    return 0
  }

  const unsub = session.onEvent((e) => renderEvent(ctx, e))
  const start = await session.start({
    endpoint: ctx.endpoint ?? DEFAULT_ENDPOINT,
    auth: ctx.auth ?? "",
    model: ctx.model ?? DEFAULT_MODEL,
    mode: ctx.mode ?? "server_vad",
    ...(ctx.voice !== undefined ? { voice: ctx.voice } : {}),
  })
  if (!start.ok) {
    renderError(ctx, start.error)
    unsub()
    return 1
  }

  const ctrl = new AbortController()
  // Drive controls until the user ends or the stream closes.
  for (;;) {
    const c = await ctx.keys.next(ctrl.signal)
    if (c === null || c === "end") break
    applyControl(ctx, session, c)
    if (session.state() === "closed") break
  }

  ctx.out("/voice-live: ending...\n")
  await session.close()
  unsub()
  return 0
}

/**
 * Dispatch entry: `runVoiceLiveCmd("/voice-live", ctx)`. Returns the slash
 * exit code (0 success / headless-decline, 1 failure). Subcommands:
 *   - `/voice-live`        — start the live session loop.
 *   - `/voice-live status` — print state + mute + mode.
 */
export const runVoiceLiveCmd = async (line: string, ctx: VoiceLiveCtx): Promise<number> => {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  const sub = tokens[1]

  if (sub === "status") return runStatus(ctx)

  if (sub !== undefined) {
    ctx.err(`/voice-live: unknown subcommand "${sub}" (use: /voice-live | /voice-live status)\n`)
    return 1
  }

  if (ctx.session === undefined) {
    ctx.err(
      "/voice-live: realtime voice not wired (no session injected). Set the realtime config + provide an OpenAI key, then wire the session port.\n",
    )
    return 1
  }

  return runLive(ctx, ctx.session)
}
