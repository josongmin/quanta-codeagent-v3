/**
 * HELLGATE — local whisper.cpp stdout drain + timeout/cancel (audit L9 H3,
 * ticket T09).
 *
 * The pre-T09 `runBinary` drained ONLY stderr; stdout was never read. With a
 * verbose whisper.cpp build the stdout pipe filled, the child blocked on
 * `write()`, and `await child.exited` hung forever. These cases pin:
 *
 *  HELL-WSP-01  stdout IS drained — `exited` that only resolves AFTER stdout
 *               is consumed completes (no deadlock)
 *  HELL-WSP-02  abort mid-run cancels the stdout reader + returns aborted
 *  HELL-WSP-03  timeout kills the child + returns timeout (drains release)
 *  HELL-WSP-04  large stdout (256 chunks) drains without wedging
 *  HELL-WSP-05  happy path still reads the output txt file
 */
import { describe, expect, test } from "bun:test"
import {
  createLocalWhisperTranscriber,
  type WhisperBinaryChild,
  type WhisperBinarySpawner,
  type WhisperFileSystem,
} from "../local-whisper-transcriber"

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A ReadableStream that yields `n` chunks then closes, recording whether it
 *  was fully drained or cancelled. When `neverClose` is set it keeps the
 *  stream open after the chunks (models a child that holds the pipe open and
 *  blocks — the deadlock the drain+abort/timeout must break). */
const makeStream = (
  chunks: ReadonlyArray<Uint8Array>,
  track: { drained: boolean; cancelled: boolean },
  neverClose = false,
): ReadableStream<Uint8Array> => {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        const c = chunks[i++]
        if (c !== undefined) controller.enqueue(c)
        return
      }
      if (neverClose) return // leave the read() pending forever
      track.drained = true
      controller.close()
    },
    cancel() {
      track.cancelled = true
    },
  })
}

const memFs = (outText: string): WhisperFileSystem => ({
  async mkdtemp(prefix) {
    return `${prefix}XXXX`
  },
  async writeFile() {},
  async readFile() {
    return outText
  },
  async rm() {},
})

interface ChildOpts {
  readonly stdoutChunks: ReadonlyArray<Uint8Array>
  readonly stderrChunks?: ReadonlyArray<Uint8Array>
  /** When true, `exited` only resolves once stdout has been fully drained —
   *  models the real deadlock (child blocks on a full pipe). */
  readonly exitAfterStdoutDrain?: boolean
  readonly exitCode?: number
}

const makeSpawner = (
  o: ChildOpts,
): {
  spawner: WhisperBinarySpawner
  stdoutTrack: { drained: boolean; cancelled: boolean }
  child: () => WhisperBinaryChild
} => {
  const stdoutTrack = { drained: false, cancelled: false }
  const stderrTrack = { drained: false, cancelled: false }
  let resolveExit: ((code: number) => void) | undefined
  let killed = false
  const exited = new Promise<number>((res) => {
    resolveExit = res
  })
  const stdout = makeStream(o.stdoutChunks, stdoutTrack, o.exitAfterStdoutDrain !== true)
  const stderr = makeStream(o.stderrChunks ?? [], stderrTrack)
  // Poll: resolve `exited` only when the child would naturally finish. When
  // `exitAfterStdoutDrain` is set, that's once stdout is fully drained (models
  // a well-behaved child). Otherwise the child holds the pipe open and only a
  // `kill()` (abort/timeout) ends it — so we resolve solely on `killed`.
  const tick = (): void => {
    const ready =
      (o.exitAfterStdoutDrain === true && (stdoutTrack.drained || stdoutTrack.cancelled)) || killed
    if (ready) resolveExit?.(o.exitCode ?? 0)
    else setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
  const child: WhisperBinaryChild = {
    stdout,
    stderr,
    exited,
    kill() {
      killed = true
      resolveExit?.(o.exitCode ?? 0)
    },
  }
  return {
    spawner: {
      which: () => "/usr/bin/whisper-cpp",
      spawn: () => child,
    },
    stdoutTrack,
    child: () => child,
  }
}

describe("local whisper stdout drain + timeout/cancel (L9 H3)", () => {
  test("HELL-WSP-01: stdout is drained — exit-gated-on-drain run completes", async () => {
    const { spawner, stdoutTrack } = makeSpawner({
      stdoutChunks: [enc("[00:00] progress\n"), enc("[00:01] more\n")],
      exitAfterStdoutDrain: true,
    })
    const t = createLocalWhisperTranscriber({ spawner, fs: memFs("hello world"), timeoutMs: 5000 })
    const res = await t.transcribe({ audio: enc("RIFFwav"), format: "wav" })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.text).toBe("hello world")
    expect(stdoutTrack.drained).toBe(true)
  })

  test("HELL-WSP-02: abort mid-run cancels stdout reader + returns aborted", async () => {
    const ctrl = new AbortController()
    const { spawner, stdoutTrack } = makeSpawner({
      stdoutChunks: [enc("x\n")],
      exitAfterStdoutDrain: false, // would hang forever absent the abort
    })
    const t = createLocalWhisperTranscriber({ spawner, fs: memFs(""), timeoutMs: 60_000 })
    const p = t.transcribe({ audio: enc("RIFF"), format: "wav", signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 5)
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe("aborted")
    expect(stdoutTrack.cancelled).toBe(true)
  })

  test("HELL-WSP-03: timeout kills child + returns timeout", async () => {
    const { spawner } = makeSpawner({
      stdoutChunks: [enc("x\n")],
      exitAfterStdoutDrain: false,
    })
    const t = createLocalWhisperTranscriber({ spawner, fs: memFs(""), timeoutMs: 10 })
    const res = await t.transcribe({ audio: enc("RIFF"), format: "wav" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe("timeout")
  })

  test("HELL-WSP-04: large stdout (256 chunks) drains without wedging", async () => {
    const chunks = Array.from({ length: 256 }, (_, i) => enc(`line-${i}\n`))
    const { spawner, stdoutTrack } = makeSpawner({
      stdoutChunks: chunks,
      exitAfterStdoutDrain: true,
    })
    const t = createLocalWhisperTranscriber({ spawner, fs: memFs("ok"), timeoutMs: 5000 })
    const res = await t.transcribe({ audio: enc("RIFF"), format: "wav" })
    expect(res.ok).toBe(true)
    expect(stdoutTrack.drained).toBe(true)
  })

  test("HELL-WSP-05: happy path reads the output txt", async () => {
    const { spawner } = makeSpawner({ stdoutChunks: [], exitAfterStdoutDrain: true })
    const t = createLocalWhisperTranscriber({
      spawner,
      fs: memFs("transcript text"),
      timeoutMs: 5000,
    })
    const res = await t.transcribe({ audio: enc("RIFF"), format: "wav" })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.text).toBe("transcript text")
  })
})
