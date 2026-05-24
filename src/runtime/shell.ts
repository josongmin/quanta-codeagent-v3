import { escalatingKill, withSpawnedChild } from "./guarded-spawn"
import { scrubEnv } from "./sandbox"
import { getShellSandbox } from "./shell-sandbox-holder"
import type { RunShellEvent, ShellOptions, ShellResult } from "./types"

const DEFAULT_TIMEOUT_MS = 120_000

/** Run a command through the system shell. Captures stdout/stderr, never
 *  throws on non-zero exit (the caller decides what a failure means).
 *
 *  ENV SCRUBBING (ADR-0006, now actually enforced for tool execution): unless
 *  `inheritEnv: true` is passed, the child runs with a SCRUBBED env built by
 *  the shared {@link scrubEnv} (ONE source of truth — the allowlist lives in
 *  src/runtime/sandbox.ts, this module does not duplicate it). That means
 *  only PATH/HOME/LANG/LC_ALL/TZ/TERM (when present in the parent) reach the
 *  child; `*_API_KEY`/`*_TOKEN`/`*_SECRET` and every other parent var are
 *  dropped. All LLM-driven shell tools (bash/grep/localize/test-runner) call
 *  this without `inheritEnv`, so provider keys can no longer leak into a
 *  child process. Default behavior stays functional: PATH/HOME are forwarded
 *  when set, so normal commands (`echo`, `pwd`, `rg`, `bun test`) still run.
 *
 *  PR-5 / ADR-0081 — TYPED OUTPUT EVENTS. When `options.onShellEvent` is
 *  provided, the function emits a closed-union event stream IN ADDITION TO
 *  the accumulator that still produces the final `ShellResult`:
 *    1. exactly one `start` event with pid/command/cwd/startedAt,
 *    2. zero or more `stdout` / `stderr` chunks interleaved arbitrarily
 *       (each carries the per-stream byte `offset` of the chunk's first byte),
 *    3. exactly one terminal event — either `exit` (code/signal/exitedAt) or
 *       `aborted` (reason: user_abort | timeout, abortedAt) — emitted AFTER
 *       both pipes have drained.
 *  Concatenating all `stdout` chunks reproduces the bytes of `result.stdout`
 *  (and the same for stderr) — the streamed path runs through the SAME
 *  accumulator as the legacy buffered path, so a session that supplies an
 *  observer sees identical final output. When the observer is ABSENT, no
 *  events are emitted and the run is byte-identical to the pre-PR-5 path. */
export const runShell = async (
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOutFlag = false
  const cwd = options.cwd ?? process.cwd()
  const observer = options.onShellEvent

  // Scrubbed by default; opt OUT only with an explicit `inheritEnv: true`.
  // When inheriting we pass `process.env` explicitly (Bun.spawn snapshots the
  // original env if `env` is omitted and would miss vars set after startup).
  const env =
    options.inheritEnv === true ? (process.env as Record<string, string | undefined>) : scrubEnv()

  // S1 — OS sandbox wire-up. Default-OFF: when the CLI surface did not
  // install a slot (via `installShellSandbox`), `getShellSandbox()` returns
  // `undefined` and `argv` is the legacy `["bash","-lc",cmd]` byte-for-byte.
  // When installed, the slot wraps the argv with the active OS backend
  // (`sandbox-exec`, `bwrap`, `landlock-cli`) or an honest degraded
  // passthrough. Policy internals only flow INTO the spawn argv; they are
  // never echoed back to the tool result.
  const baseArgv: ReadonlyArray<string> = ["bash", "-lc", command]
  const slot = getShellSandbox()
  const argv = slot !== undefined ? (await slot.wrap(baseArgv, cwd)).argv : [...baseArgv]
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  // Emit `start` BEFORE we begin draining either pipe so observers see the
  // ordering invariant (start ≺ any stdout/stderr ≺ exit/aborted). The
  // `proc.pid` field is populated synchronously by Bun.spawn.
  if (observer) {
    const startEvent: RunShellEvent = {
      kind: "start",
      pid: proc.pid,
      command,
      cwd,
      startedAt: Date.now(),
    }
    observer(startEvent)
  }

  let abortReason: "user_abort" | "timeout" | null = null
  // SIGTERM→SIGKILL escalation: a child that traps/ignores SIGTERM is force-
  // killed after KILL_GRACE_MS. `disarm` clears the grace timer; we call it in
  // the guard's `cleanup` so it cannot leak past the child's lifetime.
  const { kill, disarm } = escalatingKill(proc)
  const onAbort = () => {
    if (abortReason === null) abortReason = "user_abort"
    kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOutFlag = true
    if (abortReason === null) abortReason = "timeout"
    kill()
  }, timeoutMs)

  // Per-stream byte accumulators. We collect chunks as Uint8Array and decode
  // ONCE at the end into UTF-8 strings — that is the SAME decoder
  // (TextDecoder defaulting to utf-8 via `new Response(...).text()`) the
  // legacy path uses. When an observer is present we additionally emit each
  // chunk with its pre-chunk byte offset; when ABSENT we still drain via
  // ReadableStream so the byte-level work is identical, then take the
  // single-call accumulator path — but the legacy code used
  // `new Response(stream).text()` which is the well-trodden hot path, so to
  // preserve byte-identical behavior in the no-observer case we DELEGATE to
  // exactly that path and never touch the reader. The two paths share the
  // same `Bun.spawn` invocation and the same kill/timeout/abort plumbing.
  let stdout: string
  let stderr: string

  if (observer) {
    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let stdoutOffset = 0
    let stderrOffset = 0

    const drain = async (
      stream: ReadableStream<Uint8Array>,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<void> => {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          if (value && value.byteLength > 0) onChunk(value)
        }
      } finally {
        reader.releaseLock()
      }
    }

    const stdoutDone = drain(proc.stdout as ReadableStream<Uint8Array>, (chunk) => {
      const event: RunShellEvent = { kind: "stdout", chunk, offset: stdoutOffset }
      stdoutOffset += chunk.byteLength
      stdoutChunks.push(chunk)
      observer(event)
    })
    const stderrDone = drain(proc.stderr as ReadableStream<Uint8Array>, (chunk) => {
      const event: RunShellEvent = { kind: "stderr", chunk, offset: stderrOffset }
      stderrOffset += chunk.byteLength
      stderrChunks.push(chunk)
      observer(event)
    })

    // GUARDED: kill-on-throw + timer/abort-listener teardown live in
    // `withSpawnedChild` (src/runtime/guarded-spawn.ts), not inline here. The
    // body emits the terminal `exit`/`aborted` event on its NORMAL-return path
    // only — a throw skips it, which is the contract (exactly one terminal on
    // normal/abort completion, none on an internal observer-thrown failure;
    // the guard kills the still-running child instead).
    return withSpawnedChild(
      {
        kill,
        timer,
        cleanup: () => {
          disarm()
          options.signal?.removeEventListener("abort", onAbort)
        },
      },
      async () => {
        await Promise.all([stdoutDone, stderrDone])
        const exitCode = await proc.exited
        const decoder = new TextDecoder("utf-8")
        stdout = decoder.decode(concat(stdoutChunks))
        stderr = decoder.decode(concat(stderrChunks))
        // Terminal event: aborted takes precedence (timeout/user_abort) over a
        // plain exit. `proc.exited` resolves with the OS exit code; on a kill
        // it is typically non-zero. Bun does not surface `NodeJS.Signals` on
        // its ShellPromise here, so we report `signal: null` and rely on the
        // `aborted` event to carry the reason.
        if (abortReason !== null) {
          const aborted: RunShellEvent = {
            kind: "aborted",
            reason: abortReason,
            abortedAt: Date.now(),
          }
          observer(aborted)
        } else {
          const exit: RunShellEvent = {
            kind: "exit",
            code: exitCode,
            signal: null,
            exitedAt: Date.now(),
          }
          observer(exit)
        }
        return { stdout, stderr, exitCode, timedOut: timedOutFlag }
      },
    )
  }

  // Legacy buffered path — byte-identical to the pre-PR-5 code. No observer
  // ⇒ no streaming work, no event allocations. Same guard as the observer
  // path (kill-on-throw + timer/listener teardown via `withSpawnedChild`).
  return withSpawnedChild(
    {
      kill,
      timer,
      cleanup: () => {
        disarm()
        options.signal?.removeEventListener("abort", onAbort)
      },
    },
    async () => {
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { stdout: stdoutText, stderr: stderrText, exitCode, timedOut: timedOutFlag }
    },
  )
}

/** Concatenate captured byte chunks into a single buffer for final decoding.
 *  Pulled out so the streamed-observer path reuses one allocation strategy. */
const concat = (chunks: Uint8Array[]): Uint8Array => {
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
