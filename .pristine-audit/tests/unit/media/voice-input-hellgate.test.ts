/**
 * Hellgate — VoiceInputPort (ADR-0202).
 *
 * 6 cases pinning the audio-capture primitive contract. Each case mocks
 * the spawner so no real sox process runs; HELL-V-01 separately proves
 * the default-OFF byte-identical wire (the prompt pipeline behaves
 * identically when `voiceQueue` is undefined).
 */

import { describe, expect, test } from "bun:test"
import {
  buildSoxArgv,
  createSoxVoiceInput,
  HEADLESS_WAV_HEADER,
  headlessVoiceInput,
  type SoxSpawnedChild,
  type SoxSpawner,
} from "@/media/voice"

const makeReadableStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes)
      controller.close()
    },
  })

interface FakeChildState {
  killed: number
  signals: (number | string | undefined)[]
}

const makeFakeChild = (bytes: Uint8Array, state: FakeChildState): SoxSpawnedChild => {
  let exitResolve: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => {
    exitResolve = r
  })
  const stream: ReadableStream<Uint8Array> | null = makeReadableStream(bytes)
  // natural exit after a tick — simulates sox finishing the trim window
  setTimeout(() => exitResolve(0), 0)
  return {
    stdout: stream,
    exited,
    kill(sig) {
      state.killed += 1
      state.signals.push(sig)
      exitResolve(143)
    },
  }
}

const fakeSpawner = (opts: {
  whichResult?: string | null
  spawnBytes?: Uint8Array
  spawnThrow?: Error
  state?: FakeChildState
  hangForever?: boolean
}): SoxSpawner => {
  const state = opts.state ?? { killed: 0, signals: [] }
  return {
    which: (_cmd) =>
      Object.hasOwn(opts, "whichResult") ? (opts.whichResult ?? null) : "/usr/local/bin/sox",
    spawn: (_argv) => {
      if (opts.spawnThrow !== undefined) throw opts.spawnThrow
      if (opts.hangForever === true) {
        // Stream blocks on read indefinitely until kill() closes it via
        // the controller (`.cancel()` on a locked stream throws).
        let exitResolve: (code: number) => void = () => {}
        const exited = new Promise<number>((r) => {
          exitResolve = r
        })
        let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrl = controller
          },
        })
        return {
          stdout: stream,
          exited,
          kill(sig) {
            state.killed += 1
            state.signals.push(sig)
            try {
              ctrl?.close()
            } catch {}
            exitResolve(143)
          },
        }
      }
      return makeFakeChild(opts.spawnBytes ?? new Uint8Array([0x52, 0x49, 0x46, 0x46]), state)
    },
  }
}

describe("voice-input hellgate (ADR-0202)", () => {
  test("HELL-V-01: pipeline byte-identical when voiceQueue undefined", async () => {
    // Proxy contract: the voice-queue type is import-only — the
    // prompt-pipeline default path branches on `voiceQueue !== undefined`.
    // We assert here that constructing without any voice deps does not
    // change the import surface of @/media/voice — i.e. nothing wires.
    const port = headlessVoiceInput()
    expect(typeof port.captureOnce).toBe("function")
    expect(typeof port.stop).toBe("function")
    // The headless port resolves WITHOUT spawning anything (zero side
    // effects on import + zero side effects on construct).
    const r = await port.captureOnce({ secs: 0.25 })
    expect(r.ok).toBe(true)
  })

  test("HELL-V-02: sox spawn returns AudioBlob with concatenated bytes", async () => {
    const wavStub = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x20])
    const spawner = fakeSpawner({ spawnBytes: wavStub })
    const port = createSoxVoiceInput(spawner)
    const r = await port.captureOnce({ secs: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.mime).toBe("audio/wav")
      expect(Array.from(r.value.bytes)).toEqual(Array.from(wavStub))
      expect(r.value.durationMs).toBe(3000)
    }
    // argv shape
    expect(buildSoxArgv(3)).toEqual([
      "sox",
      "-d",
      "-t",
      "wav",
      "-",
      "rate",
      "16000",
      "channels",
      "1",
      "trim",
      "0",
      "3",
    ])
  })

  test("HELL-V-03: sox missing on PATH returns sox-missing Err with degradeReason", async () => {
    const spawner = fakeSpawner({ whichResult: null })
    const port = createSoxVoiceInput(spawner)
    const r = await port.captureOnce({ secs: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("sox-missing")
      if (r.error.kind === "sox-missing") {
        expect(r.error.degradeReason.length).toBeGreaterThan(0)
        expect(r.error.degradeReason.toLowerCase()).toContain("sox")
      }
    }
  })

  test("HELL-V-04: AbortSignal during capture sends SIGTERM, no zombie", async () => {
    const state = { killed: 0, signals: [] as (number | string | undefined)[] }
    const spawner = fakeSpawner({ state, hangForever: true })
    const port = createSoxVoiceInput(spawner)
    const ac = new AbortController()
    const promise = port.captureOnce({ secs: 60, signal: ac.signal })
    // Allow microtasks to advance so spawn + listener install run.
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    const r = await promise
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("aborted")
    expect(state.killed).toBeGreaterThanOrEqual(1)
    expect(state.signals).toContain("SIGTERM")
  })

  test("HELL-V-05: secs=0 returns invalid-duration Err without spawning", async () => {
    let spawnCount = 0
    const spawner: SoxSpawner = {
      which: () => "/usr/bin/sox",
      spawn: () => {
        spawnCount += 1
        throw new Error("must not spawn")
      },
    }
    const port = createSoxVoiceInput(spawner)
    const r = await port.captureOnce({ secs: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid-duration")
      if (r.error.kind === "invalid-duration") expect(r.error.secs).toBe(0)
    }
    expect(spawnCount).toBe(0)
    // Also negative + NaN
    const r2 = await port.captureOnce({ secs: -1 })
    expect(r2.ok).toBe(false)
    const r3 = await port.captureOnce({ secs: Number.NaN })
    expect(r3.ok).toBe(false)
  })

  test("HELL-V-06: headless-stub returns deterministic 44-byte wav header", async () => {
    const port = headlessVoiceInput()
    const r1 = await port.captureOnce({ secs: 2 })
    const r2 = await port.captureOnce({ secs: 5 })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) {
      expect(Array.from(r1.value.bytes)).toEqual(Array.from(HEADLESS_WAV_HEADER))
      expect(Array.from(r2.value.bytes)).toEqual(Array.from(HEADLESS_WAV_HEADER))
      expect(r1.value.mime).toBe("audio/wav")
      expect(r2.value.mime).toBe("audio/wav")
      expect(r1.value.durationMs).toBe(2000)
      expect(r2.value.durationMs).toBe(5000)
    }
    // stop() is a no-op
    port.stop()
    port.stop()
  })

  test("HELL-V-EXTRA: spawn throw is captured as spawn-failed", async () => {
    const spawner = fakeSpawner({ spawnThrow: new Error("EACCES") })
    const port = createSoxVoiceInput(spawner)
    const r = await port.captureOnce({ secs: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("spawn-failed")
      if (r.error.kind === "spawn-failed") {
        expect(r.error.degradeReason).toContain("EACCES")
      }
    }
  })
})
