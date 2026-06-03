import { describe, expect, test } from "bun:test"
import { createHeadlessStub, type HeadlessStubHandle } from "@/realtime"
import type { AudioPlaybackPort, PlaybackError } from "@/realtime/voice-session"
import {
  createDefaultVoiceSession,
  type DefaultSessionDeps,
  type MicPump,
  type RealtimeVoiceSessionPort,
  type VoiceSessionEvent,
} from "@/realtime/voice-session"
import { err, ok, type Result } from "@/shared"
import type { AudioRecorderPort } from "@/voice"

/**
 * Hellgate for the start() TOCTOU race (U1-voice-race).
 *
 * start() awaits `openTransport(opts)`. If close() (Ctrl-C / hangup) runs
 * DURING that handshake, teardown() already ran with a null pump/unsub (no-ops)
 * and the state is `closed`. The post-await wiring tail (sendSessionUpdate /
 * wireTransport → unsubTransport / startPump → stopPump) must NOT run — else it
 * registers a transport onMessage subscription + a mic pump as ZOMBIES that no
 * later close()/onConnectionLost can tear down (both early-return on `closed`).
 *
 * The existing voice-session-hellgate only covers forceClose mid-RESPONDING
 * (HELL-RTV-07), well after the handshake. This file proves the close-DURING-
 * connect interleaving leaves NO live subscription and NO live pump.
 *
 * Determinism: the headless stub's `connectMicrotaskDelay` opens a microtask
 * window between calling connect() and its resolution; the test calls close()
 * inside that window. Zero real I/O / wall-clock.
 */

const fakeRecorder = (available: boolean): AudioRecorderPort => ({
  availability: () => (available ? "sox" : null),
  start: async () => err({ kind: "backend-missing", degradeReason: "fake" }),
  stop: async () => err({ kind: "io-error", degradeReason: "fake" }),
})

interface FakePlayback extends AudioPlaybackPort {
  stopped: number
}
const fakePlayback = (): FakePlayback => {
  const self: FakePlayback = {
    stopped: 0,
    availability: () => "ffplay",
    play(): Result<void, PlaybackError> {
      return ok(undefined)
    },
    async flush() {},
    stop() {
      self.stopped++
    },
  }
  return self
}

/** Pump that records start/stop + can push a chunk via `emit`. */
interface ControlPump extends MicPump {
  emit(chunk: Uint8Array): void
  started: number
  stopped: number
}
const controlPump = (): ControlPump => {
  let onChunk: ((c: Uint8Array) => void) | null = null
  let live = false
  const self: ControlPump = {
    started: 0,
    stopped: 0,
    start(cb) {
      self.started++
      onChunk = cb
      live = true
      return () => {
        self.stopped++
        live = false
        onChunk = null
      }
    },
    emit(chunk) {
      if (live && onChunk) onChunk(chunk)
    },
  }
  return self
}

const fakeClock = (): (() => number) => {
  let t = 1000
  return () => {
    t += 1
    return t
  }
}

interface Harness {
  readonly session: RealtimeVoiceSessionPort
  readonly stub: HeadlessStubHandle
  readonly playback: FakePlayback
  readonly pump: ControlPump
  readonly events: VoiceSessionEvent[]
}

/** Build with a microtask delay so the test can interleave close() into the
 *  connect handshake. */
const buildRaceHarness = (connectMicrotaskDelay: number): Harness => {
  const stub = createHeadlessStub({ connectMicrotaskDelay })
  const playback = fakePlayback()
  const pump = controlPump()
  const deps: DefaultSessionDeps = {
    transport: stub.port,
    recorder: fakeRecorder(true),
    playback,
    pump,
    now: fakeClock(),
    captureRate: 24_000,
  }
  const session = createDefaultVoiceSession(deps)
  const events: VoiceSessionEvent[] = []
  session.onEvent((e) => events.push(e))
  return { session, stub, playback, pump, events }
}

const outboundTexts = (stub: HeadlessStubHandle): string[] =>
  stub
    .outbound()
    .filter((o): o is { kind: "text"; data: string } => o.kind === "text")
    .map((o) => o.data)

describe("HELL-RTV-14 close DURING connect handshake (TOCTOU)", () => {
  test("close() mid-connect ⇒ start() Err(illegal-state); NO zombie pump or subscription", async () => {
    const h = buildRaceHarness(3) // 3 microtask yields inside connect()

    // Kick off start() — it awaits openTransport across the microtask window.
    const startP = h.session.start({
      endpoint: "wss://test/realtime",
      auth: "tok",
      model: "gpt-realtime",
      mode: "server_vad",
    })

    // Interleave close() while connect() is still in flight. This runs
    // teardown() (pump/unsub still null → no-ops) and drives state → closed.
    const closeR = await h.session.close()
    expect(closeR.ok).toBe(true)
    expect(h.session.state()).toBe("closed")

    // Now let start() finish its post-await tail.
    const startR = await startP

    // The tail must have detected the lost handshake and bailed, NOT wired.
    expect(startR.ok).toBe(false)
    if (!startR.ok) expect(startR.error.kind).toBe("illegal-state")
    expect(h.session.state()).toBe("closed")

    // ZOMBIE PUMP: the mic pump must never have been started (or, if it raced
    // to start, must be stopped). Net: no live pump.
    expect(h.pump.started - h.pump.stopped).toBe(0)

    // Defense-in-depth: after the closed race, an inbound frame routes nothing
    // into the session (the stub also drops injects post-close, so this is a
    // belt-and-suspenders check; the discriminating zombie proof is the pump
    // counter above + the append check below).
    const eventsBefore = h.events.length
    h.stub.inject({ kind: "text", data: JSON.stringify({ type: "response.created" }) })
    expect(h.events.length).toBe(eventsBefore)
    expect(h.session.state()).toBe("closed")

    // ZOMBIE PUMP, behavioral: a mic chunk after the race must produce NO
    // outbound append frame (a live pump would forward it).
    h.stub.clearOutbound()
    h.pump.emit(new Uint8Array([1, 2, 3, 4]))
    expect(outboundTexts(h.stub).some((t) => t.includes("input_audio_buffer.append"))).toBe(false)
  })

  test("happy path is unchanged: start() with no interleaved close ⇒ ok + wired", async () => {
    const h = buildRaceHarness(0)
    const r = await h.session.start({
      endpoint: "wss://test/realtime",
      auth: "tok",
      model: "gpt-realtime",
      mode: "server_vad",
    })
    expect(r.ok).toBe(true)
    expect(h.session.state()).toBe("listening")
    // session.update + audio-start were sent.
    expect(outboundTexts(h.stub).some((t) => t.includes('"session.update"'))).toBe(true)
    expect(
      h.stub.outbound().some((o) => o.kind === "audio-start" && o.format === "pcm"),
    ).toBe(true)
    // pump is live; a chunk forwards an append.
    expect(h.pump.started - h.pump.stopped).toBe(1)
    h.pump.emit(new Uint8Array([0, 1, 2, 3, 4, 5]))
    expect(outboundTexts(h.stub).some((t) => t.includes("input_audio_buffer.append"))).toBe(true)
  })
})
