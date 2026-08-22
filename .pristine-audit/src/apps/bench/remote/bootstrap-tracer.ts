/**
 * Bootstrap-phase OTEL visibility (jun-27 #4). A full-remote box spends ~20min in
 * {@link ./box-session/ec2-lifecycle provisionBox} (launch → cloud-init → rsync →
 * bun install → phantom deps → swebench/uvx warm → pyright) BEFORE its agent loop
 * emits any OTEL span. To the operator's trace UI that window is dead air, so a
 * slow bootstrap and a DEAD one look identical. This tracer emits one OTLP span
 * per phase to the SAME sink the agent loop feeds (the reverse-tunneled
 * `QUANTA_OTEL_ENDPOINT`), so the bootstrap waterfall shows up live — and a FAILED
 * phase emits an ERROR span carrying the message, so a dead bootstrap surfaces
 * WHERE it died instead of silence.
 *
 * Reuses {@link otelHttpExporter} for transport (same /v1/traces POST + injectable
 * fetch/now the agent loop uses). DEFAULT-OFF: a non-http endpoint ⇒ a no-op tracer
 * that still runs every phase fn (byte-identical). The export path NEVER fails a
 * phase — a dead sink is swallowed by the exporter's warn, and `phase` returns the
 * fn's value (or rethrows the fn's OWN error) regardless of emission.
 */

import { type ExportSpan, otelHttpExporter } from "@/observability/otel-exporter"
import { errMessage } from "@/shared"

export interface BootstrapTracer {
  /** Time `fn` as a bootstrap phase. Emits an `ok` span on success, an `error`
   *  span (+ message) on throw — then RETHROWS the fn's error (visibility only;
   *  the bootstrap's success/failure is unchanged). Returns the fn's value. */
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>
  /** Final flush + stop the exporter. Call in a `finally` after bootstrap. */
  close(): Promise<void>
}

export interface BootstrapTracerOpts {
  /** OTLP sink base URL (`QUANTA_OTEL_ENDPOINT`), resolved at the allowlisted
   *  composition root. Non-http ⇒ the tracer is a no-op (Default-OFF). */
  readonly endpoint: string
  /** Instance id — attached as `bootstrap.iid` and seeds the trace id so each
   *  box's bootstrap is its own waterfall. */
  readonly iid?: string
  /** Test seam — fake fetch. */
  readonly fetch?: typeof fetch
  /** Test seam — clock (epoch ms). Default `Date.now`. */
  readonly now?: () => number
  /** Test seam — pin the trace id (otherwise derived from iid + start time). */
  readonly traceId?: string
  /** Optional warn sink for export errors. */
  readonly warn?: (msg: string) => void
}

/** Deterministic fixed-width lowercase hex id from a seed (FNV-1a expansion). NOT
 *  cryptographic — just a stable, RNG-free id so a trace groups its phases and
 *  tests can pin it via the seed. `bytes*2` hex chars (16→trace, 8→span). */
const hexId = (seed: string, bytes: number): string => {
  let h = 0x811c9dc5 >>> 0
  let out = ""
  let s = seed
  while (out.length < bytes * 2) {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out += h.toString(16).padStart(8, "0")
    s = out // re-feed to extend deterministically
  }
  return out.slice(0, bytes * 2)
}

const NOOP: BootstrapTracer = {
  phase: (_name, fn) => fn(),
  close: async () => {},
}

export const createBootstrapTracer = (opts: BootstrapTracerOpts): BootstrapTracer => {
  // Default-OFF: only a real http(s) sink arms the tracer; anything else (unset /
  // "" / garbage) ⇒ no-op so a phase is byte-identical to an untraced bootstrap.
  if (!/^https?:\/\//.test(opts.endpoint)) return NOOP

  const now = opts.now ?? (() => Date.now())
  const iid = opts.iid ?? "box"
  const traceId = opts.traceId ?? hexId(`${iid}:${now()}`, 16)
  const exporter = otelHttpExporter({
    endpoint: opts.endpoint,
    serviceName: "quanta-bench-bootstrap",
    flushIntervalMs: 0, // no timer — we flush per phase so the UI updates live
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
  })
  let seq = 0

  const emit = async (
    name: string,
    startTimeEpochMs: number,
    status: "ok" | "error",
    statusMessage?: string,
  ): Promise<void> => {
    const span: ExportSpan = {
      traceId,
      spanId: hexId(`${traceId}:${seq}`, 8),
      name: `bootstrap.${name}`,
      kind: "internal",
      status,
      ...(statusMessage !== undefined ? { statusMessage } : {}),
      startTimeEpochMs,
      endTimeEpochMs: now(),
      attributes: { "bootstrap.iid": iid, "bootstrap.phase": name },
    }
    seq += 1
    exporter.recordSpan(span)
    // flush() resolves once the POST settles (or fails — the exporter swallows a
    // dead sink via its warn). Never lets an emission error escape into bootstrap.
    await exporter.flush().catch(() => {})
  }

  return {
    phase: async (name, fn) => {
      const start = now()
      try {
        const result = await fn()
        await emit(name, start, "ok")
        return result
      } catch (err) {
        await emit(name, start, "error", errMessage(err))
        throw err
      }
    },
    close: () => exporter.teardown().catch(() => {}),
  }
}
