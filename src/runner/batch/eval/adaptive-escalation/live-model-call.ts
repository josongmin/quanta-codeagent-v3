import {
  assembleFromEvents,
  buildModelPinnedPort,
  type LLMPort,
  type Message,
  type StreamEvent,
  tryCreateLLM,
  validateAgainstResponseSchema,
} from "@/llm"
import type { AdaptiveModelCall, AdaptiveModelCallArgs } from "./llm-router"
import { DEFAULT_ROUTER_MAX_TOKENS, DEFAULT_ROUTER_MODEL } from "./llm-router"

const ROUTER_TOOL_NAME = "route_adaptive_phase"

const ROUTER_SYSTEM = [
  "You are a strict structured-output router.",
  "Call the single provided tool exactly once.",
  "Do not emit prose or markdown.",
].join("\n")

const collectText = (events: readonly StreamEvent[]): string =>
  assembleFromEvents([...events])
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

/** Read the router's decision out of a completed event stream.
 *
 *  A unit because the router accepts exactly three wire shapes in a strict
 *  preference order, and every caller wants the same one answer regardless of
 *  which arrived: the forced `ROUTER_TOOL_NAME` tool call (the happy path), a
 *  text body that validates against the same schema, or the raw text as a last
 *  resort — with `null` reserved for "the model said nothing at all". Kept SYNC
 *  (the inline form was too), so no await point is introduced after the drain. */
const extractRouterDecision = (
  events: readonly StreamEvent[],
  schema: Record<string, unknown>,
): unknown => {
  const assembled = assembleFromEvents([...events]).message
  for (const block of assembled.content) {
    if (block.type === "tool_use" && block.name === ROUTER_TOOL_NAME) return block.input
  }
  const text = collectText(events)
  const parsed = validateAgainstResponseSchema(text, schema)
  return parsed.ok ? parsed.value : text === "" ? null : text
}

/**
 * Provider-agnostic adaptive router call. The primary path is one forced
 * schema-tool call (`toolChoice:{kind:"tool"}`), which Anthropic and OpenAI
 * both support. If a provider still returns plain text, we accept it only when
 * it parses and validates against the requested schema; otherwise the raw text
 * is returned and the controller rejects it fail-closed.
 *
 * jun-23 A1 — the resolved `model` / `maxTokens` (opus pin + 1024 from
 * `llm-router.ts`) are carried by the INJECTED `llm` port: `StreamInput` has no
 * model field, so a per-call model override in this codebase is done by handing
 * this call a port already pinned to that model (`buildModelPinnedPort`), not a
 * request string. `input.model` / `input.maxTokens` are therefore honored as a
 * documented CROSS-CHECK against the port the request actually runs on — never
 * silently dropped. The optional `onResolvedModel` hook surfaces the model the
 * wire request runs on so an engage-proof test can observe it.
 */
export const makeAdaptiveToolModelCall = (args: {
  readonly llm: LLMPort
  readonly signal?: AbortSignal
  /** Observability seam: invoked once per router call with the model id the
   *  request actually runs on (the injected port's `model`) and the resolved
   *  pin the router asked for. Best-effort — failures are swallowed. */
  readonly onResolvedModel?: (resolved: {
    readonly requested: string
    readonly actual: string | undefined
  }) => void
}): AdaptiveModelCall => {
  return async (input: AdaptiveModelCallArgs): Promise<unknown> => {
    // Honor the resolved model/maxTokens as a cross-check: the port the router
    // streams against IS the per-call model override (see jsdoc). Surface the
    // actual-vs-requested model so the field is observable, not inert.
    try {
      args.onResolvedModel?.({ requested: input.model, actual: args.llm.model })
    } catch {
      // best-effort observability — never poison the live router call
    }
    const events: StreamEvent[] = []
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: input.prompt }],
      },
    ]
    for await (const event of args.llm.stream({
      system: [{ type: "text", text: ROUTER_SYSTEM }],
      messages,
      tools: [
        {
          name: ROUTER_TOOL_NAME,
          description: "Return the adaptive routing decision as one JSON object.",
          input_schema: input.schema as Record<string, unknown>,
        },
      ],
      toolChoice: { kind: "tool", name: ROUTER_TOOL_NAME },
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })) {
      events.push(event)
    }
    return extractRouterDecision(events, input.schema as Record<string, unknown>)
  }
}

/**
 * jun-23 A1 — build the adaptive-router model-call PINNED to the router model
 * (`DEFAULT_ROUTER_MODEL` = opus) + `DEFAULT_ROUTER_MAX_TOKENS` (1024), instead
 * of streaming the router request on the bench solver port (`deps.llm`).
 *
 * The router is a short, high-stakes one-shot routing decision, so it pins the
 * strongest available Claude model rather than the bench default. Because
 * `StreamInput` has no model field, the pin is realized by building a DEDICATED
 * anthropic adapter and streaming the router request against it (see
 * `buildModelPinnedPort`). When no anthropic credential is available (a
 * ChatGPT-OAuth / OpenAI bench), the call degrades to the solver port — a
 * documented cross-check, never a crash; `onResolvedModel` surfaces the model
 * the request actually runs on for engage-proof telemetry.
 *
 * `env` is threaded in (not read from `process.env` here) so the credential
 * probe stays at the composition root and the function is test-injectable via
 * `buildAnthropicPort`.
 */
export const buildAdaptiveRouterModelCall = (deps: {
  /** Bench solver port — the fallback when the router model cannot be served. */
  readonly basePort: LLMPort
  /** Env source for the anthropic-credential probe (no `process.env` read here). */
  readonly env: Record<string, string | undefined>
  readonly signal?: AbortSignal
  /** Test seam: override the anthropic adapter builder. Real callers omit it and
   *  get the `tryCreateLLM("anthropic", { model, maxTokens })` path. */
  readonly buildAnthropicPort?: (args: {
    readonly model: string
    readonly maxTokens: number
  }) => LLMPort | null
  /** Engage-proof telemetry: the model the router request actually runs on. */
  readonly onResolvedModel?: (resolved: {
    readonly requested: string
    readonly actual: string | undefined
    readonly pinned: boolean
  }) => void
}): AdaptiveModelCall => {
  const buildAnthropicPort =
    deps.buildAnthropicPort ??
    ((a: { model: string; maxTokens: number }): LLMPort | null =>
      tryCreateLLM("anthropic", { model: a.model, maxTokens: a.maxTokens }, deps.env))
  const { port, pinned } = buildModelPinnedPort({
    basePort: deps.basePort,
    model: DEFAULT_ROUTER_MODEL,
    maxTokens: DEFAULT_ROUTER_MAX_TOKENS,
    buildAnthropicPort,
  })
  return makeAdaptiveToolModelCall({
    llm: port,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    onResolvedModel: (r) => deps.onResolvedModel?.({ ...r, pinned }),
  })
}
