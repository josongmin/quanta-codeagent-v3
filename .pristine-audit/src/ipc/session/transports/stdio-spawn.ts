/**
 * `@/ipc/session/transports/stdio-spawn` — a spawn-OWNING stdio session
 * transport (S4, jul-16 transport-unified SDK ticket 01).
 *
 * The Codex-sidecar shape: the transport spawns the child itself, frames
 * session.v1 over the child's stdin/stdout (reusing the plain stdio transport
 * for all framing), and — the part no composition of existing pieces gave —
 * OWNS the child lifecycle:
 *
 *  - `close()` → stdin EOF + SIGTERM, then SIGKILL after a bounded grace
 *    window; resolves only when the child is reaped (no zombies, no orphaned
 *    grace timers);
 *  - child exit (any path: clean, crash, signal) → `onClose` with a reason
 *    carrying `code=… signal=…` and a BOUNDED stderr tail — the raw material
 *    a caller needs to fail fast when e.g. a gate-OFF server exits
 *    immediately;
 *  - stderr is ALWAYS drained (a full pipe wedges the child) but only the
 *    last `stderrTailChars` are retained (no unbounded buffer).
 *
 * ENV IS NEVER AUTO-INJECTED: when `env` is provided it is passed VERBATIM as
 * the child's ENTIRE environment (no merge, no additions); when omitted, Bun's
 * default applies (the parent environment, untouched). In particular this
 * transport never seeds ticket-02's `serve --stdio` maturity gate — enabling
 * that gate must remain the caller's explicit, visible act (bypass-theater
 * prevention, MASTER §6).
 *
 * Reader-EOF semantics for the GENERIC stdio transport remain ticket-02 scope
 * (see `./stdio`); here child-death is observed via `exited`, which subsumes
 * the EOF case for spawn-owned children.
 */

import type { SessionTransport, SessionTransportCloseInfo } from "../types"
import { createSessionTransportCloseSignal } from "./close-signal"
import { createSessionStdioTransport, type StdioReader } from "./stdio"

export interface CreateSessionStdioSpawnTransportOpts {
  /** argv — `command[0]` is the executable. Resolution failures (ENOENT …)
   *  throw synchronously from the factory: fail-fast at the call site. */
  readonly command: readonly string[]
  /** ENTIRE child environment, passed verbatim when provided — no merge with
   *  the parent env, no auto-injection of anything. Omitted → Bun.spawn's
   *  default (the parent environment, untouched by this transport). */
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  /** Grace window between SIGTERM and the SIGKILL escalation on `close()`.
   *  Default 2000ms. */
  readonly sigkillGraceMs?: number
  /** Retained stderr tail cap in UTF-16 code units (a conservative proxy for
   *  bytes, same convention as the framing's `MAX_FRAME_CHARS`). Default 8KiB
   *  worth of characters. */
  readonly stderrTailChars?: number
}

export interface SessionStdioSpawnTransport extends SessionTransport {
  /** The spawned child's pid — for diagnostics and liveness probes. */
  readonly pid: number
  /** Narrowed from optional to REQUIRED — a spawn-owning transport always has
   *  a death to report. */
  onClose(handler: (info: SessionTransportCloseInfo) => void): () => void
}

const DEFAULT_SIGKILL_GRACE_MS = 2000
const DEFAULT_STDERR_TAIL_CHARS = 8 * 1024

/** Bounded wait applied to the stderr drain after the child exited, before the
 *  close reason is composed. Normally the drain EOFs immediately (the child is
 *  gone, remaining bytes sit in the pipe buffer); the bound only bites when a
 *  GRANDCHILD inherited the stderr fd and holds the pipe open — the liveness
 *  channel must not hang on a stranger's fd. */
const STDERR_SETTLE_MS = 250

/* --- hoisted stream/timer helpers (god-FN ratchet, jul-16 audit HIGH-3) ---- */

/** Pump the child's stdout into `onChunk` (decoded text) until EOF/tear.
 *  A torn stream (child death / reader cancel) is swallowed — the exit path
 *  owns the terminal notification. */
const pumpChildStdout = (
  stdout: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): { cancel: () => void } => {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) onChunk(decoder.decode(value, { stream: true }))
      }
    } catch {
      // Torn stream (child death / reader cancel) — the exit path notifies.
    }
  })()
  return { cancel: () => void reader.cancel().catch(() => undefined) }
}

/** Drain the child's stderr COMPLETELY (a full pipe wedges the child) while
 *  retaining only the last `tailCap` characters. `done` resolves at EOF/tear;
 *  the tail keeps whatever it has on a torn stream. */
const drainStderrTail = (
  stderr: ReadableStream<Uint8Array>,
  tailCap: number,
): { readonly done: Promise<void>; tail: () => string; cancel: () => void } => {
  const reader = stderr.getReader()
  const decoder = new TextDecoder()
  let tail = ""
  const done = (async () => {
    try {
      while (true) {
        const { done: eof, value } = await reader.read()
        if (eof) break
        if (value !== undefined) {
          tail = (tail + decoder.decode(value, { stream: true })).slice(-tailCap)
        }
      }
    } catch {
      // Torn stream — the exit path notifies; the tail keeps what it has.
    }
  })()
  return { done, tail: () => tail, cancel: () => void reader.cancel().catch(() => undefined) }
}

/** The SIGTERM→SIGKILL escalation timer: armed at most once, unref'd (never
 *  keeps the process alive), and cleared when the child exits on its own. */
const createSigkillEscalation = (kill: () => void, graceMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    arm(): void {
      if (timer !== undefined) return
      timer = setTimeout(kill, graceMs)
      timer.unref()
    },
    clear(): void {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}

export const createSessionStdioSpawnTransport = (
  opts: CreateSessionStdioSpawnTransportOpts,
): SessionStdioSpawnTransport => {
  const graceMs = opts.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS
  const tailCap = opts.stderrTailChars ?? DEFAULT_STDERR_TAIL_CHARS

  // Throws synchronously on an unresolvable command — deliberate fail-fast.
  const child = Bun.spawn({
    cmd: [...opts.command],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  })

  const closeSignal = createSessionTransportCloseSignal()
  let closeRequested = false

  // --- stdout → data-only reader port (framing stays in ./stdio) ------------
  let stdoutDataHandler: ((chunk: Buffer | string) => void) | undefined
  const stdoutPort: StdioReader = {
    on(event, handler) {
      if (event === "data") stdoutDataHandler = handler
    },
    off(event, handler) {
      if (event === "data" && stdoutDataHandler === handler) stdoutDataHandler = undefined
    },
  }
  const stdoutPump = pumpChildStdout(child.stdout, (text) => stdoutDataHandler?.(text))

  // --- stderr drain: always consumed, bounded tail retained -----------------
  const stderr = drainStderrTail(child.stderr, tailCap)

  // --- stdin → writer port (flush per frame: FileSink buffers) --------------
  const stdinPort = {
    write(chunk: string) {
      child.stdin.write(chunk)
      void child.stdin.flush()
      return true
    },
  }

  const inner = createSessionStdioTransport({ reader: stdoutPort, writer: stdinPort })

  const childGone = (): boolean => child.exitCode !== null || child.signalCode !== null

  const sigkill = createSigkillEscalation(() => {
    try {
      child.kill("SIGKILL")
    } catch {
      // Child already gone.
    }
  }, graceMs)

  const summarizeExit = (): string => {
    if (closeRequested) return "local_close"
    const base = `child_exit code=${child.exitCode} signal=${child.signalCode}`
    const tail = stderr.tail().trim()
    return tail.length > 0 ? `${base} stderr_tail: ${tail}` : base
  }

  // Exit observer — the ONE place the terminal notification for a dead child
  // is composed. Bounded stderr settle first so a crash's last words make it
  // into the reason; then latch, then tear the framing down.
  const onExited = async (): Promise<void> => {
    sigkill.clear()
    await Promise.race([
      stderr.done,
      new Promise<void>((resolve) => setTimeout(resolve, STDERR_SETTLE_MS).unref()),
    ])
    closeSignal.notify({ reason: summarizeExit() })
    stdoutPump.cancel()
    stderr.cancel()
    try {
      // Self-exit paths never went through terminate(): release our write end
      // of the dead child's stdin pipe (fd hygiene — don't wait for GC).
      child.stdin.end()
    } catch {
      // Already ended/closed.
    }
    await inner.close()
  }
  const exitWatch = child.exited.then(onExited).catch(() => {
    closeSignal.notify({ reason: "child_exit (exit observer failed)" })
  })

  // SIGTERM → bounded grace → SIGKILL; resolves when the child is reaped.
  // Safe against already-dead children (kill on a reaped Bun subprocess is a
  // no-op) and never leaves a live grace timer behind (cleared on exit).
  const terminate = async (): Promise<void> => {
    if (!childGone()) {
      try {
        child.stdin.end()
      } catch {
        // stdin already closed — irrelevant to termination.
      }
      try {
        child.kill("SIGTERM")
      } catch {
        // Child raced to exit — reap below.
      }
      sigkill.arm()
    }
    await child.exited
  }

  // Inner-transport self-death (a throwing stdin writer / frame-cap wedge
  // guard) while the child still runs: escalate to a full lifecycle teardown
  // with the INNER reason. Owner-driven inner closes (close()/exit path) are
  // filtered out — they carry their own reasons.
  inner.onClose?.((info) => {
    if (closeRequested || closeSignal.closed || childGone()) return
    closeSignal.notify(info)
    void terminate()
  })

  return {
    pid: child.pid,
    send: (message) => inner.send(message),
    onMessage: (handler) => inner.onMessage(handler),
    onClose: (handler) => closeSignal.subscribe(handler),
    async close() {
      closeRequested = true
      await inner.close()
      await terminate()
      await exitWatch
    },
  }
}
