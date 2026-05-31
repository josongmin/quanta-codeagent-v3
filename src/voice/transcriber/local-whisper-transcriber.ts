/**
 * Local whisper.cpp transcriber (ADR-0208).
 *
 * Spawns the `whisper-cpp` (or `whisper.cpp/main`) binary the user
 * separately installed (`brew install whisper-cpp`). Writes the audio to
 * a temp file (whisper.cpp does not accept stdin reliably), invokes the
 * binary with `-otxt -of <stem>`, reads the resulting `<stem>.txt`, and
 * deletes both. No network call, no API key required.
 *
 * Useful for:
 *   - offline / air-gapped environments
 *   - cost-sensitive batch transcription
 *   - privacy-sensitive audio that cannot leave the machine
 *
 * Limitations:
 *   - whisper.cpp emits text-only by default (no per-segment timing
 *     unless `-osrt` is also passed; we DON'T parse srt here — segments
 *     remain omitted)
 *   - language is `-l` flag; auto-detect via `-l auto`
 *
 * Plane-clean: imports only `@/shared` + sibling types + `node:fs` +
 * `node:os` + `node:path` for the temp-file dance. Zero @/agent /
 * @/tool / @/llm / @/mcp / @/permission.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drainAbortable, err, errMessage, isAbort, ok, type Result } from "@/shared"
import type { TranscribeReq, TranscriberError, TranscriberPort, VoiceTranscript } from "./port"

/** Spawned-binary surface — tests inject a fake spawner so no real
 *  whisper.cpp process runs. */
export interface WhisperBinaryChild {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  kill(signal?: number | string): void
}

export interface WhisperBinarySpawner {
  which(cmd: string): string | null
  spawn(argv: readonly string[]): WhisperBinaryChild
}

/** File-system surface — tests inject an in-memory shim so no real
 *  temp files are written. Mirrors the `node:fs/promises` shape we use. */
export interface WhisperFileSystem {
  mkdtemp(prefix: string): Promise<string>
  writeFile(path: string, data: Uint8Array): Promise<void>
  readFile(path: string, encoding: "utf-8"): Promise<string>
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>
}

export const defaultWhisperBinarySpawner = (): WhisperBinarySpawner => ({
  which(cmd) {
    return Bun.which(cmd) ?? null
  },
  spawn(argv) {
    const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      kill: (sig?: number | string) => proc.kill(sig as number | undefined),
    }
  },
})

export const defaultWhisperFs = (): WhisperFileSystem => ({
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data),
  readFile: (path, enc) => readFile(path, enc),
  rm: (path, opts) => rm(path, opts),
})

export interface LocalWhisperOpts {
  /** Binary name on PATH. Defaults to `whisper-cpp` (brew formula);
   *  set to `main` (raw whisper.cpp build) or absolute path as needed. */
  readonly binary?: string
  /** Model path (`-m`). Defaults to undefined — caller MUST provide
   *  when constructing for non-default model location. The binary
   *  errors out clearly when missing; we surface as `transcription-failed`. */
  readonly modelPath?: string
  /** Threads (`-t`). Defaults to 4 (whisper.cpp tunable; safe mid). */
  readonly threads?: number
  readonly spawner?: WhisperBinarySpawner
  readonly fs?: WhisperFileSystem
  /** Per-request timeout. Defaults to 120 s — local CPU inference is
   *  slower than network round-trip. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

const BIN_MISSING_MSG =
  "whisper-cpp not found on PATH. Install via `brew install whisper-cpp` (macOS) or build from https://github.com/ggerganov/whisper.cpp."

/**
 * Drain a child pipe to completion, collecting chunks. Consumes the SHARED
 * `@/shared` `drainAbortable` primitive (ticket T09 / audit L9 H3) so that:
 *   - BOTH stdout and stderr are read to EOF — leaving stdout undrained let
 *     whisper.cpp's verbose progress fill the OS pipe buffer and DEADLOCK the
 *     child (it blocks on `write()` while we wait on `exited`). This was the
 *     reported H3 hang.
 *   - on abort/timeout the underlying reader is CANCELLED (releasing the pipe
 *     / fd), not merely abandoned mid-iteration.
 *
 * Returns the decoded text. An abort mid-drain is swallowed here (the caller
 * classifies the run outcome from `aborted`/`timedOut`); we still surface
 * whatever bytes arrived before cancellation.
 */
const drainPipe = async (
  stream: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined,
): Promise<string> => {
  if (stream === null) return ""
  const chunks: Uint8Array[] = []
  // Wrap the stream so `getReader()` resolves the DEFAULT reader (no BYOB
  // overload) — the structural `AbortableReadable` the primitive expects.
  const source = {
    getReader: () => stream.getReader(),
  }
  try {
    await drainAbortable<Uint8Array>(
      source,
      (chunk) => {
        if (chunk !== undefined) chunks.push(chunk)
      },
      signal !== undefined ? { signal } : {},
    )
  } catch (e) {
    // Abort/timeout is expected when the run is cancelled — the reader was
    // cancelled by the primitive, releasing the pipe. Re-throw genuine errors.
    if (!isAbort(e)) throw e
  }
  if (chunks.length === 0) return ""
  let total = 0
  for (const c of chunks) total += c.byteLength
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(merged)
}

const buildArgv = (
  binary: string,
  audioPath: string,
  outStem: string,
  opts: { modelPath: string | undefined; threads: number; language: string | undefined },
): readonly string[] => {
  const argv: string[] = [binary, "-f", audioPath, "-otxt", "-of", outStem, "-nt"]
  if (opts.modelPath !== undefined) argv.push("-m", opts.modelPath)
  argv.push("-t", String(opts.threads))
  argv.push("-l", opts.language ?? "auto")
  return argv
}

interface RunBinaryArgs {
  readonly child: WhisperBinaryChild
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  readonly startedAt: number
}

interface RunBinaryResult {
  readonly outcome: "exit-0" | "exit-nonzero" | "aborted" | "timeout"
  readonly code: number
  readonly stderr: string
  readonly elapsedMs: number
}

const runBinary = async (args: RunBinaryArgs): Promise<RunBinaryResult> => {
  let timedOut = false
  let aborted = false
  // ONE controller drives BOTH pipe drains: when the child is killed (caller
  // abort OR deadline) we cancel the readers so the drain promises settle and
  // release the fds instead of hanging on a pipe that will never EOF.
  const drainController = new AbortController()
  const onAbort = (): void => {
    aborted = true
    try {
      args.child.kill("SIGTERM")
    } catch {}
    drainController.abort()
  }
  if (args.signal !== undefined) {
    if (args.signal.aborted) onAbort()
    else args.signal.addEventListener("abort", onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    try {
      args.child.kill("SIGTERM")
    } catch {}
    drainController.abort()
  }, args.timeoutMs)

  // Drain BOTH pipes CONCURRENTLY (audit L9 H3): stdout MUST be consumed or
  // whisper.cpp blocks on a full pipe and `exited` never resolves.
  const stdoutPromise = drainPipe(args.child.stdout, drainController.signal)
  const stderrPromise = drainPipe(args.child.stderr, drainController.signal)
  let code: number
  try {
    code = await args.child.exited
  } finally {
    clearTimeout(timer)
    if (args.signal !== undefined) args.signal.removeEventListener("abort", onAbort)
    // The child has exited (or been killed); stop the drains and release the
    // pipes regardless of which path we took.
    drainController.abort()
  }
  // Collect whatever the pipes yielded (drains settle promptly post-abort).
  const [, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  const elapsedMs = Date.now() - args.startedAt
  if (timedOut) return { outcome: "timeout", code, stderr, elapsedMs }
  if (aborted) return { outcome: "aborted", code, stderr, elapsedMs }
  if (code !== 0) return { outcome: "exit-nonzero", code, stderr, elapsedMs }
  return { outcome: "exit-0", code, stderr, elapsedMs }
}

interface TempDirCtx {
  readonly dir: string
  readonly audioPath: string
  readonly outStem: string
  readonly outTxt: string
}

const makeTempCtx = async (fs: WhisperFileSystem, audio: Uint8Array): Promise<TempDirCtx> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quanta-voice-"))
  const audioPath = join(dir, "audio.wav")
  await fs.writeFile(audioPath, audio)
  const outStem = join(dir, "out")
  return { dir, audioPath, outStem, outTxt: `${outStem}.txt` }
}

const cleanup = async (fs: WhisperFileSystem, dir: string): Promise<void> => {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {}
}

export const createLocalWhisperTranscriber = (opts: LocalWhisperOpts = {}): TranscriberPort => {
  const binary = opts.binary ?? "whisper-cpp"
  const spawner = opts.spawner ?? defaultWhisperBinarySpawner()
  const fs = opts.fs ?? defaultWhisperFs()
  const threads = opts.threads ?? 4
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async transcribe(req: TranscribeReq): Promise<Result<VoiceTranscript, TranscriberError>> {
      if (req.format !== "wav") {
        // whisper.cpp accepts wav natively; webm needs ffmpeg conversion
        // which we don't bundle. Surface as unsupported-format so the
        // surface can re-record with format:"wav".
        return err({ kind: "unsupported-format", format: req.format })
      }
      if (req.audio.byteLength === 0) {
        return err({ kind: "empty-audio" })
      }
      if (req.signal?.aborted === true) {
        return err({ kind: "aborted" })
      }
      if (spawner.which(binary) === null) {
        return err({
          kind: "transcription-failed",
          status: 0,
          degradeReason: BIN_MISSING_MSG,
        })
      }
      const ctx = await makeTempCtx(fs, req.audio)
      try {
        const argv = buildArgv(binary, ctx.audioPath, ctx.outStem, {
          modelPath: opts.modelPath,
          threads,
          language: req.language,
        })
        let child: WhisperBinaryChild
        try {
          child = spawner.spawn(argv)
        } catch (e) {
          return err({
            kind: "transcription-failed",
            status: 0,
            degradeReason: errMessage(e),
          })
        }
        const startedAt = Date.now()
        const r = await runBinary({ child, timeoutMs, signal: req.signal, startedAt })
        if (r.outcome === "aborted") return err({ kind: "aborted" })
        if (r.outcome === "timeout") return err({ kind: "timeout", elapsedMs: r.elapsedMs })
        if (r.outcome === "exit-nonzero") {
          return err({
            kind: "transcription-failed",
            status: r.code,
            degradeReason: r.stderr.length > 0 ? r.stderr : `whisper-cpp exited ${r.code}`,
          })
        }
        let text: string
        try {
          text = (await fs.readFile(ctx.outTxt, "utf-8")).trim()
        } catch (e) {
          return err({
            kind: "transcription-failed",
            status: 0,
            degradeReason: `whisper-cpp output not found: ${errMessage(e)}`,
          })
        }
        if (text.length === 0) {
          return err({ kind: "no-transcription", degradeReason: "whisper-cpp produced empty text" })
        }
        return ok({ text })
      } finally {
        await cleanup(fs, ctx.dir)
      }
    },
  }
}
