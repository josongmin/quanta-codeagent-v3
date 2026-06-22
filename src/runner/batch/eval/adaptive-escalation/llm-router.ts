/**
 * Adaptive-escalation LLM router PORT FACTORY (jun-22 v5 Wave-3, group D wiring).
 *
 * The Wave-1 controller (`./controller.ts`) drives a bounded route→admit→execute
 * loop over an INJECTED `router` port:
 *
 *     router: (input: AdaptiveRouterInput<P>) => Promise<unknown>
 *
 * with `P = RouterEvidence`. This module builds the REAL router port: it turns a
 * projected evidence packet into a forced StructuredOutput model call and returns
 * the model's RAW tool input so the controller can validate it fail-closed via
 * `parseAdaptiveDecision`. The port deliberately does NOT parse / repair / coerce
 * — submit authority and validation stay with the controller's rails (the v5
 * authority fence): any invalid model output flows back verbatim and the
 * controller maps it to escalate-needs-human.
 *
 * # Hermetic by construction
 *
 * The model call is an INJECTED dependency (`AdaptiveModelCall`), never a network
 * client constructed here — so the factory is unit-testable with a fake and free
 * of any LLM / credential / fs dependency. Wave-3 integration supplies a real
 * `call` that adapts the project's `LLMPort` + StructuredOutput seam:
 *
 *   - `buildRouterPrompt(packet.rendered)` is the prompt (this module owns that),
 *   - `ADAPTIVE_DECISION_JSON_SCHEMA` is the forced single-tool / structured
 *     output schema (`src/llm/structured-output.ts` `toAnthropicForcedTool`
 *     for Anthropic, `toOpenAIResponseFormat` for OpenAI),
 *   - the conforming JSON arrives as the forced `tool_use` input (Anthropic) or
 *     the `response_format` text (OpenAI), which the adapter returns as the raw
 *     object — exactly what this port hands the controller.
 *
 * # No swallowing
 *
 * A genuine transport failure (network / 4xx / timeout) PROPAGATES — the injected
 * `call`'s rejection is not caught — so the controller can classify a real infra
 * stop distinctly from a junk-but-returned model reply. The port only refuses to
 * *interpret* the model's reply; it never hides a failed call.
 */

import { ADAPTIVE_DECISION_JSON_SCHEMA } from "./decision-schema"
import type { AdaptiveRouterInput } from "./controller"
import type { RouterEvidence } from "./router-evidence"
import { buildRouterPrompt } from "./router-prompt"

/** The closed adaptive-decision JSON schema's static type, pinned so the injected
 *  call sees the exact `ADAPTIVE_DECISION_JSON_SCHEMA` reference (TOOTH 4). */
export type AdaptiveDecisionSchema = typeof ADAPTIVE_DECISION_JSON_SCHEMA

/** Args the router hands the injected model-call: the fully-built prompt, the
 *  forced StructuredOutput schema, and the resolved model / token budget. The
 *  integration adapter maps these onto the real `LLMPort.stream` request
 *  (forced tool for Anthropic / `response_format` for OpenAI). */
export interface AdaptiveModelCallArgs {
  /** `buildRouterPrompt(packet.rendered)` — static action menu + the rendered,
   *  blindness-audited evidence packet body. */
  readonly prompt: string
  /** The forced structured-output schema — always `ADAPTIVE_DECISION_JSON_SCHEMA`. */
  readonly schema: AdaptiveDecisionSchema
  /** Resolved model id (deps override or {@link DEFAULT_ROUTER_MODEL}). */
  readonly model: string
  /** Resolved max output tokens (deps override or {@link DEFAULT_ROUTER_MAX_TOKENS}). */
  readonly maxTokens: number
}

/**
 * The injected model-call seam. Takes the prompt + forced schema and returns the
 * RAW structured object the model produced (the forced-tool input / the parsed
 * `response_format` JSON). It MUST NOT validate against the adaptive schema —
 * that is the controller's fail-closed job. It MAY reject on a genuine transport
 * failure; the router lets that propagate.
 */
export type AdaptiveModelCall = (args: AdaptiveModelCallArgs) => Promise<unknown>

/** Default router model — the latest Claude id. The router is a short,
 *  high-stakes routing decision (one closed action), so it pins the strongest
 *  available model rather than the bench `defaultModel` (sonnet). Override via
 *  `deps.model`. */
export const DEFAULT_ROUTER_MODEL = "claude-opus-4-8"

/** Default max output tokens. The decision object is tiny (one action + a short
 *  taxonomy + a one-line `why`); 1024 is ample headroom and bounds a runaway. */
export const DEFAULT_ROUTER_MAX_TOKENS = 1024

/** Factory dependencies. The model-call is REQUIRED and injected so the factory
 *  is hermetic; model / maxTokens are optional with sane defaults. */
export interface MakeLlmRouterDeps {
  readonly call: AdaptiveModelCall
  /** Override the default router model id. */
  readonly model?: string
  /** Override the default max output tokens. */
  readonly maxTokens?: number
}

/**
 * Build the controller's `router` port. The returned function:
 *   1. builds `buildRouterPrompt(input.packet.rendered)` (prompt CONTAINS the
 *      rendered packet body + the closed action menu — TOOTH 1),
 *   2. invokes the injected model-call with that prompt + the pinned
 *      `ADAPTIVE_DECISION_JSON_SCHEMA` (forced structured output — TOOTH 4),
 *   3. returns the model's RAW object verbatim — no parse, no repair (TOOTH 2/3),
 *      so the controller's `parseAdaptiveDecision` sees exactly the model output.
 *
 * `citableIds` is part of the controller's port contract but the router itself
 * does NOT use it: citation-scope enforcement is the parser's job (it needs the
 * live packet ids), and the prompt already instructs "cite only packet ids". The
 * router stays a thin, faithful prompt→call→raw bridge.
 */
export const makeLlmRouter =
  (deps: MakeLlmRouterDeps): ((input: AdaptiveRouterInput<RouterEvidence>) => Promise<unknown>) =>
  (input: AdaptiveRouterInput<RouterEvidence>): Promise<unknown> =>
    deps.call({
      prompt: buildRouterPrompt(input.packet.rendered),
      schema: ADAPTIVE_DECISION_JSON_SCHEMA,
      model: deps.model ?? DEFAULT_ROUTER_MODEL,
      maxTokens: deps.maxTokens ?? DEFAULT_ROUTER_MAX_TOKENS,
    })
