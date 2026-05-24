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

import type { LlmProvider } from "@/llm/providers"
import type { StreamEvent, StreamInput } from "@/llm"
import type { BackgroundSubagentScheduler, SubagentSpec } from "@/agent/subagent-background"
import type { MetricsRegistry } from "./port"

const safe = (metrics: MetricsRegistry, fn: () => void): void => {
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
export const instrumentLlmProvider = (
  provider: LlmProvider,
  metrics: MetricsRegistry,
  opts?: LlmInstrumentOpts,
): LlmProvider => {
  const prefix = opts?.namePrefix ?? "llm.provider"
  const now = opts?.now ?? (() => performance.now())
  const provLabel = provider.providerId

  return {
    ...provider,
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      safe(metrics, () =>
        metrics.increment(`${prefix}.stream.total`, 1, { provider: provLabel }),
      )
      const t0 = now()
      let firstEventAt: number | null = null
      try {
        for await (const ev of provider.stream(input)) {
          if (firstEventAt === null) {
            firstEventAt = now()
            safe(metrics, () =>
              metrics.observe(`${prefix}.stream.ttft_ms`, firstEventAt! - t0, { provider: provLabel }),
            )
          }
          yield ev
        }
      } catch (e) {
        const code = e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : "unknown"
        safe(metrics, () =>
          metrics.increment(`${prefix}.stream.failures.total`, 1, { provider: provLabel, code }),
        )
        throw e
      } finally {
        safe(metrics, () =>
          metrics.observe(`${prefix}.stream.duration_ms`, now() - t0, { provider: provLabel }),
        )
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
      if (result !== null && result.endedAt !== undefined) {
        safe(metrics, () =>
          metrics.observe(`${prefix}.duration_ms`, result.endedAt! - result.startedAt, {
            status: result.status,
          }),
        )
      }
      return result
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
