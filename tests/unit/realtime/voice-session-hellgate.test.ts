import { describe, expect, test } from "bun:test"
import { createHeadlessStub, type HeadlessStubHandle, type RealtimeError } from "@/realtime"
import type { AudioPlaybackPort, PlaybackError } from "@/realtime/voice-session"
import {
  bridgeToRealtime,
  buildSessionUpdate,
  createDefaultVoiceSession,
  type DefaultSessionDeps,
  type MicPump,
  type RealtimeVoiceSessionPort,
  reduce,
  resamplePcm16,
  stripWavHeader,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "@/realtime/voice-session"
import { err, ok, type Result } from "@/shared"
import type { AudioRecorderPort } from "@/voice"

/**
 * Hellgate for ADR-0442 realtime voice-session slice (RFC-03). Drives the
 * full live-dialog composition (transport + recorder + playback + pump +
 * clock) with ZERO real I/O: the headless stub is the transport, the recorder
 * /playback/pump are fakes, the clock is injected. 13 HELL-RTV cases + the
 * default-OFF byte-identical anchor.
 */

// ----------------------------------------------------------------------------
// Test doubles
// ----------------------------------------------------------------------------

/** Fake recorder — `availability()` controllable to simulate mic-denied. */
const fakeRecorder = (available: boolean): AudioRecorderPort => ({
  availability: () => (available ? "sox" : null),
  start: async () => err({ kind: "backend-missing", degradeReason: "fake — pump drives capture" }),
  stop: async () => err({ kind: "io-error", degradeReason: "fake" }),
})

/** Fake playback — records played frames; `available` toggles transcript-only. */
interface FakePlayback extends AudioPlaybackPort {
  readonly played: Uint8Array[]
  stopped: number
  flushed: number
}
const fakePlayback = (available: boolean): FakePlayback => {
  const played: Uint8Array[] = []
  const self: FakePlayback = {
    played,
    stopped: 0,
    flushed: 0,
    availability: () => (available ? "ffplay" : null),
    play(pcm: Uint8Array): Result<void, PlaybackError> {
      if (!available) return err({ kind: "no-player" })
      played.push(pcm)
      return ok(undefined)
    },
    async flush() {
      self.flushed++
    },
    stop() {
      self.stopped++
    },
  }
  return self
}

/** Controllable mic pump — the test pushes chunks via `emit`. */
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

/** Deterministic monotonic clock. */
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

const buildHarness = (opts?: {
  micAvailable?: boolean
  playbackAvailable?: boolean
  connectError?: RealtimeError
}): Harness => {
  const stub = createHeadlessStub(
    opts?.connectError ? { forceConnectError: opts.connectError } : undefined,
  )
  const playback = fakePlayback(opts?.playbackAvailable ?? true)
  const pump = controlPump()
  const deps: DefaultSessionDeps = {
    transport: stub.port,
    recorder: fakeRecorder(opts?.micAvailable ?? true),
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

const startOk = async (
  h: Harness,
  mode: "server_vad" | "push_to_talk" = "server_vad",
): Promise<void> => {
  const r = await h.session.start({
    endpoint: "wss://test/realtime",
    auth: "tok",
    model: "gpt-realtime",
    mode,
  })
  expect(r.ok).toBe(true)
}

// ----------------------------------------------------------------------------
// HELL-RTV-01 — transport wired to recorder (up-pump)
// ----------------------------------------------------------------------------

describe("HELL-RTV-01 transport wired to recorder", () => {
  test("start emits session.update + audio-start, mic chunk → append", async () => {
    const h = buildHarness()
    await startOk(h)
    const texts = outboundTexts(h.stub)
    expect(texts.some((t) => t.includes('"session.update"'))).toBe(true)
    const audioStart = h.stub.outbound().some((o) => o.kind === "audio-start" && o.format === "pcm")
    expect(audioStart).toBe(true)

    // No append until a mic chunk arrives.
    expect(outboundTexts(h.stub).some((t) => t.includes("input_audio_buffer.append"))).toBe(false)
    h.pump.emit(new Uint8Array([0, 1, 2, 3, 4, 5]))
    expect(outboundTexts(h.stub).some((t) => t.includes("input_audio_buffer.append"))).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-02 — pure state machine
// ----------------------------------------------------------------------------

describe("HELL-RTV-02 state machine", () => {
  test("legal path idle→connecting→listening→responding→listening→closed", () => {
    let s: VoiceSessionState = "idle"
    s = reduce(s, { type: "start" }).state
    expect(s).toBe("connecting")
    s = reduce(s, { type: "opened" }).state
    expect(s).toBe("listening")
    s = reduce(s, { type: "turn-start" }).state
    expect(s).toBe("responding")
    s = reduce(s, { type: "turn-done" }).state
    expect(s).toBe("listening")
    s = reduce(s, { type: "close" }).state
    expect(s).toBe("closed")
  })

  test("illegal transitions are rejected (ok:false), state unchanged", () => {
    expect(reduce("idle", { type: "turn-start" })).toEqual({ state: "idle", ok: false })
    expect(reduce("idle", { type: "opened" })).toEqual({ state: "idle", ok: false })
    expect(reduce("listening", { type: "opened" })).toEqual({ state: "listening", ok: false })
    expect(reduce("responding", { type: "turn-start" })).toEqual({
      state: "responding",
      ok: false,
    })
    expect(reduce("closed", { type: "start" })).toEqual({ state: "closed", ok: false })
  })

  test("interrupt() while idle → Err (illegal-state via session)", async () => {
    const h = buildHarness()
    const r = h.session.interrupt()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-started")
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-03 — server-VAD turn end
// ----------------------------------------------------------------------------

describe("HELL-RTV-03 server-VAD turn end", () => {
  test("response.done → responding→listening; commitTurn no-op under server_vad", async () => {
    const h = buildHarness()
    await startOk(h, "server_vad")
    h.stub.inject({ kind: "text", data: JSON.stringify({ type: "response.created" }) })
    expect(h.session.state()).toBe("responding")
    h.stub.inject({ kind: "text", data: JSON.stringify({ type: "response.done" }) })
    expect(h.session.state()).toBe("listening")

    h.stub.clearOutbound()
    const r = h.session.commitTurn()
    expect(r.ok).toBe(true)
    // No commit/response.create frames under server_vad.
    expect(outboundTexts(h.stub).length).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-04 — push-to-talk
// ----------------------------------------------------------------------------

describe("HELL-RTV-04 push-to-talk", () => {
  test("session.update has turn_detection:null; commitTurn → commit + response.create in order", async () => {
    const h = buildHarness()
    await startOk(h, "push_to_talk")
    const update = outboundTexts(h.stub).find((t) => t.includes('"session.update"'))
    expect(update).toBeDefined()
    const parsed = JSON.parse(update as string)
    expect(parsed.session.audio.input.turn_detection).toBeNull()

    h.stub.clearOutbound()
    const r = h.session.commitTurn()
    expect(r.ok).toBe(true)
    const after = outboundTexts(h.stub)
    const commitIdx = after.findIndex((t) => t.includes("input_audio_buffer.commit"))
    const createIdx = after.findIndex((t) => t.includes('"response.create"'))
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeGreaterThan(commitIdx)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-05 — interrupt / barge-in
// ----------------------------------------------------------------------------

describe("HELL-RTV-05 interrupt / barge-in", () => {
  test("responding + interrupt() → response.cancel + responding→listening", async () => {
    const h = buildHarness()
    await startOk(h)
    h.stub.inject({ kind: "text", data: JSON.stringify({ type: "response.created" }) })
    expect(h.session.state()).toBe("responding")
    h.stub.clearOutbound()
    const r = h.session.interrupt()
    expect(r.ok).toBe(true)
    expect(outboundTexts(h.stub).some((t) => t.includes('"response.cancel"'))).toBe(true)
    expect(h.session.state()).toBe("listening")
    expect(h.playback.stopped).toBeGreaterThan(0)
  })

  test("interrupt() while listening → illegal-state Err", async () => {
    const h = buildHarness()
    await startOk(h)
    const r = h.session.interrupt()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("illegal-state")
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-06 — mute
// ----------------------------------------------------------------------------

describe("HELL-RTV-06 mute", () => {
  test("muted ⇒ no append frames; unmute resumes", async () => {
    const h = buildHarness()
    await startOk(h)
    h.session.setMuted(true)
    expect(h.session.muted()).toBe(true)
    h.stub.clearOutbound()
    h.pump.emit(new Uint8Array([1, 2, 3, 4]))
    h.pump.emit(new Uint8Array([5, 6, 7, 8]))
    expect(outboundTexts(h.stub).filter((t) => t.includes("append")).length).toBe(0)

    h.session.setMuted(false)
    h.pump.emit(new Uint8Array([9, 10, 11, 12]))
    expect(outboundTexts(h.stub).filter((t) => t.includes("append")).length).toBe(1)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-07 — connection drop
// ----------------------------------------------------------------------------

describe("HELL-RTV-07 connection drop", () => {
  test("forceClose mid-responding → closed + one connection error, no zombie", async () => {
    const h = buildHarness()
    await startOk(h)
    h.stub.inject({ kind: "text", data: JSON.stringify({ type: "response.created" }) })
    expect(h.session.state()).toBe("responding")

    h.stub.forceClose()
    // The next mic chunk surfaces the drop (transport.status()==="closed").
    h.pump.emit(new Uint8Array([1, 2, 3, 4]))
    expect(h.session.state()).toBe("closed")
    const connErrors = h.events.filter((e) => e.kind === "error" && e.error.kind === "connection")
    expect(connErrors.length).toBe(1)

    // No zombie: a further chunk produces no more errors / no append.
    const before = h.events.length
    h.pump.emit(new Uint8Array([5, 6, 7, 8]))
    expect(h.events.length).toBe(before)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-08 — transcript-only fallback
// ----------------------------------------------------------------------------

describe("HELL-RTV-08 transcript-only fallback", () => {
  test("no player ⇒ audio-delta dropped from playback, transcript still renders", async () => {
    const h = buildHarness({ playbackAvailable: false })
    await startOk(h)
    const b64 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64")
    h.stub.inject({
      kind: "text",
      data: JSON.stringify({ type: "response.audio.delta", delta: b64 }),
    })
    h.stub.inject({
      kind: "text",
      data: JSON.stringify({ type: "response.audio_transcript.delta", delta: "hello" }),
    })
    // Audio not played (no player), but the audio-delta event still emitted.
    expect(h.playback.played.length).toBe(0)
    expect(h.events.some((e) => e.kind === "audio-delta")).toBe(true)
    expect(h.events.some((e) => e.kind === "transcript-delta" && e.text === "hello")).toBe(true)
    // Session stays live (responding).
    expect(h.session.state()).toBe("responding")
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-09 — mic permission denied
// ----------------------------------------------------------------------------

describe("HELL-RTV-09 mic permission denied", () => {
  test("recorder unavailable ⇒ stays idle, Err, no transport frames", async () => {
    const h = buildHarness({ micAvailable: false })
    const r = await h.session.start({
      endpoint: "wss://test/realtime",
      auth: "tok",
      model: "gpt-realtime",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("mic-permission")
    expect(h.session.state()).toBe("idle")
    expect(h.stub.outbound().length).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-10 — auth failure
// ----------------------------------------------------------------------------

describe("HELL-RTV-10 auth failure", () => {
  test("transport forceConnectError auth-failed ⇒ idle + Err surfaced", async () => {
    const h = buildHarness({
      connectError: { kind: "auth-failed", degradeReason: "bad key" },
    })
    const r = await h.session.start({
      endpoint: "wss://test/realtime",
      auth: "bad",
      model: "gpt-realtime",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("auth-failed")
    expect(h.session.state()).toBe("idle")
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-11 — default-OFF byte-identical anchor
// ----------------------------------------------------------------------------

describe("HELL-RTV-11 default-OFF byte-identical", () => {
  test("no existing src file imports @/realtime/voice-session", async () => {
    const { Glob } = await import("bun")
    const root = new URL("../../../src", import.meta.url).pathname
    const glob = new Glob("**/*.ts")
    const offenders: string[] = []
    for await (const file of glob.scan(root)) {
      if (file.includes("voice-session/")) continue // the slice itself
      if (file === "apps/cli/voice-live-cmd.ts") continue // the opt-in surface (type-only import)
      const text = await Bun.file(`${root}/${file}`).text()
      if (text.includes("@/realtime/voice-session")) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("slice is plane-clean: imports only @/realtime + @/voice + @/shared", async () => {
    const { Glob } = await import("bun")
    const sliceRoot = new URL("../../../src/realtime/voice-session", import.meta.url).pathname
    const glob = new Glob("**/*.ts")
    const forbidden = ["@/agent", "@/tool", "@/llm", "@/permission", "@/mcp", "@/media"]
    const offenders: string[] = []
    for await (const file of glob.scan(sliceRoot)) {
      const text = await Bun.file(`${sliceRoot}/${file}`).text()
      for (const f of forbidden) {
        // match an import specifier, not a prose mention in a comment.
        if (text.includes(`from "${f}"`) || text.includes(`from "${f}/`)) {
          offenders.push(`${file} → ${f}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-12 — close idempotency
// ----------------------------------------------------------------------------

describe("HELL-RTV-12 close idempotency", () => {
  test("double close → both ok, single teardown", async () => {
    const h = buildHarness()
    await startOk(h)
    const c1 = await h.session.close()
    const c2 = await h.session.close()
    expect(c1.ok).toBe(true)
    expect(c2.ok).toBe(true)
    expect(h.session.state()).toBe("closed")
    // pump stopped exactly once (second close is a fast no-op).
    expect(h.pump.stopped).toBe(1)
  })
})

// ----------------------------------------------------------------------------
// HELL-RTV-13 — throwing event handler isolation
// ----------------------------------------------------------------------------

describe("HELL-RTV-13 throwing event handler isolation", () => {
  test("one throwing handler doesn't starve siblings or playback", async () => {
    const h = buildHarness()
    const sibling: VoiceSessionEvent[] = []
    h.session.onEvent(() => {
      throw new Error("boom")
    })
    h.session.onEvent((e) => sibling.push(e))
    await startOk(h)
    // sibling still received the state events despite the throwing handler.
    expect(sibling.some((e) => e.kind === "state")).toBe(true)
    // playback still works on a subsequent audio-delta.
    const b64 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64")
    h.stub.inject({
      kind: "text",
      data: JSON.stringify({ type: "response.audio.delta", delta: b64 }),
    })
    expect(h.playback.played.length).toBe(1)
  })
})

// ----------------------------------------------------------------------------
// pcm-bridge unit coverage (the single DSP seam — honest, pure)
// ----------------------------------------------------------------------------

describe("pcm-bridge (isolated DSP seam, pure)", () => {
  test("stripWavHeader removes 44-byte RIFF header", () => {
    const header = new Uint8Array(44)
    header[0] = 0x52 // R
    header[1] = 0x49 // I
    header[2] = 0x46 // F
    header[3] = 0x46 // F
    const body = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2])
    const wav = new Uint8Array([...header, ...body])
    expect(Array.from(stripWavHeader(wav))).toEqual(Array.from(body))
  })

  test("stripWavHeader leaves non-RIFF input unchanged", () => {
    const raw = new Uint8Array(100).fill(7)
    expect(stripWavHeader(raw)).toBe(raw)
  })

  test("resamplePcm16 same-rate is a defensive copy passthrough", () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0])
    const out = resamplePcm16(pcm, 24000, 24000)
    expect(Array.from(out)).toEqual(Array.from(pcm))
    expect(out).not.toBe(pcm) // copy, not alias
  })

  test("resamplePcm16 16k→24k upsamples (more samples out)", () => {
    // 4 samples in → ~6 out.
    const pcm = new Uint8Array(8) // 4 int16 samples
    const out = resamplePcm16(pcm, 16000, 24000)
    expect(out.byteLength).toBe(12) // 6 samples * 2 bytes
  })

  test("bridgeToRealtime strips + resamples deterministically", () => {
    const a = bridgeToRealtime(new Uint8Array([10, 0, 20, 0]), 24000, 24000)
    const b = bridgeToRealtime(new Uint8Array([10, 0, 20, 0]), 24000, 24000)
    expect(Array.from(a)).toEqual(Array.from(b)) // pure
  })
})

// ----------------------------------------------------------------------------
// session-config unit coverage (no invented heuristics)
// ----------------------------------------------------------------------------

describe("session-config (no invented heuristics)", () => {
  test("omitted VAD knobs are NOT emitted (API default applies)", () => {
    const p = buildSessionUpdate({ model: "m", mode: "server_vad", voice: "alloy" })
    const td = (p.session.audio as { input: { turn_detection: Record<string, unknown> } }).input
      .turn_detection
    expect(td.type).toBe("server_vad")
    expect("threshold" in td).toBe(false)
    expect("silence_duration_ms" in td).toBe(false)
    // behavior switches the RFC pins (not tuned numbers) ARE present.
    expect(td.interrupt_response).toBe(true)
    expect(td.create_response).toBe(true)
  })

  test("provided VAD knobs pass through verbatim", () => {
    const p = buildSessionUpdate({
      model: "m",
      mode: "server_vad",
      voice: "alloy",
      vad: { threshold: 0.42, prefixPaddingMs: 300, silenceDurationMs: 500 },
    })
    const td = (p.session.audio as { input: { turn_detection: Record<string, unknown> } }).input
      .turn_detection
    expect(td.threshold).toBe(0.42)
    expect(td.prefix_padding_ms).toBe(300)
    expect(td.silence_duration_ms).toBe(500)
  })

  test("push_to_talk emits turn_detection:null", () => {
    const p = buildSessionUpdate({ model: "m", mode: "push_to_talk", voice: "alloy" })
    const td = (p.session.audio as { input: { turn_detection: unknown } }).input.turn_detection
    expect(td).toBeNull()
  })
})
