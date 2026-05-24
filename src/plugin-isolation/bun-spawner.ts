/**
 * `Bun.spawn`-backed adapter for {@link IsolatedProcessSpawnerPort} (ADR-0162).
 *
 * WHY THIS EXISTS — Electron's `UtilityProcess.fork` is the upstream pattern
 * (Claude DXT), but we live on Bun + CLI. Identical contract is achievable via
 * `Bun.spawn({stdio:"pipe"})` + line-framed JSON over stdout, with a custom
 * spawn-timeout watchdog and a SIGTERM→SIGKILL escalation timer.
 *
 * SHAPE — the adapter is internally split into three single-responsibility
 * helpers (`createKillController`, `createMessagePump`, `createSendBridge`) so
 * the public `spawn` method just glues them; this keeps cyclomatic complexity
 * inside the biome `noExcessiveCognitiveComplexity` budget without leaking
 * partial-state coupling between concerns.
 *
 * Contract bullets (sealed by hellgate):
 *  - entry path validated by spawn errno (not pre-stat'd — kernel is the source
 *    of truth and a pre-stat could race).
 *  - serviceName must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (ASCII, ≤64).
 *  - First stdout line within `spawnTimeoutMs` (default 5s) → resolve handle.
 *    Lack of first line, child exit, or AbortSignal → reject + kill.
 *  - Per-line payload ≤ {@link MAX_MESSAGE_BYTES}; oversize lines are dropped
 *    + warn-logged. NUL bytes split lines (line up to first NUL is taken,
 *    rest of that "line" is discarded — never decoded).
 *  - send() of >{@link MAX_MESSAGE_BYTES} payload is silently dropped + warned
 *    (NO-THROW — see types.ts contract).
 *  - kill() is idempotent; multiple invocations do not re-arm the SIGKILL
 *    escalation timer.
 *  - onMessage handlers run via microtask queue (`queueMicrotask`) so callers
 *    can safely `send` from within a handler without re-entrance hazard.
 */

import type { Subprocess } from "bun"
import { logger } from "@/shared"
import {
  DEFAULT_GRACEFUL_KILL_MS,
  DEFAULT_SPAWN_TIMEOUT_MS,
  type IsolatedProcess,
  type IsolatedProcessSpawnerPort,
  IsolatedSpawnError,
  MAX_MESSAGE_BYTES,
  type SpawnOpts,
} from "./types"

/** ASCII-only, length-bounded service name. Enforced because the value is
 *  exposed through env to the child (and via the child's argv/env to `ps`),
 *  and unicode/long-strings have caused unpleasant surprises in the wild. */
const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const NEWLINE_CHAR = 0x0a
const NUL_CHAR = 0x00
const MAX_EARLY_BUFFERED_MESSAGES = 64

const validateOpts = (opts: SpawnOpts): void => {
  if (!SERVICE_NAME_RE.test(opts.serviceName)) {
    throw new IsolatedSpawnError(
      "invalid-service-name",
      `serviceName must match ASCII [A-Za-z0-9][A-Za-z0-9._-]{0,63} (got: ${JSON.stringify(opts.serviceName).slice(0, 80)})`,
    )
  }
  if (typeof opts.entry !== "string" || opts.entry.length === 0) {
    throw new IsolatedSpawnError("invalid-entry", "entry must be a non-empty string")
  }
}

const buildEnv = (opts: SpawnOpts): Record<string, string> => {
  const base: Record<string, string> = {}
  const path = process.env["PATH"]
  if (path !== undefined) base["PATH"] = path
  base["QUANTA_SERVICE_NAME"] = opts.serviceName
  if (opts.allowLoadingUnsignedLibraries === true) base["QUANTA_ALLOW_UNSIGNED"] = "1"
  return opts.env === undefined ? base : { ...base, ...opts.env }
}

/** SIGTERM→SIGKILL escalation, parameterised by gracefulKillMs. Independent of
 *  `runtime/guarded-spawn.ts` `KILL_GRACE_MS` (different timing, different
 *  contract: plugin lifecycle vs shell tool). */
interface KillController {
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => Promise<void>
  readonly disarm: () => void
}

const createKillController = (
  proc: Subprocess<"pipe", "pipe", "pipe">,
  gracefulKillMs: number,
): KillController => {
  let escalationTimer: ReturnType<typeof setTimeout> | undefined
  let killCalled = false
  const disarm = (): void => {
    if (escalationTimer !== undefined) {
      clearTimeout(escalationTimer)
      escalationTimer = undefined
    }
  }
  // Clear escalation timer the moment the child is reaped — well-behaved
  // children exit on SIGTERM long before the grace window ends; the SIGKILL is
  // never sent and the timer never leaks.
  void proc.exited.then(disarm, disarm)

  const sendSignal = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      proc.kill(sig)
    } catch {
      // already exited — no-op
    }
  }

  const kill = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> => {
    if (signal === "SIGKILL") {
      disarm()
      sendSignal("SIGKILL")
      await proc.exited.catch(() => undefined)
      return
    }
    if (!killCalled) {
      killCalled = true
      sendSignal("SIGTERM")
      // Arm escalation; never stack.
      if (escalationTimer === undefined) {
        escalationTimer = setTimeout(() => {
          escalationTimer = undefined
          sendSignal("SIGKILL")
        }, gracefulKillMs)
        // Don't keep the event loop alive just for the grace timer.
        escalationTimer.unref?.()
      }
    }
    await proc.exited.catch(() => undefined)
  }
  return { kill, disarm }
}

/** Stdout pump: bytes → lines → dispatch.
 *
 *  Implementation note: line assembly is segment-based, not concat-based.
 *  A long pre-newline line is buffered once and materialized once at newline,
 *  avoiding per-chunk O(n^2) copies. Once a line crosses MAX_MESSAGE_BYTES or
 *  contains a NUL, we drop buffered segments immediately and stay in a
 *  discard-until-newline mode so memory stays bounded even if the child keeps
 *  streaming bytes without a newline. */
const createMessagePump = (
  proc: Subprocess<"pipe", "pipe", "pipe">,
  serviceName: string,
  onLine: (line: string) => void,
): { readonly done: Promise<void> } => {
  const decoder = new TextDecoder()
  const lineSegments: Uint8Array[] = []
  let lineBytes = 0
  let dropReason: "oversize" | "nul" | undefined

  const clearLineSegments = (): void => {
    lineSegments.length = 0
  }

  const materializeLine = (): Uint8Array => {
    if (lineSegments.length === 1) return lineSegments[0]!
    const out = new Uint8Array(lineBytes)
    let offset = 0
    for (const segment of lineSegments) {
      out.set(segment, offset)
      offset += segment.byteLength
    }
    return out
  }

  const resetLine = (): void => {
    clearLineSegments()
    lineBytes = 0
    dropReason = undefined
  }

  const finalizeLine = (): void => {
    if (lineBytes === 0) {
      resetLine()
      return
    }
    if (dropReason === "oversize") {
      logger.warn("plugin-isolation: dropping oversize stdout line", {
        serviceName,
        bytes: lineBytes,
        cap: MAX_MESSAGE_BYTES,
      })
      resetLine()
      return
    }
    if (dropReason === "nul") {
      logger.warn("plugin-isolation: dropping NUL-bearing stdout line", {
        serviceName,
        bytes: lineBytes,
      })
      resetLine()
      return
    }
    const text = decoder.decode(materializeLine())
    resetLine()
    onLine(text)
  }

  const consumeFragment = (fragment: Uint8Array): void => {
    if (fragment.byteLength === 0) return
    lineBytes += fragment.byteLength
    if (dropReason !== undefined) return
    if (lineBytes > MAX_MESSAGE_BYTES) {
      dropReason = "oversize"
      clearLineSegments()
      return
    }
    if (fragment.indexOf(NUL_CHAR) >= 0) {
      dropReason = "nul"
      clearLineSegments()
      return
    }
    lineSegments.push(fragment)
  }

  const consumeChunk = (chunk: Uint8Array): void => {
    let cursor = 0
    while (cursor < chunk.byteLength) {
      const nl = chunk.indexOf(NEWLINE_CHAR, cursor)
      if (nl < 0) {
        consumeFragment(chunk.subarray(cursor))
        return
      }
      consumeFragment(chunk.subarray(cursor, nl))
      finalizeLine()
      cursor = nl + 1
    }
  }

  const pump = async (): Promise<void> => {
    try {
      for await (const chunk of proc.stdout) {
        consumeChunk(chunk)
      }
    } catch (e) {
      logger.debug("plugin-isolation: stdout pump ended with error", {
        serviceName,
        error: String(e),
      })
    }
    // Last partial line (no trailing \n) is intentionally dropped — the line
    // protocol requires newline termination, and admitting an unterminated
    // tail would invite split-JSON corruption.
  }
  return { done: pump() }
}

/** Encode + write side: validates size, NO-THROW on closed stdin. */
const createSendBridge = (
  proc: Subprocess<"pipe", "pipe", "pipe">,
  serviceName: string,
): ((msg: unknown) => void) => {
  const encoder = new TextEncoder()
  return (msg: unknown): void => {
    let line: string
    try {
      line = JSON.stringify(msg)
    } catch (e) {
      logger.warn("plugin-isolation: send dropped (json-encode failed)", {
        serviceName,
        error: String(e),
      })
      return
    }
    const payload = encoder.encode(`${line}\n`)
    if (payload.byteLength > MAX_MESSAGE_BYTES) {
      logger.warn("plugin-isolation: send dropped (over cap)", {
        serviceName,
        bytes: payload.byteLength,
        cap: MAX_MESSAGE_BYTES,
      })
      return
    }
    const stdin = proc.stdin
    if (!stdin) return
    try {
      stdin.write(payload)
    } catch (e) {
      logger.debug("plugin-isolation: stdin write skipped (child closed)", {
        serviceName,
        error: String(e),
      })
    }
  }
}

/** Subscribe registry — handlers run via microtask to keep `send` re-entrant.
 *
 *  BUFFER-UNTIL-FIRST-SUBSCRIBER: messages dispatched before any listener has
 *  registered are queued up to MAX_EARLY_BUFFERED_MESSAGES. The instant the
 *  first listener arrives they are flushed (via microtask, preserving order).
 *  This closes the ready→first-subscribe race without allowing an unbounded
 *  pre-listener queue. When the cap is reached, oldest messages are dropped. */
interface ListenerRegistry {
  readonly add: (h: (msg: unknown) => void) => () => void
  readonly dispatch: (msg: unknown) => void
}

const createListenerRegistry = (): ListenerRegistry => {
  const listeners = new Set<(msg: unknown) => void>()
  const earlyBuffer: unknown[] = []
  let everHadListener = false
  let warnedEarlyBufferOverflow = false

  const fanOut = (msg: unknown): void => {
    const snapshot = Array.from(listeners)
    for (const h of snapshot) {
      queueMicrotask(() => {
        try {
          h(msg)
        } catch (e) {
          logger.warn("plugin-isolation: listener threw", { error: String(e) })
        }
      })
    }
  }

  return {
    add: (h) => {
      const wasEmpty = !everHadListener
      listeners.add(h)
      everHadListener = true
      if (wasEmpty && earlyBuffer.length > 0) {
        // Flush in arrival order — preserve causal semantics.
        const drained = earlyBuffer.splice(0, earlyBuffer.length)
        for (const m of drained) fanOut(m)
      }
      return () => {
        listeners.delete(h)
      }
    },
    dispatch: (msg) => {
      if (!everHadListener) {
        if (earlyBuffer.length === MAX_EARLY_BUFFERED_MESSAGES) {
          earlyBuffer.shift()
          if (!warnedEarlyBufferOverflow) {
            warnedEarlyBufferOverflow = true
            logger.warn("plugin-isolation: early listener buffer full; dropping oldest message", {
              cap: MAX_EARLY_BUFFERED_MESSAGES,
            })
          }
        }
        earlyBuffer.push(msg)
        return
      }
      fanOut(msg)
    },
  }
}

/** Build the handle once the first ready line has arrived (or the watchdog
 *  has fired). Separated to keep `spawn` flat. */
interface BuildHandleParams {
  readonly proc: Subprocess<"pipe", "pipe", "pipe">
  readonly serviceName: string
  readonly killer: KillController
  readonly registry: ListenerRegistry
}

const buildHandle = (params: BuildHandleParams): IsolatedProcess => {
  const { proc, serviceName, killer, registry } = params
  return {
    pid: proc.pid,
    serviceName,
    send: createSendBridge(proc, serviceName),
    onMessage: (h) => registry.add(h),
    kill: (sig) => killer.kill(sig),
    exitPromise: proc.exited.then(
      (code) => ({ code, signal: null }),
      () => ({ code: null, signal: null }),
    ),
  }
}

/** Set up the spawn-timeout watchdog. Returns a `cancel` + a promise that
 *  resolves to the first line (or rejects on timeout/abort/exit). */
interface SpawnWatchdog {
  readonly firstLinePromise: Promise<void>
  readonly notifyFirstLine: () => void
  readonly cancel: () => void
}

const createSpawnWatchdog = (
  proc: Subprocess<"pipe", "pipe", "pipe">,
  serviceName: string,
  spawnTimeoutMs: number,
  signal: AbortSignal | undefined,
): SpawnWatchdog => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let resolve!: () => void
  let reject!: (e: Error) => void
  const firstLinePromise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort)
      onAbort = undefined
    }
  }
  const notifyFirstLine = (): void => {
    cancel()
    resolve()
  }
  timer = setTimeout(() => {
    timer = undefined
    reject(
      new IsolatedSpawnError(
        "spawn-timeout",
        `plugin "${serviceName}" did not emit first message within ${spawnTimeoutMs}ms`,
      ),
    )
  }, spawnTimeoutMs)
  timer.unref?.()
  if (signal) {
    if (signal.aborted) {
      cancel()
      reject(new IsolatedSpawnError("spawn-aborted", `plugin "${serviceName}" spawn aborted`))
    } else {
      onAbort = (): void => {
        cancel()
        reject(new IsolatedSpawnError("spawn-aborted", `plugin "${serviceName}" spawn aborted`))
      }
      signal.addEventListener("abort", onAbort)
    }
  }
  void proc.exited.then(
    (code) => {
      cancel()
      reject(
        new IsolatedSpawnError(
          "spawn-failed",
          `plugin "${serviceName}" exited before first message (code=${code})`,
        ),
      )
    },
    (e) => {
      cancel()
      reject(
        new IsolatedSpawnError(
          "spawn-failed",
          `plugin "${serviceName}" exit observation failed: ${String(e)}`,
        ),
      )
    },
  )
  return { firstLinePromise, notifyFirstLine, cancel }
}

const tryParseJson = (line: string): unknown | undefined => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

/** Concrete spawner backed by `Bun.spawn`. Stateless — multiple `spawn` calls
 *  produce independent {@link IsolatedProcess} handles. */
export const createBunSpawner = (): IsolatedProcessSpawnerPort => ({
  spawn: async (opts: SpawnOpts): Promise<IsolatedProcess> => {
    validateOpts(opts)
    const serviceName = opts.serviceName
    const spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
    const gracefulKillMs = opts.gracefulKillMs ?? DEFAULT_GRACEFUL_KILL_MS

    const argv = [opts.entry, ...(opts.args ?? [])]
    let proc: Subprocess<"pipe", "pipe", "pipe">
    try {
      proc = Bun.spawn(argv, {
        cwd: opts.cwd ?? process.cwd(),
        env: buildEnv(opts),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (e) {
      throw new IsolatedSpawnError(
        "spawn-failed",
        `plugin "${serviceName}" spawn failed: ${String(e)}`,
      )
    }

    const killer = createKillController(proc, gracefulKillMs)
    const registry = createListenerRegistry()
    let sawFirstLine = false

    const watchdog = createSpawnWatchdog(proc, serviceName, spawnTimeoutMs, opts.signal)

    createMessagePump(proc, serviceName, (line) => {
      if (!sawFirstLine) {
        sawFirstLine = true
        watchdog.notifyFirstLine()
        // The first line is a READY sentinel (DXT semantics). It is NOT
        // forwarded to onMessage listeners, because those subscriptions only
        // become possible AFTER `spawn` resolves — dispatching the first line
        // would race the user's first `onMessage()` call. Plugins that need
        // to carry payload data should emit a second line after the ready
        // sentinel.
        return
      }
      const parsed = tryParseJson(line)
      if (parsed === undefined) {
        // Non-JSON lines after ready are dropped silently — wire protocol is
        // JSON-only, and tolerating noise here would invite split-payload
        // corruption downstream.
        return
      }
      registry.dispatch(parsed)
    })

    try {
      await watchdog.firstLinePromise
    } catch (e) {
      // Kill child (idempotent) then rethrow original.
      void killer.kill("SIGTERM")
      throw e
    }

    return buildHandle({ proc, serviceName, killer, registry })
  },
})
