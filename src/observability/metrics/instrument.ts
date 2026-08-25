/**
 * Instrument wrap helpers (ADR-0159) — wraps already-shipped slice ports with
 * MetricsRegistry-backed counter/histogram emission, so callers add observability
 * with a single function call instead of hand-rolling try/catch around every
 * method.
 *
 * Hexagonal: each helper takes an existing port (LlmProvider / scheduler /
 * MetricsRegistry) + returns the SAME port shape with metrics-emitting wrapper.
 * The slice itself never imports `@/observability` (plane-clean preserved).
 *
 * Each helper:
 *   - Is a PURE wrapper (no I/O, no side effect beyond metrics.increment / .observe).
 *   - No-throws: any metrics.increment failure is swallowed (MetricsSink's
 *     no-throw contract; defensive belt+suspenders here too).
 *   - Forwards every method/property of the wrapped port verbatim.
 *   - Honors the 24-metric recipe table in ADR-0158.
 */

import type { BackgroundSubagentScheduler, SubagentSpec } from "@/agent/subagent-background"
// biome-ignore lint/style/noRestrictedImports: type-only import (erased at compile time) — no runtime slice coupling; the AST slice-boundary scanner exempts type imports.
import type { StreamEvent, StreamInput } from "@/llm"
import type { LlmProvider } from "@/llm/providers"
import type { MetricsRegistry } from "./port"

const safe = (_metrics: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* metrics emission must never break the wrapped call */
  }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* LlmProvider wrap                                                            */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface LlmInstrumentOpts {
  /** Override the metric name prefix (default "llm.provider"). */
  readonly namePrefix?: string
  /** Injected clock for TTFT measurement (default performance.now). */
  readonly now?: () => number
}

/**
 * Wrap a LlmProvider with stream-count / TTFT / failure-count instrumentation.
 *
 *   <prefix>.stream.total            counter   labels: provider, model
 *   <prefix>.stream.ttft_ms          histogram labels: provider
 *   <prefix>.stream.failures.total   counter   labels: provider, code
 *   <prefix>.stream.duration_ms      histogram labels: provider, stop_reason
 */
/** The wrapped stream's stable label set. Computed once per WRAP (not per
 *  call) — `model` is normalized here so every emission agrees on it. */
type LlmStreamLabels = { readonly provider: string; readonly model: string }

/** `stop_reason` off a `message_stop` event, normalized to a non-empty string. */
const stopReasonOf = (ev: { stop_reason?: unknown }): string =>
  typeof ev.stop_reason === "string" && ev.stop_reason.length > 0 ? ev.stop_reason : "unknown"

/** Error `code` when the thrown value carries a string one, else `"unknown"`. */
const errorCodeOf = (e: unknown): string =>
  e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : "unknown"

/**
 * The four metric emissions of one wrapped stream, bound to that call's labels
 * and clock.
 *
 * Grouped into a record because inline they were four `safe(metrics, () => …)`
 * arrows nested INSIDE the async generator — each arrow body sitting two
 * function levels deep, which is where most of this function's score came from.
 * Out here each one is a flat, separately readable emission and the generator
 * body reads as the algorithm: start, first event, stop reason, failure, done.
 */
type LlmStreamMetrics = {
  readonly firstEvent: (at: number) => void
  readonly failed: (e: unknown) => void
  readonly finished: (stopReason: string) => void
}

const llmStreamMetrics = (
  metrics: MetricsRegistry,
  prefix: string,
  labels: LlmStreamLabels,
  now: () => number,
  t0: number,
): LlmStreamMetrics => ({
  firstEvent: (at) =>
    safe(metrics, () =>
      metrics.observe(`${prefix}.stream.ttft_ms`, at - t0, { provider: labels.provider }),
    ),
  failed: (e) =>
    safe(metrics, () =>
      metrics.increment(`${prefix}.stream.failures.total`, 1, {
        provider: labels.provider,
        code: errorCodeOf(e),
      }),
    ),
  finished: (stopReason) =>
    safe(metrics, () =>
      metrics.observe(`${prefix}.stream.duration_ms`, now() - t0, {
        provider: labels.provider,
        stop_reason: stopReason,
      }),
    ),
})

export const instrumentLlmProvider = (
  provider: LlmProvider,
  metrics: MetricsRegistry,
  opts?: LlmInstrumentOpts,
): LlmProvider => {
  const prefix = opts?.namePrefix ?? "llm.provider"
  const now = opts?.now ?? (() => performance.now())
  const labels: LlmStreamLabels = {
    provider: provider.providerId,
    model:
      typeof provider.model === "string" && provider.model.trim().length > 0
        ? provider.model
        : "unknown",
  }

  return {
    ...provider,
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      // Emitted BEFORE `t0` is read, so the clock is consulted in the same order
      // as before this was factored out.
      safe(metrics, () =>
        metrics.increment(`${prefix}.stream.total`, 1, {
          provider: labels.provider,
          model: labels.model,
        }),
      )
      const t0 = now()
      const emit = llmStreamMetrics(metrics, prefix, labels, now, t0)
      let firstEventAt: number | null = null
      let stopReason = "unknown"
      try {
        for await (const ev of provider.stream(input)) {
          if (firstEventAt === null) {
            // Captured into a const before the closure: a `let` read from inside
            // an arrow is `number | null` again no matter what the enclosing
            // branch proved, which is the only reason this was asserted.
            const at = now()
            firstEventAt = at
            emit.firstEvent(at)
          }
          if (ev.type === "message_stop") stopReason = stopReasonOf(ev)
          yield ev
        }
      } catch (e) {
        stopReason = "error"
        emit.failed(e)
        throw e
      } finally {
        emit.finished(stopReason)
      }
    },
  }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* BackgroundSubagentScheduler wrap                                            */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface SchedulerInstrumentOpts {
  /** Default metric name prefix is "subagent". */
  readonly namePrefix?: string
}

/**
 * Wrap a scheduler with fork/cancel counters + duration histogram on await.
 *
 *   <prefix>.fork.total       counter   (no labels)
 *   <prefix>.cancel.total     counter   labels: existed
 *   <prefix>.duration_ms      histogram labels: status
 */
export const instrumentSubagentScheduler = (
  scheduler: BackgroundSubagentScheduler,
  metrics: MetricsRegistry,
  opts?: SchedulerInstrumentOpts,
): BackgroundSubagentScheduler => {
  const prefix = opts?.namePrefix ?? "subagent"

  return {
    fork(spec: SubagentSpec): string {
      safe(metrics, () => metrics.increment(`${prefix}.fork.total`))
      return scheduler.fork(spec)
    },
    poll: scheduler.poll.bind(scheduler),
    cancel(id) {
      const existed = scheduler.cancel(id)
      safe(metrics, () =>
        metrics.increment(`${prefix}.cancel.total`, 1, { existed: String(existed) }),
      )
      return existed
    },
    async await(id, optsArg) {
      const result = await scheduler.await(id, optsArg)
      const endedAt = result?.endedAt
      if (result !== null && endedAt !== undefined) {
        safe(metrics, () =>
          metrics.observe(`${prefix}.duration_ms`, endedAt - result.startedAt, {
            status: result.status,
          }),
        )
      }
      return result
    },
    forceBackground(id, forceOpts) {
      // ADR-0487 — instrument the promote outcome (closed union as a label).
      const outcome = scheduler.forceBackground(id, forceOpts)
      safe(metrics, () => metrics.increment(`${prefix}.force_background.total`, 1, { outcome }))
      return outcome
    },
    list: scheduler.list.bind(scheduler),
    prune: scheduler.prune.bind(scheduler),
    serialize: scheduler.serialize.bind(scheduler),
    hydrate: scheduler.hydrate.bind(scheduler),
    hydrateWithPrune: scheduler.hydrateWithPrune.bind(scheduler),
  }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Generic counter wrap — any (string-keyed) port whose method-call you want
 * counted. Use sparingly; prefer the typed wrappers above. */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface CountingProxyOpts<T extends object> {
  readonly metrics: MetricsRegistry
  readonly metricName: string
  /** Methods to count. Other keys pass through. */
  readonly methods: ReadonlyArray<keyof T>
  /** Optional label-builder per call. */
  readonly labels?: (method: keyof T, args: unknown[]) => Record<string, string>
}

/**
 * Generic counter proxy — wraps any object so the listed methods increment
 * `metricName` on every call. Pass-through for non-listed methods.
 *
 * Use when the typed wrappers above don't fit (e.g. wrapping `ShadowOdb`,
 * `MetricsRegistry` itself for meta-instrumentation, etc.).
 */
export const withCallCounter = <T extends object>(target: T, opts: CountingProxyOpts<T>): T => {
  const { metrics, metricName, methods, labels } = opts
  const methodSet = new Set(methods as readonly (string | symbol)[])
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const orig = Reflect.get(obj, prop, receiver) as unknown
      if (typeof orig === "function" && methodSet.has(prop)) {
        return (...args: unknown[]) => {
          safe(metrics, () => {
            const lbl = labels ? labels(prop as keyof T, args) : {}
            metrics.increment(metricName, 1, { method: String(prop), ...lbl })
          })
          return (orig as (...a: unknown[]) => unknown).apply(obj, args)
        }
      }
      return orig
    },
  })
}
