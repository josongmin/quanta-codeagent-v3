/**
 * OTLP/JSON attribute-value serialization — the `AnyValue` tagging + KeyValue
 * list builder used by the span/metric serializers in `otel-exporter.ts`.
 *
 * Extracted from `otel-exporter.ts` (which was at its god-MODULE cap) as a
 * cohesive leaf: it maps a typed attribute record → the OTLP tagged-union wire
 * shape (`stringValue` / `intValue` / `doubleValue` / `boolValue` / `arrayValue`),
 * INCLUDING the registry-int handling for the gen_ai token/cap keys (ADR-0539 §
 * Conformance gap-sweep). Depends only on the vocabulary constants — no exporter
 * state, so it is independently unit-testable over the raw wire bytes.
 */

import { GEN_AI_ATTRS } from "./vocabulary"

/** One scalar attribute value the exporter can tag. */
export type OtlpScalar = string | number | boolean
/** Attribute value the exporter accepts: scalar OR a homogeneous array. The
 *  `attrs.ts` builder already validates homogeneity (`vocabulary.ts` AttrValue),
 *  so by the time a value reaches here an array is guaranteed single-typed. */
export type OtlpAttrValue = OtlpScalar | ReadonlyArray<OtlpScalar>

/** Attribute KEYS the OTel-GenAI registry types as `int` — token counts + the
 *  request cap (ADR-0539 § Conformance gap-sweep). For THESE keys ONLY an
 *  exact-integer value is tagged OTLP `intValue`; every other numeric attr (TTFT,
 *  temperature, cost, latencies) stays `doubleValue`, so the fix is key-scoped
 *  and cannot mis-type a fractional value that happens to be whole. */
const GEN_AI_INT_ATTR_KEYS: ReadonlySet<string> = new Set([
  GEN_AI_ATTRS.usage.inputTokens,
  GEN_AI_ATTRS.usage.outputTokens,
  GEN_AI_ATTRS.usage.cacheCreationInputTokens,
  GEN_AI_ATTRS.usage.cacheReadInputTokens,
  GEN_AI_ATTRS.request.maxTokens,
])

/** Tag a scalar as an OTLP `AnyValue`. `key` (the owning attr key; absent for
 *  array elements) selects `intValue` for a registry-int gen_ai key holding an
 *  exact integer — else number → `doubleValue`. See {@link GEN_AI_INT_ATTR_KEYS}. */
const otlpScalarValue = (v: OtlpScalar, key?: string): Record<string, unknown> => {
  if (typeof v === "string") return { stringValue: v }
  if (typeof v === "number") {
    // OTLP encodes 64-bit ints as a STRING in JSON to avoid precision loss.
    if (key !== undefined && GEN_AI_INT_ATTR_KEYS.has(key) && Number.isInteger(v))
      return { intValue: `${v}` }
    return { doubleValue: v }
  }
  return { boolValue: v }
}

/** Convert a typed attribute map → OTLP KeyValue list. OTLP attribute values
 *  are tagged unions (`stringValue` / `intValue` / `doubleValue` / `boolValue`
 *  / `arrayValue`). Homogeneous arrays (e.g. `gen_ai.response.finish_reasons`)
 *  serialize to `arrayValue.values` — each element re-tagged — rather than being
 *  silently dropped (the known-int keys are scalar, so array elements pass no key). */
export const otlpAttributes = (
  attrs: Readonly<Record<string, OtlpAttrValue>> | undefined,
): Array<Record<string, unknown>> => {
  if (attrs === undefined) return []
  const out: Array<Record<string, unknown>> = []
  for (const k of Object.keys(attrs)) {
    const v = attrs[k]
    if (Array.isArray(v)) {
      out.push({
        key: k,
        value: { arrayValue: { values: v.map((e) => otlpScalarValue(e)) } },
      })
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out.push({ key: k, value: otlpScalarValue(v, k) })
    }
  }
  return out
}
