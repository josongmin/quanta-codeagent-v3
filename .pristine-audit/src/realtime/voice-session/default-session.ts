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

import { err, ok, type Result } from "@/shared"
import type { AudioRecorderPort } from "@/voice"
import type { RealtimePort } from "../port"
import { type Ctx, dispatch, type SessionBox, teardown } from "./default-session/context"
import { wireTransport } from "./default-session/inbound"
import {
  failConnect,
  guardActive,
  openTransport,
  sendSessionUpdate,
  startPump,
} from "./default-session/lifecycle"
import type { AudioPlaybackPort } from "./playback-port"
import type {
  RealtimeVoiceSessionPort,
  VoiceSessionError,
  VoiceSessionEvent,
  VoiceSessionStartOpts,
  VoiceSessionState,
  VoiceSessionUnsubscribe,
} from "./port"
import { REALTIME_PCM_RATE } from "./session-config"

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

export const createDefaultVoiceSession = (deps: DefaultSessionDeps): RealtimeVoiceSessionPort => {
  // Mutable session locals, boxed so every extracted helper mutates the SAME
  // reference (preserving the original shared-closure semantics). `handlers`
  // is a mutable array (reference type) carried as-is.
  const box: SessionBox = {
    state: "idle",
    isMuted: false,
    mode: "server_vad",
    stopPump: null,
    unsubTransport: null,
  }
  const handlers: Array<(e: VoiceSessionEvent) => void> = []
  const ctx: Ctx = { deps, box, handlers, captureRate: clampRate(deps.captureRate) }

  return {
    async start(opts: VoiceSessionStartOpts): Promise<Result<void, VoiceSessionError>> {
      if (box.state !== "idle") {
        return err({ kind: "illegal-state", state: box.state, op: "start" })
      }
      box.mode = opts.mode ?? "server_vad"
      dispatch(ctx, { type: "start" }) // idle → connecting

      // 1. Mic permission/availability probe BEFORE opening transport — a
      //    denied mic must NOT send any frames (RFC §6 / HELL-RTV-09).
      if (deps.recorder.availability() === null) {
        return failConnect(ctx, {
          kind: "mic-permission",
          degradeReason: "no mic backend on PATH (sox/arecord/parec)",
        })
      }

      // 2. Open transport.
      const opened = await openTransport(ctx, opts)
      if (!opened.ok) return failConnect(ctx, opened.error)

      // 2a. Liveness re-check across the connect await (TOCTOU). If close() /
      //     onConnectionLost ran during the handshake (Ctrl-C / hangup), the
      //     session is no longer `connecting` — the reducer rejects
      //     opened-from-{closed,…}. Gate the whole wiring tail on that dispatch
      //     so we never register a transport subscription or start the mic pump
      //     as ZOMBIES that no later close() can tear down (state is already
      //     `closed`, so close()/onConnectionLost early-return). teardown() is
      //     run defensively (close()'s teardown saw null pump/unsub) and we
      //     surface a typed illegal-state Err.
      if (!dispatch(ctx, { type: "opened" })) {
        teardown(ctx)
        return err({ kind: "illegal-state", state: box.state, op: "start" })
      }

      // 3. session.update + audio.start. 4. wire inbound + up-pump. Only
      //    reachable when the `opened` transition above was legal (connecting →
      //    listening), i.e. the session survived the connect handshake.
      sendSessionUpdate(ctx, opts)
      wireTransport(ctx)
      startPump(ctx)
      return ok(undefined)
    },

    commitTurn(): Result<void, VoiceSessionError> {
      const g = guardActive(ctx)
      if (!g.ok) return g
      // No-op under server_vad — the server detects end-of-turn (RFC §3.3).
      if (box.mode === "server_vad") return ok(undefined)
      if (box.state !== "listening") {
        return err({ kind: "illegal-state", state: box.state, op: "commitTurn" })
      }
      deps.transport.send(JSON.stringify({ type: "input_audio_buffer.commit" }))
      deps.transport.send(JSON.stringify({ type: "response.create" }))
      return ok(undefined)
    },

    sendText(text: string): Result<void, VoiceSessionError> {
      const g = guardActive(ctx)
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
      const g = guardActive(ctx)
      if (!g.ok) return g
      box.isMuted = muted
      return ok(undefined)
    },

    interrupt(): Result<void, VoiceSessionError> {
      const g = guardActive(ctx)
      if (!g.ok) return g
      if (box.state !== "responding") {
        return err({ kind: "illegal-state", state: box.state, op: "interrupt" })
      }
      deps.transport.send(JSON.stringify({ type: "response.cancel" }))
      deps.playback.stop()
      dispatch(ctx, { type: "turn-done" }) // responding → listening
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
      return box.state
    },

    muted(): boolean {
      return box.isMuted
    },

    async close(): Promise<Result<void, VoiceSessionError>> {
      if (box.state === "closed") return ok(undefined)
      teardown(ctx)
      await deps.transport.close()
      dispatch(ctx, { type: "close" })
      return ok(undefined)
    },
  }
}
