/**
 * Default cross-platform recorder (ADR-0208).
 *
 * Tries `sox` → `arecord` → `parec` in order; the first that resolves on
 * PATH wins. The spawner port is injected so tests don't touch the
 * system. Surfaces that need a specific backend can construct a
 * platform-pinned recorder directly via {@link createPlatformRecorder}.
 *
 * Plane-clean: imports only `@/shared` + sibling types. Zero @/agent /
 * @/tool / @/llm / @/mcp / @/permission.
 *
 * Contract:
 *   - `availability()`: returns the FIRST backend resolved on PATH, or
 *     `null` if none. Synchronous (uses `Bun.which` via the injected
 *     spawner — no I/O latency).
 *   - `start()`: spawns the resolved backend; if none resolves, returns
 *     `Err({kind:"backend-missing"})`. Records to stdout; the handle's
 *     internal closure drains stdout into a Uint8Array when `stop()` is
 *     called.
 *   - `stop()`: idempotent. SIGTERM the child, wait for `exited`, return
 *     the accumulated bytes. A second call returns the cached bytes
 *     (the handle's internal closure memoizes).
 *   - Oversize: when `maxBytes` is exceeded, the stream reader SIGTERMs
 *     the child immediately and `stop()` returns `Err({kind:"oversize"})`.
 *     Buffered bytes up to the cap are DISCARDED — the surface treats
 *     oversize as "no audio captured" to avoid sending a truncated wav
 *     to the transcriber.
 */

import { err, ok, type Result } from "@/shared"
import type { AudioRecorderPort } from "./port"
import type {
  AudioBytes,
  RecorderError,
  RecorderHandle,
  RecorderInternalResult,
  RecorderStartOpts,
} from "./types"

/** Spawned-child surface this module reads — mirrors the
 *  `SoxSpawnedChild` shape in `@/media/voice/sox-capture` so tests
 *  written for that slice can share fixture helpers. */
export interface RecorderSpawnedChild {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  kill(signal?: number | string): void
}

/** Injected spawner port — tests drive every code path without touching
 *  the system. The `which` method returns the absolute path or `null`. */
export interface RecorderSpawner {
  which(cmd: string): string | null
  spawn(argv: readonly string[]): RecorderSpawnedChild
}

/** Recorder backend descriptor. The `argv` builder knows how to render the
 *  backend's command line for the requested rate/channels/format. */
export interface RecorderBackend {
  readonly name: string
  readonly bin: string
  buildArgv(opts: { rate: number; channels: 1 | 2; format: "wav" | "webm" }): readonly string[]
}

/** sox: cross-platform, brew/apt installable, emits wav to stdout. */
export const SOX_BACKEND: RecorderBackend = {
  name: "sox",
  bin: "sox",
  buildArgv: ({ rate, channels, format }) => [
    "sox",
    "-d",
    "-t",
    format === "wav" ? "wav" : "wav",
    "-",
    "rate",
    String(rate),
    "channels",
    String(channels),
  ],
}

/** arecord (Linux ALSA): default Ubuntu install, wav to stdout. */
export const ARECORD_BACKEND: RecorderBackend = {
  name: "arecord",
  bin: "arecord",
  buildArgv: ({ rate, channels }) => [
    "arecord",
    "-q",
    "-f",
    channels === 1 ? "S16_LE" : "S16_LE",
    "-r",
    String(rate),
    "-c",
    String(channels),
    "-t",
    "wav",
  ],
}

/** parec (Linux PulseAudio): pipes raw PCM — recorder wraps in a wav
 *  header when stop() drains. Used when alsa isn't available. */
export const PAREC_BACKEND: RecorderBackend = {
  name: "parec",
  bin: "parec",
  buildArgv: ({ rate, channels }) => [
    "parec",
    "--format=s16le",
    `--rate=${rate}`,
    `--channels=${channels}`,
  ],
}

/** Default cascade — sox preferred (most portable + best smart-trim),
 *  arecord second (ubiquitous on Linux), parec last (PulseAudio-only). */
export const DEFAULT_BACKENDS: ReadonlyArray<RecorderBackend> = [
  SOX_BACKEND,
  ARECORD_BACKEND,
  PAREC_BACKEND,
]

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024 // 25 MiB

/** Production spawner — uses Bun.which + Bun.spawn directly. */
export const defaultRecorderSpawner = (): RecorderSpawner => ({
  which(cmd) {
    return Bun.which(cmd) ?? null
  },
  spawn(argv) {
    const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" })
    return {
      stdout: proc.stdout,
      exited: proc.exited,
      kill: (sig?: number | string) => proc.kill(sig as number | undefined),
    }
  },
})

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

const safeKill = (child: RecorderSpawnedChild, sig: string): void => {
  try {
    child.kill(sig)
  } catch {}
}

const BACKEND_MISSING_MSG =
  "No audio recorder found on PATH. Install one of: `sox` (brew/apt), `arecord` (alsa-utils), or `parec` (pulseaudio-utils)."

const resolveBackend = (
  spawner: RecorderSpawner,
  backends: ReadonlyArray<RecorderBackend>,
): RecorderBackend | null => {
  for (const b of backends) {
    if (spawner.which(b.bin) !== null) return b
  }
  return null
}

/** Validate `start()` opts. Returns `Err` for programmer-bug input
 *  (non-finite rate, channels out of {1,2}, maxBytes ≤ 0). */
const validateOpts = (
  opts: RecorderStartOpts | undefined,
):
  | { kind: "ok"; rate: number; channels: 1 | 2; format: "wav" | "webm"; maxBytes: number }
  | {
      kind: "err"
      err: RecorderError
    } => {
  const rate = opts?.rate ?? 16000
  const channels = opts?.channels ?? 1
  const format = opts?.format ?? "wav"
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isFinite(rate) || rate <= 0) {
    return { kind: "err", err: { kind: "invalid-opts", degradeReason: `bad rate: ${rate}` } }
  }
  if (channels !== 1 && channels !== 2) {
    return {
      kind: "err",
      err: { kind: "invalid-opts", degradeReason: `bad channels: ${String(channels)}` },
    }
  }
  if (format !== "wav" && format !== "webm") {
    return {
      kind: "err",
      err: { kind: "invalid-opts", degradeReason: `bad format: ${String(format)}` },
    }
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      kind: "err",
      err: { kind: "invalid-opts", degradeReason: `bad maxBytes: ${maxBytes}` },
    }
  }
  return { kind: "ok", rate, channels, format, maxBytes }
}

interface BuildHandleArgs {
  readonly backend: RecorderBackend
  readonly child: RecorderSpawnedChild
  readonly rate: number
  readonly channels: 1 | 2
  readonly format: "wav" | "webm"
  readonly maxBytes: number
  readonly signal: AbortSignal | undefined
}

/** Build the internal closure that drains stdout + tracks oversize.
 *  Memoizes its own result so the public `stop()` is idempotent. */
const buildInternalStop = (args: BuildHandleArgs): RecorderHandle["_internal"] => {
  const { child, maxBytes, signal } = args
  let cached: RecorderInternalResult | undefined
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    safeKill(child, "SIGTERM")
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      aborted = true
      safeKill(child, "SIGTERM")
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  }

  const stopAndDrain = async (): Promise<RecorderInternalResult> => {
    if (cached !== undefined) return cached
    // SIGTERM first so the recorder stops accumulating; then drain whatever
    // it already flushed to the pipe.
    safeKill(child, "SIGTERM")
    if (child.stdout === null) {
      cached = { ok: false, error: { kind: "io-error", degradeReason: "stdout pipe was null" } }
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
      return cached
    }
    const chunks: Uint8Array[] = []
    let total = 0
    let over = false
    try {
      const reader = child.stdout.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        total += value.byteLength
        if (total > maxBytes) {
          over = true
          break
        }
        chunks.push(value)
      }
      await child.exited
    } catch (e) {
      cached = {
        ok: false,
        error: {
          kind: "io-error",
          degradeReason: e instanceof Error ? e.message : String(e),
        },
      }
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
      return cached
    }
    if (signal !== undefined) signal.removeEventListener("abort", onAbort)
    if (aborted) {
      cached = { ok: false, error: { kind: "aborted" } }
      return cached
    }
    if (over) {
      cached = { ok: false, error: { kind: "oversize", maxBytes } }
      return cached
    }
    cached = { ok: true, bytes: concatChunks(chunks) }
    return cached
  }

  return {
    stopAndDrain,
    kill: (sig: string) => safeKill(child, sig),
  }
}

/** Create a recorder bound to a specific backend cascade. The default
 *  cascade is `[sox, arecord, parec]`; tests pass a single-element list
 *  to pin the backend under test. */
export const createPlatformRecorder = (
  spawner: RecorderSpawner = defaultRecorderSpawner(),
  backends: ReadonlyArray<RecorderBackend> = DEFAULT_BACKENDS,
): AudioRecorderPort => {
  return {
    availability(): string | null {
      const b = resolveBackend(spawner, backends)
      return b === null ? null : b.name
    },

    async start(opts?: RecorderStartOpts): Promise<Result<RecorderHandle, RecorderError>> {
      const v = validateOpts(opts)
      if (v.kind === "err") return err(v.err)
      const backend = resolveBackend(spawner, backends)
      if (backend === null) {
        return err({ kind: "backend-missing", degradeReason: BACKEND_MISSING_MSG })
      }
      if (opts?.signal?.aborted === true) {
        return err({ kind: "aborted" })
      }
      let child: RecorderSpawnedChild
      try {
        child = spawner.spawn(
          backend.buildArgv({ rate: v.rate, channels: v.channels, format: v.format }),
        )
      } catch (e) {
        return err({
          kind: "spawn-failed",
          degradeReason: e instanceof Error ? e.message : String(e),
        })
      }
      const internal = buildInternalStop({
        backend,
        child,
        rate: v.rate,
        channels: v.channels,
        format: v.format,
        maxBytes: v.maxBytes,
        signal: opts?.signal,
      })
      return ok({
        backend: backend.name,
        format: v.format,
        rate: v.rate,
        channels: v.channels,
        _internal: internal,
      })
    },

    async stop(handle: RecorderHandle): Promise<Result<AudioBytes, RecorderError>> {
      const r = await handle._internal.stopAndDrain()
      if (!r.ok) return err(r.error)
      return ok({
        format: handle.format,
        bytes: r.bytes,
        rate: handle.rate,
        channels: handle.channels,
      })
    },
  }
}

/** Default-cascade convenience constructor. Equivalent to
 *  `createPlatformRecorder()` with no args. */
export const createDefaultRecorder = (
  spawner: RecorderSpawner = defaultRecorderSpawner(),
): AudioRecorderPort => createPlatformRecorder(spawner, DEFAULT_BACKENDS)
