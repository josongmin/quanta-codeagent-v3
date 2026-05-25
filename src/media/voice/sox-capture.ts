import { err, ok, type Result } from "@/shared"
import type { CaptureOpts, VoiceInputPort } from "./port"
import type { AudioBlob, CaptureError } from "./types"

/** Minimal Bun.spawn surface this module relies on. Lets tests inject a
 *  fake spawner without pulling in node:child_process types. */
export interface SoxSpawnedChild {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  kill(signal?: number | string): void
}

export interface SoxSpawner {
  which(cmd: string): string | null
  spawn(argv: readonly string[]): SoxSpawnedChild
}

const DEFAULT_SECS = 5

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

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  return concatChunks(chunks)
}

/** Build a sox argv that records `secs` of 16kHz mono wav to stdout. */
export const buildSoxArgv = (secs: number): readonly string[] => [
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
  String(secs),
]

/** Production spawner — uses Bun.which + Bun.spawn directly. */
export const defaultSoxSpawner = (): SoxSpawner => ({
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

const SOX_MISSING_MSG =
  "sox not found on PATH. Install via `brew install sox` (macOS) or `apt install sox` (Linux), then retry."

const safeKill = (child: SoxSpawnedChild, sig: string): void => {
  try {
    child.kill(sig)
  } catch {}
}

const trySpawn = (
  spawner: SoxSpawner,
  argv: readonly string[],
): Result<SoxSpawnedChild, CaptureError> => {
  try {
    return ok(spawner.spawn(argv))
  } catch (e) {
    return err({
      kind: "spawn-failed",
      degradeReason: e instanceof Error ? e.message : String(e),
    })
  }
}

const preflightArgs = (
  opts: CaptureOpts | undefined,
  spawner: SoxSpawner,
): { kind: "ok"; secs: number } | { kind: "err"; err: CaptureError } => {
  const secs = opts?.secs ?? DEFAULT_SECS
  if (!Number.isFinite(secs) || secs <= 0) {
    return { kind: "err", err: { kind: "invalid-duration", secs } }
  }
  if (spawner.which("sox") === null) {
    return {
      kind: "err",
      err: { kind: "sox-missing", degradeReason: SOX_MISSING_MSG },
    }
  }
  if (opts?.signal?.aborted === true) {
    return { kind: "err", err: { kind: "aborted" } }
  }
  return { kind: "ok", secs }
}

interface RunRecorderArgs {
  readonly child: SoxSpawnedChild
  readonly secs: number
  readonly signal: AbortSignal | undefined
}

const runRecorder = async (args: RunRecorderArgs): Promise<Result<AudioBlob, CaptureError>> => {
  const { child, secs, signal } = args
  if (child.stdout === null) {
    safeKill(child, "SIGTERM")
    return err({ kind: "spawn-failed", degradeReason: "stdout pipe was null" })
  }
  let abortFlag = false
  const onAbort = (): void => {
    abortFlag = true
    safeKill(child, "SIGTERM")
  }
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true })
  try {
    const [bytes] = await Promise.all([readAll(child.stdout), child.exited])
    if (abortFlag) return err({ kind: "aborted" })
    return ok({ mime: "audio/wav", bytes, durationMs: Math.round(secs * 1000) })
  } finally {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort)
  }
}

/** Construct a `VoiceInputPort` that shells out to `sox -d ...`. The
 *  spawner is injected so tests can drive every code path (missing-binary,
 *  abort-mid-capture, spawn-failure) without touching the system. */
export const createSoxVoiceInput = (spawner: SoxSpawner = defaultSoxSpawner()): VoiceInputPort => {
  let current: SoxSpawnedChild | undefined
  return {
    async captureOnce(opts?: CaptureOpts): Promise<Result<AudioBlob, CaptureError>> {
      const pre = preflightArgs(opts, spawner)
      if (pre.kind === "err") return err(pre.err)
      const spawned = trySpawn(spawner, buildSoxArgv(pre.secs))
      if (!spawned.ok) return spawned
      current = spawned.value
      try {
        return await runRecorder({ child: spawned.value, secs: pre.secs, signal: opts?.signal })
      } finally {
        current = undefined
      }
    },
    stop(): void {
      if (current !== undefined) safeKill(current, "SIGTERM")
    },
  }
}
