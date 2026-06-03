/**
 * Realtime voice-session — default `RealtimeVoiceSessionPort` impl
 * (ADR-0442, RFC §3.1/§3.4). COMPOSES the existing transport + recorder +
 * sibling playback into a live spoken dialog. NO transport / mic / codec is
 * re-implemented here — everything is an injected port.
 *
 * Determinism: NO `Date.now`/`Math.random`/real timer in this file. The clock
 * (`now`) and the mic up-pump driver (`pump`) are injected so the hellgate
 * drives the whole session with zero real I/O and zero wall-clock.
 *
 * Plane-clean: imports only `@/realtime` (RealtimePort), `@/voice`
 * (AudioRecorderPort), `@/shared`, and sibling files.
 */

import { err, notifyAllNoThrow, ok, type Result } from "@/shared"
import type { AudioRecorderPort } from "@/voice"
import type { RealtimePort } from "../port"
import { bridgeToRealtime } from "./pcm-bridge"
import type { AudioPlaybackPort } from "./playback-port"
import type {
  RealtimeVoiceSessionPort,
  VoiceSessionError,
  VoiceSessionEvent,
  VoiceSessionStartOpts,
  VoiceSessionState,
  VoiceSessionUnsubscribe,
  VoiceTurnMode,
} from "./port"
import { buildSessionUpdate, DEFAULT_VOICE, REALTIME_PCM_RATE } from "./session-config"
import { reduce, type VoiceSessionAction } from "./state-machine"

/**
 * The mic up-pump driver. Injected so the session never owns a real timer.
 * The surface (or test) calls back with each captured mic chunk; the returned
 * stop function halts the pump. The default CLI surface implements this by
 * looping `recorder.start → stop` or by draining a streaming recorder; the
 * hellgate implements it by handing the session a chunk-emitter directly.
 */
export interface MicPump {
  /** Begin pumping. `onChunk` is invoked for every captured PCM/WAV chunk.
   *  Returns a stop function (idempotent). The pump MUST NOT invoke `onChunk`
   *  after stop. */
  start(onChunk: (chunk: Uint8Array) => void): () => void
}

export interface DefaultSessionDeps {
  /** Existing realtime transport (Bun adapter / OpenAI adapter / headless
   *  stub). The session calls connect/send/onMessage/audioStart/close. */
  readonly transport: RealtimePort
  /** Existing mic recorder — used for the permission/availability probe at
   *  start(). Capture streaming is driven by `pump`. */
  readonly recorder: AudioRecorderPort
  /** Down-channel audio sink. When `availability()===null` ⇒ transcript-only. */
  readonly playback: AudioPlaybackPort
  /** Mic up-pump. Injected (no real timer in the slice). */
  readonly pump: MicPump
  /** Injected clock — event timestamps only. No `Date.now` in src. */
  readonly now: () => number
  /** Capture sample rate the recorder/pump produces (for the pcm-bridge). */
  readonly captureRate?: number
}

const clampRate = (r: number | undefined): number =>
  r !== undefined && r > 0 ? r : REALTIME_PCM_RATE

/** Base64-encode raw PCM bytes for the Realtime API's text-WS frame. */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

/** Decode a base64 audio-delta from the server back to PCM bytes. */
const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"))

export const createDefaultVoiceSession = (deps: DefaultSessionDeps): RealtimeVoiceSessionPort => {
  let state: VoiceSessionState = "idle"
  let isMuted = false
  let mode: VoiceTurnMode = "server_vad"
  let stopPump: (() => void) | null = null
  let unsubTransport: (() => void) | null = null
  const captureRate = clampRate(deps.captureRate)
  const handlers: Array<(e: VoiceSessionEvent) => void> = []

  const emit = (e: VoiceSessionEvent): void => {
    // Isolate throwing subscribers — a render bug can't starve playback
    // (RFC §3.4; HELL-RTV-13). Same no-throw fan-out the transport uses.
    notifyAllNoThrow(handlers.slice(), undefined, e)
  }

  /** Drive a reducer action; on legal transition, update state + emit. */
  const dispatch = (action: VoiceSessionAction): boolean => {
    const r = reduce(state, action)
    if (!r.ok) return false
    if (r.state !== state) {
      state = r.state
      emit({ kind: "state", state, at: deps.now() })
    }
    return true
  }

  const teardown = (): void => {
    if (stopPump) {
      try {
        stopPump()
      } catch {
        // pump stop is best-effort
      }
      stopPump = null
    }
    if (unsubTransport) {
      unsubTransport()
      unsubTransport = null
    }
    deps.playback.stop()
  }

  type InboundMsg = { type?: unknown; delta?: unknown; transcript?: unknown; error?: unknown }

  /** Route an audio-delta: play (unless transcript-only) + always emit. */
  const onAudioDelta = (msg: InboundMsg): void => {
    if (typeof msg.delta !== "string") return
    const pcm = fromBase64(msg.delta)
    // transcript-only fallback: drop audio when no player (RFC §6.3).
    if (deps.playback.availability() !== null) deps.playback.play(pcm)
    emit({ kind: "audio-delta", pcm, at: deps.now() })
  }

  /** Inbound type → effect table. Each handler is small; the router below just
   *  dispatches. Keeps cognitive complexity bounded. */
  const onError = (msg: InboundMsg): void => {
    const reason =
      msg.error && typeof msg.error === "object" && "message" in msg.error
        ? String((msg.error as { message: unknown }).message)
        : "realtime error"
    emit({ kind: "error", error: { kind: "io-error", degradeReason: reason }, at: deps.now() })
  }

  const ROUTES: Readonly<Record<string, (msg: InboundMsg) => void>> = {
    "response.created": () => {
      dispatch({ type: "turn-start" })
    },
    "response.audio.delta": (msg) => {
      dispatch({ type: "turn-start" })
      onAudioDelta(msg)
    },
    "response.output_audio.delta": (msg) => {
      dispatch({ type: "turn-start" })
      onAudioDelta(msg)
    },
    "response.audio_transcript.delta": (msg) => {
      dispatch({ type: "turn-start" })
      if (typeof msg.delta === "string") {
        emit({ kind: "transcript-delta", text: msg.delta, at: deps.now() })
      }
    },
    "response.audio_transcript.done": (msg) => {
      emit({
        kind: "transcript-done",
        text: typeof msg.transcript === "string" ? msg.transcript : "",
        at: deps.now(),
      })
    },
    "response.output_audio_transcript.done": (msg) => {
      emit({
        kind: "transcript-done",
        text: typeof msg.transcript === "string" ? msg.transcript : "",
        at: deps.now(),
      })
    },
    "response.done": () => {
      void deps.playback.flush()
      dispatch({ type: "turn-done" })
    },
    error: onError,
  }

  /** Parse an inbound text frame from the server and route it (RFC §3.4).
   *  session.updated / item.added / unknown ⇒ no state effect (no route). */
  const onInbound = (raw: string): void => {
    let msg: InboundMsg
    try {
      msg = JSON.parse(raw) as InboundMsg
    } catch {
      return // non-JSON frame — ignore (spec emits JSON)
    }
    const type = typeof msg.type === "string" ? msg.type : ""
    ROUTES[type]?.(msg)
  }

  /** Wire the transport's onMessage; classify a remote close as connection
   *  loss (RFC §6 connection-drop row). */
  const wireTransport = (): void => {
    unsubTransport = deps.transport.onMessage((m) => {
      if (m.kind === "text") onInbound(m.data)
      // binary frames are not used by the Realtime text-WS protocol; ignore.
    })
  }

  /** Classify a transport that went away mid-session as a connection drop
   *  (RFC §6 connection-drop row / HELL-RTV-07). Transitions to `closed`,
   *  emits ONE `error{reason:connection}`, tears down subscribers (no
   *  zombies). Idempotent — a second detection after close is a no-op. */
  const onConnectionLost = (degradeReason: string): void => {
    if (state === "closed") return
    teardown()
    emit({ kind: "error", error: { kind: "connection", degradeReason }, at: deps.now() })
    dispatch({ type: "close" })
  }

  /** Forward a single mic chunk up. Muted ⇒ dropped BEFORE the append frame
   *  (RFC §3.4 / HELL-RTV-06). A post-open `not-connected` send result OR a
   *  closed transport means the remote dropped — detected here since the
   *  transport surfaces close only on its own WS (HELL-RTV-07). */
  const pumpChunk = (chunk: Uint8Array): void => {
    if (isMuted) return
    if (state !== "listening" && state !== "responding") return
    if (deps.transport.status() === "closed") {
      onConnectionLost("transport closed")
      return
    }
    const pcm = bridgeToRealtime(chunk, captureRate, REALTIME_PCM_RATE)
    if (pcm.byteLength === 0) return
    const sent = deps.transport.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }),
    )
    if (!sent.ok && sent.error.kind === "not-connected") {
      onConnectionLost("transport not connected")
    }
  }

  /** Up-pump: each mic chunk → `pumpChunk`. */
  const startPump = (): void => {
    stopPump = deps.pump.start(pumpChunk)
  }

  const guardActive = (): Result<void, VoiceSessionError> => {
    if (state === "idle" || state === "closed") {
      return err({ kind: "not-started" })
    }
    return ok(undefined)
  }

  /** Fail the connect: connecting → idle + emit + return Err. */
  const failConnect = (e: VoiceSessionError): Result<void, VoiceSessionError> => {
    dispatch({ type: "connect-failed" })
    emit({ kind: "error", error: e, at: deps.now() })
    return err(e)
  }

  /** Open the transport, mapping its typed error to ours. */
  const openTransport = async (
    opts: VoiceSessionStartOpts,
  ): Promise<Result<void, VoiceSessionError>> => {
    const c = await deps.transport.connect({
      endpoint: opts.endpoint,
      auth: opts.auth,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (c.ok) return ok(undefined)
    if (c.error.kind === "auth-failed") {
      return err({ kind: "auth-failed", degradeReason: c.error.degradeReason })
    }
    const degradeReason = "degradeReason" in c.error ? c.error.degradeReason : c.error.kind
    return err({ kind: "connect-failed", degradeReason })
  }

  /** Send the §4.2 session.update + audio.start marker. */
  const sendSessionUpdate = (opts: VoiceSessionStartOpts): void => {
    const cfg = buildSessionUpdate({
      model: opts.model,
      mode,
      voice: opts.voice ?? DEFAULT_VOICE,
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
      ...(opts.vad !== undefined ? { vad: opts.vad } : {}),
    })
    deps.transport.send(JSON.stringify(cfg))
    deps.transport.audioStart("pcm")
  }

  return {
    async start(opts: VoiceSessionStartOpts): Promise<Result<void, VoiceSessionError>> {
      if (state !== "idle") {
        return err({ kind: "illegal-state", state, op: "start" })
      }
      mode = opts.mode ?? "server_vad"
      dispatch({ type: "start" }) // idle → connecting

      // 1. Mic permission/availability probe BEFORE opening transport — a
      //    denied mic must NOT send any frames (RFC §6 / HELL-RTV-09).
      if (deps.recorder.availability() === null) {
        return failConnect({
          kind: "mic-permission",
          degradeReason: "no mic backend on PATH (sox/arecord/parec)",
        })
      }

      // 2. Open transport.
      const opened = await openTransport(opts)
      if (!opened.ok) return failConnect(opened.error)

      // 2a. Liveness re-check across the connect await (TOCTOU). If close() /
      //     onConnectionLost ran during the handshake (Ctrl-C / hangup), the
      //     session is no longer `connecting` — the reducer rejects
      //     opened-from-{closed,…}. Gate the whole wiring tail on that dispatch
      //     so we never register a transport subscription or start the mic pump
      //     as ZOMBIES that no later close() can tear down (state is already
      //     `closed`, so close()/onConnectionLost early-return). teardown() is
      //     run defensively (close()'s teardown saw null pump/unsub) and we
      //     surface a typed illegal-state Err.
      if (!dispatch({ type: "opened" })) {
        teardown()
        return err({ kind: "illegal-state", state, op: "start" })
      }

      // 3. session.update + audio.start. 4. wire inbound + up-pump. Only
      //    reachable when the `opened` transition above was legal (connecting →
      //    listening), i.e. the session survived the connect handshake.
      sendSessionUpdate(opts)
      wireTransport()
      startPump()
      return ok(undefined)
    },

    commitTurn(): Result<void, VoiceSessionError> {
      const g = guardActive()
      if (!g.ok) return g
      // No-op under server_vad — the server detects end-of-turn (RFC §3.3).
      if (mode === "server_vad") return ok(undefined)
      if (state !== "listening") {
        return err({ kind: "illegal-state", state, op: "commitTurn" })
      }
      deps.transport.send(JSON.stringify({ type: "input_audio_buffer.commit" }))
      deps.transport.send(JSON.stringify({ type: "response.create" }))
      return ok(undefined)
    },

    sendText(text: string): Result<void, VoiceSessionError> {
      const g = guardActive()
      if (!g.ok) return g
      deps.transport.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      )
      return ok(undefined)
    },

    setMuted(muted: boolean): Result<void, VoiceSessionError> {
      const g = guardActive()
      if (!g.ok) return g
      isMuted = muted
      return ok(undefined)
    },

    interrupt(): Result<void, VoiceSessionError> {
      const g = guardActive()
      if (!g.ok) return g
      if (state !== "responding") {
        return err({ kind: "illegal-state", state, op: "interrupt" })
      }
      deps.transport.send(JSON.stringify({ type: "response.cancel" }))
      deps.playback.stop()
      dispatch({ type: "turn-done" }) // responding → listening
      return ok(undefined)
    },

    onEvent(handler: (e: VoiceSessionEvent) => void): VoiceSessionUnsubscribe {
      handlers.push(handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },

    state(): VoiceSessionState {
      return state
    },

    muted(): boolean {
      return isMuted
    },

    async close(): Promise<Result<void, VoiceSessionError>> {
      if (state === "closed") return ok(undefined)
      teardown()
      await deps.transport.close()
      dispatch({ type: "close" })
      return ok(undefined)
    },
  }
}
