/**
 * Hellgate — AudioRecorderPort (ADR-0208).
 *
 * 10 cases pinning the handle-based recorder contract. Each case mocks
 * the spawner so no real recorder process runs. Sibling to
 * `tests/unit/media/voice-input-hellgate.test.ts` (ADR-0202's one-shot
 * port); the two slices coexist on purpose — this one ships the
 * handle-based shape `/voice` needs.
 *
 *  HELL-VR-01: backend-missing default-OFF parity (no spawner found)
 *  HELL-VR-02: availability cascade (sox first, then arecord, then parec)
 *  HELL-VR-03: start → stop returns concatenated wav bytes
 *  HELL-VR-04: oversize cap SIGTERMs + returns oversize Err
 *  HELL-VR-05: stop is idempotent (second call returns same bytes)
 *  HELL-VR-06: AbortSignal pre-start ⇒ aborted Err, no spawn
 *  HELL-VR-07: AbortSignal mid-record ⇒ SIGTERM + aborted Err
 *  HELL-VR-08: spawn throws ⇒ spawn-failed Err with degradeReason
 *  HELL-VR-09: invalid-opts (bad rate / channels / format / maxBytes)
 *  HELL-VR-10: mac-mic-recorder pins to sox backend only
 */

import { describe, expect, test } from "bun:test"
import {
  ARECORD_BACKEND,
  createMacMicRecorder,
  createPlatformRecorder,
  DEFAULT_BACKENDS,
  PAREC_BACKEND,
  type RecorderSpawnedChild,
  type RecorderSpawner,
  SOX_BACKEND,
} from "@/voice"

const makeReadableStream = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> => {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      const c = chunks[i] as Uint8Array
      i += 1
      controller.enqueue(c)
    },
  })
}

interface FakeChildState {
  killed: number
  signals: (number | string | undefined)[]
}

const makeFakeChild = (
  chunks: ReadonlyArray<Uint8Array>,
  state: FakeChildState,
  opts?: { hangForever?: boolean },
): RecorderSpawnedChild => {
  let exitResolve: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => {
    exitResolve = r
  })
  if (opts?.hangForever !== true) {
    setTimeout(() => exitResolve(0), 0)
  }
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  let stream: ReadableStream<Uint8Array> | null
  if (opts?.hangForever === true) {
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
      },
    })
  } else {
    stream = makeReadableStream(chunks)
  }
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

interface FakeSpawnerOpts {
  readonly whichMap?: Readonly<Record<string, string | null>>
  readonly chunks?: ReadonlyArray<Uint8Array>
  readonly spawnThrow?: Error
  readonly state?: FakeChildState
  readonly hangForever?: boolean
}

const fakeSpawner = (opts: FakeSpawnerOpts): RecorderSpawner => {
  const state = opts.state ?? { killed: 0, signals: [] }
  return {
    which(cmd) {
      if (opts.whichMap !== undefined) return opts.whichMap[cmd] ?? null
      return `/usr/local/bin/${cmd}`
    },
    spawn(_argv) {
      if (opts.spawnThrow !== undefined) throw opts.spawnThrow
      return makeFakeChild(
        opts.chunks ?? [new Uint8Array([0x52, 0x49, 0x46, 0x46])],
        state,
        opts.hangForever !== undefined ? { hangForever: opts.hangForever } : {},
      )
    },
  }
}

describe("voice-recorder hellgate (ADR-0208)", () => {
  test("HELL-VR-01: backend-missing default-OFF parity", async () => {
    const spawner = fakeSpawner({ whichMap: { sox: null, arecord: null, parec: null } })
    const rec = createPlatformRecorder(spawner)
    expect(rec.availability()).toBeNull()
    const r = await rec.start()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("backend-missing")
      if (r.error.kind === "backend-missing") {
        expect(r.error.degradeReason.length).toBeGreaterThan(0)
      }
    }
  })

  test("HELL-VR-02: availability cascades sox → arecord → parec", () => {
    // sox first when all present
    const all = createPlatformRecorder(
      fakeSpawner({ whichMap: { sox: "/bin/sox", arecord: "/bin/arecord", parec: "/bin/parec" } }),
    )
    expect(all.availability()).toBe("sox")
    // arecord when sox missing
    const noSox = createPlatformRecorder(
      fakeSpawner({ whichMap: { sox: null, arecord: "/bin/arecord", parec: "/bin/parec" } }),
    )
    expect(noSox.availability()).toBe("arecord")
    // parec when sox + arecord missing
    const onlyParec = createPlatformRecorder(
      fakeSpawner({ whichMap: { sox: null, arecord: null, parec: "/bin/parec" } }),
    )
    expect(onlyParec.availability()).toBe("parec")
    // backend list is the documented cascade
    expect(DEFAULT_BACKENDS.map((b) => b.name)).toEqual([
      SOX_BACKEND.name,
      ARECORD_BACKEND.name,
      PAREC_BACKEND.name,
    ])
  })

  test("HELL-VR-03: start → stop returns concatenated wav bytes", async () => {
    const chunks = [new Uint8Array([0x52, 0x49, 0x46, 0x46]), new Uint8Array([0x10, 0x20, 0x30])]
    const rec = createPlatformRecorder(fakeSpawner({ chunks }))
    const startR = await rec.start({ rate: 16000, channels: 1, format: "wav" })
    expect(startR.ok).toBe(true)
    if (!startR.ok) return
    const stopR = await rec.stop(startR.value)
    expect(stopR.ok).toBe(true)
    if (!stopR.ok) return
    expect(stopR.value.format).toBe("wav")
    expect(stopR.value.rate).toBe(16000)
    expect(stopR.value.channels).toBe(1)
    expect(Array.from(stopR.value.bytes)).toEqual([0x52, 0x49, 0x46, 0x46, 0x10, 0x20, 0x30])
  })

  test("HELL-VR-04: oversize cap SIGTERMs + returns oversize Err", async () => {
    const state: FakeChildState = { killed: 0, signals: [] }
    // 1 KiB chunk, 4 chunks ⇒ 4 KiB; cap at 2 KiB ⇒ oversize trips on chunk #3.
    const oneK = new Uint8Array(1024)
    const chunks = [oneK, oneK, oneK, oneK]
    const rec = createPlatformRecorder(fakeSpawner({ chunks, state }))
    const startR = await rec.start({ maxBytes: 2048 })
    expect(startR.ok).toBe(true)
    if (!startR.ok) return
    const stopR = await rec.stop(startR.value)
    expect(stopR.ok).toBe(false)
    if (stopR.ok) return
    expect(stopR.error.kind).toBe("oversize")
    if (stopR.error.kind === "oversize") {
      expect(stopR.error.maxBytes).toBe(2048)
    }
    // stopAndDrain SIGTERMs unconditionally + the oversize path may add a
    // second kill — either is fine. The key invariant is "at least one kill".
    expect(state.killed).toBeGreaterThanOrEqual(1)
  })

  test("HELL-VR-05: stop is idempotent (second call returns same result)", async () => {
    const chunks = [new Uint8Array([0xaa, 0xbb])]
    const rec = createPlatformRecorder(fakeSpawner({ chunks }))
    const startR = await rec.start()
    expect(startR.ok).toBe(true)
    if (!startR.ok) return
    const stop1 = await rec.stop(startR.value)
    const stop2 = await rec.stop(startR.value)
    expect(stop1.ok).toBe(true)
    expect(stop2.ok).toBe(true)
    if (!stop1.ok || !stop2.ok) return
    expect(Array.from(stop1.value.bytes)).toEqual(Array.from(stop2.value.bytes))
  })

  test("HELL-VR-06: AbortSignal pre-start ⇒ aborted Err, no spawn attempt", async () => {
    let spawnCount = 0
    const spawner: RecorderSpawner = {
      which: () => "/bin/sox",
      spawn: (_argv) => {
        spawnCount += 1
        throw new Error("should not have spawned")
      },
    }
    const rec = createPlatformRecorder(spawner)
    const ac = new AbortController()
    ac.abort()
    const r = await rec.start({ signal: ac.signal })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("aborted")
    }
    expect(spawnCount).toBe(0)
  })

  test("HELL-VR-07: AbortSignal mid-record ⇒ SIGTERM + aborted Err", async () => {
    const state: FakeChildState = { killed: 0, signals: [] }
    const rec = createPlatformRecorder(fakeSpawner({ state, hangForever: true }))
    const ac = new AbortController()
    const startR = await rec.start({ signal: ac.signal })
    expect(startR.ok).toBe(true)
    if (!startR.ok) return
    // fire abort BEFORE stop
    ac.abort()
    const stopR = await rec.stop(startR.value)
    expect(stopR.ok).toBe(false)
    if (stopR.ok) return
    expect(stopR.error.kind).toBe("aborted")
    expect(state.killed).toBeGreaterThanOrEqual(1)
    expect(state.signals.some((s) => s === "SIGTERM")).toBe(true)
  })

  test("HELL-VR-08: spawn throws ⇒ spawn-failed Err with degradeReason", async () => {
    const rec = createPlatformRecorder(
      fakeSpawner({ spawnThrow: new Error("EPERM: bun.spawn denied") }),
    )
    const r = await rec.start()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("spawn-failed")
      if (r.error.kind === "spawn-failed") {
        expect(r.error.degradeReason).toContain("EPERM")
      }
    }
  })

  test("HELL-VR-09: invalid-opts (bad rate / channels / format / maxBytes)", async () => {
    const rec = createPlatformRecorder(fakeSpawner({}))
    const badRate = await rec.start({ rate: 0 })
    expect(badRate.ok).toBe(false)
    if (!badRate.ok) expect(badRate.error.kind).toBe("invalid-opts")

    const badRate2 = await rec.start({ rate: Number.NaN })
    expect(badRate2.ok).toBe(false)
    if (!badRate2.ok) expect(badRate2.error.kind).toBe("invalid-opts")

    // channels is typed as 1 | 2 at compile-time, so we cast through unknown
    // to drive the runtime guard path.
    const badCh = await rec.start({
      channels: 3 as unknown as 1,
    })
    expect(badCh.ok).toBe(false)
    if (!badCh.ok) expect(badCh.error.kind).toBe("invalid-opts")

    const badFmt = await rec.start({
      format: "mp3" as unknown as "wav",
    })
    expect(badFmt.ok).toBe(false)
    if (!badFmt.ok) expect(badFmt.error.kind).toBe("invalid-opts")

    const badCap = await rec.start({ maxBytes: -1 })
    expect(badCap.ok).toBe(false)
    if (!badCap.ok) expect(badCap.error.kind).toBe("invalid-opts")
  })

  test("HELL-VR-10: mac-mic-recorder pins to sox backend only", async () => {
    // With sox missing + arecord present, the default recorder would pick
    // arecord; the mac recorder MUST return null (sox-only cascade).
    const mac = createMacMicRecorder(
      fakeSpawner({ whichMap: { sox: null, arecord: "/bin/arecord", parec: "/bin/parec" } }),
    )
    expect(mac.availability()).toBeNull()
    const r = await mac.start()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("backend-missing")

    // With sox present, mac recorder picks sox.
    const macOk = createMacMicRecorder(fakeSpawner({ whichMap: { sox: "/bin/sox" } }))
    expect(macOk.availability()).toBe("sox")
  })
})
