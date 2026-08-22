/**
 * GenAI client metrics (ADR-0539 / T-C2) — the two OTel-GenAI Recommended
 * Histograms emitted at the LLM sampling-span close (`closeSamplingSpan`):
 *
 *   gen_ai.client.operation.duration   Histogram  unit `s`
 *     dims: gen_ai.operation.name (Req), gen_ai.provider.name, gen_ai.request.model,
 *           error.type (on error only)
 *
 *   gen_ai.client.token.usage          Histogram  unit `{token}`
 *     TWO observations per call, split by the Required `gen_ai.token.type`
 *     (`input` | `output`); dims: gen_ai.operation.name (Req) +
 *     gen_ai.provider.name (Req) + gen_ai.request.model
 *
 * WHY a dedicated emitter (not `defaultMetricsRegistry.observe`): the registry
 * API carries NO `unit`/`description` on its samples — `observe(name,value,labels)`
 * cannot express the UCUM unit OTel-GenAI REQUIRES on these histograms. This
 * emitter builds a full {@link MetricSample} (with `unit`) and hands it to the
 * process-default {@link MetricSink} directly, so the unit reaches the OTLP
 * metric descriptor via `exporterMetricSink` → `recordMetric` → `serializeMetrics`.
 *
 * GATED on the metric sink being LIVE: `getDefaultMetricSink()` is `null` on
 * ordinary (export-OFF) runs, so this emits NOTHING — byte-identical, zero-alloc.
 * A sink is only installed by `installOtelSpanExportFromEnv` (QUANTA_OTEL_ENDPOINT
 * set). This is the SAME gate `instrumentToolsForExport` uses, so there is no new
 * activation surface.
 *
 * Plane-clean: imports ONLY the sibling metrics port + registry sink accessor +
 * the vocabulary/error keys (a standalone constants module). No `@/agent`,
 * `@/llm`, `@/tool`.
 *
 * No collision with the existing `{tool,ok}` metrics (`instrument-tool.ts`): the
 * metric NAMES are disjoint (`gen_ai.client.*` vs `tool.call.*`) and the label
 * schema is disjoint too — an OTel backend keys a time-series on (name + labels),
 * and neither name nor label-key overlaps.
 */

import { ERROR_ATTRS, GEN_AI_ATTRS } from "../vocabulary"
import { getDefaultMetricSink } from "./in-memory-registry"
import type { MetricSample } from "./port"

/** UCUM unit for `gen_ai.client.operation.duration` (seconds). */
const DURATION_UNIT = "s"
/** UCUM annotation unit for `gen_ai.client.token.usage` (dimensionless count). */
const TOKEN_UNIT = "{token}"

const DURATION_NAME = GEN_AI_ATTRS.metric.operationDuration
const TOKEN_USAGE_NAME = GEN_AI_ATTRS.metric.tokenUsage

/** `gen_ai.token.type` enum values (pinned semconv — Required on token.usage). */
const TOKEN_TYPE_KEY = GEN_AI_ATTRS.token.type
const TOKEN_TYPE_INPUT = "input"
const TOKEN_TYPE_OUTPUT = "output"

/** Inputs for one sampling-span close — the caller already has all of these at
 *  `closeSamplingSpan` (timing → duration, capturedUsage → tokens, requestModel /
 *  provider / status / errorKind for the dims). */
export interface GenAiMetricInput {
  /** Span wall-clock duration in MILLISECONDS (converted to `s` for the metric).
   *  Non-finite / negative ⇒ the duration metric is skipped (a poisoned timing
   *  must not reach the histogram). */
  readonly durationMs: number
  /** Normalized requested-model slug (`gen_ai.request.model` dim). Omitted ⇒ the
   *  model dim is not attached (still a valid series on operation+provider). */
  readonly requestModel?: string
  /** Provider slug (`gen_ai.provider.name` dim). Omitted ⇒ dim absent. */
  readonly provider?: string
  /** Terminal status. `"error"` ⇒ the duration metric additionally carries the
   *  `error.type` dim (Conditionally-Required when errored). */
  readonly status: "ok" | "error" | "aborted"
  /** Bounded error-class slug for the `error.type` dim (used verbatim on
   *  `status==="error"`; `"_OTHER"` fallback when absent). Never a raw message. */
  readonly errorKind?: string
  /** Provider-reported token usage (input/output). Absent ⇒ the token.usage
   *  metric is skipped entirely (no bogus zero observations). */
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** The GenAI `chat` operation discriminator — the only operation this LLM
 *  sampling path represents. */
const OPERATION_CHAT = "chat"

const fin = (n: number): boolean => Number.isFinite(n) && n >= 0

/** Base dims shared by BOTH metrics: operation (Req) + provider + request.model. */
const baseDims = (input: GenAiMetricInput): Record<string, string> => {
  const dims: Record<string, string> = { [GEN_AI_ATTRS.operation.name]: OPERATION_CHAT }
  if (input.provider !== undefined && input.provider !== "")
    dims[GEN_AI_ATTRS.provider.name] = input.provider
  if (input.requestModel !== undefined && input.requestModel !== "")
    dims[GEN_AI_ATTRS.request.model] = input.requestModel
  return dims
}

/**
 * Emit the two GenAI client Histograms for one sampling-span close. NO-OP when
 * no process-default metric sink is installed (export OFF ⇒ byte-identical).
 * No-throw: any sink failure is swallowed (observability must never break the
 * loop) — `MetricSink.send` is no-throw by contract, but we belt-and-suspender.
 */
export const emitGenAiClientMetrics = (input: GenAiMetricInput): void => {
  const sink = getDefaultMetricSink()
  if (sink === null) return
  const dims = baseDims(input)

  // 1) operation.duration — unit `s`. error.type dim only on an errored close.
  if (fin(input.durationMs)) {
    const durationDims =
      input.status === "error"
        ? {
            ...dims,
            [ERROR_ATTRS.type]:
              input.errorKind !== undefined && input.errorKind !== "" ? input.errorKind : "_OTHER",
          }
        : dims
    send(sink, {
      name: DURATION_NAME,
      kind: "histogram",
      value: input.durationMs / 1000,
      at: Date.now(),
      unit: DURATION_UNIT,
      labels: durationDims,
    })
  }

  // 2) token.usage — unit `{token}`, TWO observations split by gen_ai.token.type.
  if (input.inputTokens !== undefined && fin(input.inputTokens)) {
    send(sink, tokenSample(dims, TOKEN_TYPE_INPUT, input.inputTokens))
  }
  if (input.outputTokens !== undefined && fin(input.outputTokens)) {
    send(sink, tokenSample(dims, TOKEN_TYPE_OUTPUT, input.outputTokens))
  }
}

const tokenSample = (
  dims: Record<string, string>,
  tokenType: string,
  value: number,
): MetricSample => ({
  name: TOKEN_USAGE_NAME,
  kind: "histogram",
  value,
  at: Date.now(),
  unit: TOKEN_UNIT,
  labels: { ...dims, [TOKEN_TYPE_KEY]: tokenType },
})

const send = (
  sink: NonNullable<ReturnType<typeof getDefaultMetricSink>>,
  s: MetricSample,
): void => {
  try {
    sink.send(s)
  } catch {
    /* observability emission must never break the wrapped LLM turn */
  }
}
