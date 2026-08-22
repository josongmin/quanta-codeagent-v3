/**
 * OpenTelemetry GenAI semantic-convention PIN.
 *
 * This module pins the EXACT upstream semconv commit that our `gen_ai.*`
 * attribute vocabulary, span shapes, and metric descriptors conform to. The
 * pinned SHA — NOT `main` — is the normative contract for this repository.
 *
 * ⚠️ Requirement levels (Required / Conditionally-Required / Recommended /
 * Opt-In) are read from THIS pin's registry+span+metric definitions, not from
 * upstream `main`. Between this pin and current upstream, keys may be renamed,
 * moved between requirement levels, or newly-required; those changes do NOT
 * apply here until this pin is deliberately advanced (which requires updating
 * {@link SEMCONV_SNAPSHOT}, the three blob URLs below, and the drift-guard
 * allowlist in `tests/unit/observability/semconv-pin-drift.test.ts`).
 *
 * At this pin the convention is the NEW registry:
 *   - provider is `gen_ai.provider.name` (enum); `gen_ai.system` is ABSENT
 *     upstream (fully replaced) — we retain `gen_ai.system` only for our own
 *     compat window and it is tracked explicitly by the drift allowlist.
 *   - content is opt-in STRUCTURED attributes `gen_ai.input.messages` /
 *     `gen_ai.output.messages` (role + `parts[]`); system prompt is
 *     `gen_ai.system_instructions` (underscore).
 *   - gen_ai spans are at maturity **Development** (do NOT call them "stable").
 *   - both metrics are **Recommended** (NOT Required).
 *
 * See ADR-0539 (§ Amendment — GenAI semconv snapshot is PINNED) and
 * `docs/tickets/jul-13-tracing-ssot-sota-tickets.md`
 * (§ "Normative semconv contract (PINNED 63f8200…)").
 */

/** The pinned upstream `open-telemetry/semantic-conventions` commit SHA.
 *  Requirement levels are read from THIS commit, not upstream main. */
export const SEMCONV_SNAPSHOT = "63f8200eee093730ce845d26ce2aafb621b0807e" as const

/** GenAI CLIENT chat/agent/tool SPAN definitions at the pin. Chat span name is
 *  `{gen_ai.operation.name} {gen_ai.request.model}`, kind SHOULD be CLIENT. */
export const SEMCONV_GEN_AI_SPANS_URL =
  `https://github.com/open-telemetry/semantic-conventions/blob/${SEMCONV_SNAPSHOT}/docs/gen-ai/gen-ai-spans.md` as const

/** GenAI invoke_agent / execute_tool AGENT span definitions at the pin. */
export const SEMCONV_GEN_AI_AGENT_SPANS_URL =
  `https://github.com/open-telemetry/semantic-conventions/blob/${SEMCONV_SNAPSHOT}/docs/gen-ai/gen-ai-agent-spans.md` as const

/** GenAI client METRICS (operation.duration `s`, client.token.usage `{token}`)
 *  definitions at the pin. Both are Histograms; both Recommended (not Required). */
export const SEMCONV_GEN_AI_METRICS_URL =
  `https://github.com/open-telemetry/semantic-conventions/blob/${SEMCONV_SNAPSHOT}/docs/gen-ai/gen-ai-metrics.md` as const
