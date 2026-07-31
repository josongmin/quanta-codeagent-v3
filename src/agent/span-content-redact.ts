/**
 * OTLP/OBSERVE span-content (Plane B) redaction — the ONE shared helper.
 *
 * Extracted (jul-28 remaining-work audit) so the LLM-sampling span path
 * (loop-helpers.ts) and the TOOL-dispatch span path (dispatch.ts) redact
 * identically. The tool-span path previously attached `previewPayload(input)` /
 * `previewPayload(output)` UNREDACTED whenever a span sink was live — a real
 * secret-egress (a bash command / apply_patch body carrying a token left the
 * process on the OTLP sink). Both paths now go through `redactThenPreview` +
 * gate on `contentCaptureEnabled()`.
 *
 * Plane A (the cassette / JSONL recording) is NEVER redacted here — this module
 * is only reached on the span-content path.
 */
import { PREVIEW_MAX, previewPayload } from "@/observability"
import { redactSecrets } from "@/security"

/** Gate key for OTLP span-content capture. Exported so the composition root can
 *  evaluate it against the injected env and store the result on AgentConfig. */
export const CONTENT_CAPTURE_ENV = "QUANTA_OTEL_CAPTURE_CONTENT"

/** Redact a text payload for the span-content plane. Origin `tool_result` is the
 *  general content-observation origin the rollup already understands. */
export const redactForSpan = (text: string): string =>
  redactSecrets(text, { origin: "tool_result" }).text

/**
 * Redact-BEFORE-truncate for the span-content plane (T-D1 leak fix).
 * `previewPayload(v, Infinity)` gives the whitespace-collapsed, UNtruncated
 * string; we redact THAT (so a secret straddling the `PREVIEW_MAX` boundary is
 * scrubbed as a whole — never leaking its un-redacted head), then re-preview to
 * `PREVIEW_MAX` to restore the bounded `… (+N)` shape. Redact-before-truncate is
 * the only order that closes the boundary-straddle leak.
 */
export const redactThenPreview = (value: unknown): string =>
  previewPayload(redactForSpan(previewPayload(value, Number.POSITIVE_INFINITY)), PREVIEW_MAX)
