/**
 * Per-LLM-stream PROGRESS HEARTBEAT trace (jun-26).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * When an LLM turn STALLS mid-stream — e.g. a content-LESS stream waiting on data
 * (the cassette case the empty-stream breaker addresses) or a very slow turn —
 * NOTHING is logged. The bench `run.log` only gets a line when a TOOL ACTION
 * completes (the single-pass path emits a per-action line), so a turn stuck
 * INSIDE the LLM stream is invisible: "troubleshooting blind." A stall therefore
 * looks identical to healthy work — the box just sits there.
 *
 * ── The trace ────────────────────────────────────────────────────────────────
 * A pure `LLMPort` decorator (mirrors `withEmptyStreamCircuitBreaker`) that wraps
 * `stream()` and, while consuming the inner stream, runs a periodic HEARTBEAT
 * timer. The timer fires every `intervalMs` and logs one line carrying the
 * route, elapsed time, total/content event counts, and the IDLE time since the
 * last event — and it KEEPS firing while the async generator is awaiting the next
 * event, so a stall shows up as `idle=` climbing with `content=0`. On completion
 * (clean OR error) the timer is cleared and ONE summary line is emitted.
 *
 * ── Telemetry only — safe default-ON ─────────────────────────────────────────
 * This changes NO agent behaviour: events pass through BYTE-IDENTICALLY (same
 * objects, same order, never added / dropped / reordered / delayed). It is a pure
 * logging side-effect, so the default-OFF byte-identical invariant does not gate
 * it — it is default-ON for bench because the whole point is visibility and it is
 * low-noise: a stream that finishes before the first interval produces ZERO
 * heartbeats (only the cheap summary), so healthy fast turns stay silent.
 *
 * ── Gating ───────────────────────────────────────────────────────────────────
 * Default interval {@link DEFAULT_STREAM_TRACE_INTERVAL_MS} (~10s). Env override
 * `QUANTA_LLM_STREAM_TRACE_MS` (resolved at the composition root, passed here as
 * `intervalMs`): `0` ⇒ disabled (no timer, no summary); absent ⇒ default ON at
 * the default interval.
 */

import { logger } from "@/shared"
import { isStreamEventContentful } from "./empty-stream-breaker"
import type { LLMPort } from "./ports"
import type { StreamEvent, StreamInput } from "./types"

/** Default heartbeat interval — ~10s. Long enough that healthy fast turns finish
 *  before the first tick (no heartbeat), short enough that a multi-minute stall
 *  surfaces within seconds of the first interval. */
export const DEFAULT_STREAM_TRACE_INTERVAL_MS = 10_000

/** Injectable timer scheduler so tests are deterministic (no real setInterval).
 *  Mirrors how `withEmptyStreamCircuitBreaker` injects `now`/`sleep`. The
 *  production default uses `setInterval`/`clearInterval` with `.unref()` so a
 *  heartbeat never keeps the process alive on its own. */
export interface TraceTimer {
  /** Schedule `cb` to fire every `ms`. Returns an opaque handle for `clearTimer`. */
  readonly setTimer: (cb: () => void, ms: number) => unknown
  /** Cancel a handle returned by `setTimer`. */
  readonly clearTimer: (handle: unknown) => void
}

const realTimer: TraceTimer = {
  setTimer: (cb, ms) => {
    const h = setInterval(cb, ms)
    // Do not let the heartbeat alone keep the event loop alive.
    if (typeof (h as { unref?: () => void }).unref === "function") {
      ;(h as { unref: () => void }).unref()
    }
    return h
  },
  clearTimer: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

export interface StreamProgressTraceOpts {
  /** Heartbeat interval in ms. `0` ⇒ DISABLED (pure passthrough, no timer, no
   *  summary). Absent ⇒ {@link DEFAULT_STREAM_TRACE_INTERVAL_MS}. Resolve the env
   *  override (`QUANTA_LLM_STREAM_TRACE_MS`) at the composition root and pass it
   *  here (the `@/llm` slice does not read `process.env`). */
  readonly intervalMs?: number
  /** Injectable clock (ms). Defaults to `Date.now`. Test seam. */
  readonly now?: () => number
  /** Injectable timer scheduler. Defaults to real `setInterval`/`clearInterval`.
   *  Test seam — drive heartbeats manually for determinism. */
  readonly timer?: TraceTimer
  /** Injectable log sink. Defaults to the repo `logger.info` so heartbeats land
   *  in the bench `run.log` alongside the per-action lines. Test seam. */
  readonly log?: (msg: string, meta?: unknown) => void
}

/** Short, stable route label for a stream — the model id when present, else a
 *  dash. Kept tiny so a heartbeat line stays one short line in `run.log`. */
const routeLabel = (port: LLMPort): string => port.model ?? port.contextWindowKey ?? "-"

/** Format whole seconds from a ms duration (floor), for the compact line. */
const secs = (ms: number): number => Math.max(0, Math.floor(ms / 1000))

interface StreamCounters {
  startedAt: number
  totalEvents: number
  contentEvents: number
  telemetryEvents: number
  lastEventAt: number
}

/**
 * Wrap an inner `LLMPort` so each `stream()` consumption emits a periodic
 * progress heartbeat (and a final summary). Returns a new `LLMPort`; the inner
 * port is never mutated. The event stream is passed through byte-identically.
 */
export const withStreamProgressTrace = (
  inner: LLMPort,
  opts: StreamProgressTraceOpts = {},
): LLMPort => {
  const intervalMs = opts.intervalMs ?? DEFAULT_STREAM_TRACE_INTERVAL_MS
  const now = opts.now ?? Date.now
  const timer = opts.timer ?? realTimer
  const log = opts.log ?? ((msg, meta) => logger.info(msg, meta))
  const route = routeLabel(inner)

  // Disabled ⇒ pure passthrough (no timer, no summary, zero overhead).
  if (intervalMs <= 0) return inner

  const emitHeartbeat = (c: StreamCounters): void => {
    const t = now()
    const elapsed = secs(t - c.startedAt)
    const idle = secs(t - c.lastEventAt)
    log(
      `[stream-trace] route=${route} elapsed=${elapsed}s events=${c.totalEvents} ` +
        `content=${c.contentEvents} idle=${idle}s`,
      {
        route,
        elapsedMs: t - c.startedAt,
        idleMs: t - c.lastEventAt,
        events: c.totalEvents,
        content: c.contentEvents,
        telemetry: c.telemetryEvents,
      },
    )
  }

  const emitSummary = (c: StreamCounters, outcome: string): void => {
    const elapsed = secs(now() - c.startedAt)
    log(
      `[stream-trace] done route=${route} elapsed=${elapsed}s events=${c.totalEvents} ` +
        `content=${c.contentEvents} ${outcome}`,
      {
        route,
        elapsedMs: now() - c.startedAt,
        events: c.totalEvents,
        content: c.contentEvents,
        telemetry: c.telemetryEvents,
        outcome,
      },
    )
  }

  const port: LLMPort = {
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.contextWindowKey !== undefined ? { contextWindowKey: inner.contextWindowKey } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.surfaceId !== undefined ? { surfaceId: inner.surfaceId } : {}),
    ...(inner.transportId !== undefined ? { transportId: inner.transportId } : {}),
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      async function* iterate(): AsyncIterable<StreamEvent> {
        const start = now()
        const counters: StreamCounters = {
          startedAt: start,
          totalEvents: 0,
          contentEvents: 0,
          telemetryEvents: 0,
          lastEventAt: start,
        }
        // Heartbeat keeps firing while the generator awaits the NEXT event — so a
        // stall shows idle climbing with content frozen. Scheduled BEFORE the
        // first `for await` so a stream that hangs before its first event is also
        // surfaced.
        const handle = timer.setTimer(() => emitHeartbeat(counters), intervalMs)
        let outcome = "ok"
        try {
          for await (const ev of inner.stream(input)) {
            counters.totalEvents += 1
            counters.lastEventAt = now()
            if (isStreamEventContentful(ev)) counters.contentEvents += 1
            else counters.telemetryEvents += 1
            // Byte-identical passthrough: the SAME object, in order, undelayed.
            yield ev
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          outcome = `error:${msg}`
          throw err
        } finally {
          timer.clearTimer(handle)
          emitSummary(counters, outcome)
        }
      }
      return iterate()
    },
  }
  return port
}
