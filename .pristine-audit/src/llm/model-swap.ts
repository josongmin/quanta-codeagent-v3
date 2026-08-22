import { QuantaError } from "@/shared"
import type { LLMPort } from "./ports"
import type { StreamEvent, StreamInput } from "./types"

/**
 * Model-swap retry — re-stream a single assistant turn against a DIFFERENT
 * model and REPLACE the prior assistant message. Absorbed from v0.dev's
 * `SubmitRetryBotMessage { messageId, retryModelId }` + `getEnabledModelFallback`
 * ordered-list selection (absorb #7).
 *
 * This is deliberately distinct from the two pre-existing recovery paths:
 *
 *  - `RetryingLLM` (src/agent/retry.ts) retries a TRANSIENT pre-stream failure
 *    on the SAME model. No model changes; failure-driven.
 *  - `FallbackLLM` (src/llm/fallback.ts) fails over to a backup model when the
 *    primary DIES mid/pre-stream. Provider-death driven; the swap is automatic
 *    and reactive to an error.
 *
 * Model-swap retry is INTENTIONAL: an operator or the loop chooses an alternate
 * model for a turn that already succeeded (user dissatisfied with the answer)
 * or to escalate quality (e.g. opus → max). There is no error — the same
 * `StreamInput` is re-run against a different `LLMPort`.
 *
 * This module is pure opt-in machinery: importing it changes no existing
 * behaviour and emits nothing until a caller invokes {@link streamWithModel}.
 * It lives in the `@/llm` slice because it only touches `@/llm` (`LLMPort`,
 * `StreamEvent`, `StreamInput`) + `@/shared` (`QuantaError`) — both legal here.
 *
 * Wiring: `/retry-with <model>` lives in `src/apps/cli/retry-with.ts` and is
 * registered into the slash-command builtins (`src/apps/cli/slash-commands.ts`).
 * It resolves via {@link resolveRetryModel} then re-streams via
 * {@link streamWithModel}, replacing the prior assistant message keyed by
 * `Message.id`. Direct importers of this module (loop / tests) can still call
 * the pure functions without going through the CLI seam.
 */

/** One selectable model: a stable id paired with the port that streams it. */
export interface ModelCandidate {
  id: string
  port: LLMPort
}

/** Configuration for a model-swap-retry capable caller. The candidate order is
 *  significant: it defines the escalation sequence used when no explicit model
 *  is requested (mirrors v0's enabled-model ordered list). */
export interface ModelSwapRetryOptions {
  candidates: readonly ModelCandidate[]
}

/** Raised when no DISTINCT alternate model can be selected for a swap retry —
 *  either the requested id is absent, or `current` is already the last entry
 *  in the ordered escalation list (wrapping is NOT allowed). */
export class NoAlternateModelError extends QuantaError {
  constructor(message: string) {
    super("no_alternate_model", message)
  }
}

/**
 * Pure ordered-list selection: return the id immediately AFTER `current` in
 * `orderedIds`, or `null` if `current` is the last entry or absent (wrapping is
 * NOT allowed). Mirrors v0's `getEnabledModelFallback` next-in-list semantics.
 */
export const pickNextModel = (current: string, orderedIds: readonly string[]): string | null => {
  const idx = orderedIds.indexOf(current)
  if (idx === -1) return null
  const next = orderedIds[idx + 1]
  return next ?? null
}

/**
 * Resolve which candidate to re-run a turn against.
 *
 *  - If `requested` is given, pick the candidate with that exact id (it must be
 *    present and DISTINCT from `current`); otherwise throw.
 *  - Otherwise escalate: pick the NEXT candidate after `current` in the ordered
 *    list. Wrapping is NOT allowed — if `current` is the last (or absent), there
 *    is no alternate and we throw.
 *
 * Throws {@link NoAlternateModelError} when no distinct alternate exists.
 */
export const resolveRetryModel = (args: {
  current: string
  candidates: readonly ModelCandidate[]
  requested?: string
}): ModelCandidate => {
  const { current, candidates, requested } = args

  if (requested !== undefined) {
    if (requested === current) {
      throw new NoAlternateModelError(
        `requested model "${requested}" is the same as the current model; a swap retry must change models`,
      )
    }
    const match = candidates.find((c) => c.id === requested)
    if (match === undefined) {
      throw new NoAlternateModelError(`requested model "${requested}" is not an enabled candidate`)
    }
    return match
  }

  // Escalation: next distinct candidate after `current`.
  const orderedIds = candidates.map((c) => c.id)
  const nextId = pickNextModel(current, orderedIds)
  if (nextId === null) {
    throw new NoAlternateModelError(
      `no alternate model after "${current}" in the candidate list (wrapping is not allowed)`,
    )
  }
  const next = candidates.find((c) => c.id === nextId)
  if (next === undefined) {
    // Unreachable: nextId came from orderedIds which maps candidates 1:1.
    throw new NoAlternateModelError(`alternate model "${nextId}" has no candidate port`)
  }
  return next
}

/**
 * Stream a turn from the chosen candidate's port, prefixed with a single
 * `stream_reset` tombstone. The leading `stream_reset` reuses the semantics
 * documented on {@link StreamEvent} (src/llm/types.ts): any consumer that had
 * accumulated the PRIOR assistant message (the one being replaced) MUST discard
 * it and assemble fresh from this stream. The tombstone is emitted exactly once,
 * before any inner event.
 */
export async function* streamWithModel(
  candidate: ModelCandidate,
  input: StreamInput,
): AsyncIterable<StreamEvent> {
  yield { type: "stream_reset" }
  for await (const ev of candidate.port.stream(input)) {
    yield ev
  }
}

/**
 * Build a port pinned to a SPECIFIC model id + output-token cap, for a
 * short high-stakes side call (the adaptive-escalation router — jun-23 A1).
 *
 * Why this exists: `StreamInput` carries NO model / max_tokens field — in this
 * codebase those wire fields are baked into the adapter at construction
 * (`createLLM({ model, maxTokens })`), and a per-call model override is done by
 * SWAPPING the `LLMPort` instance (the {@link ModelCandidate} mechanism above),
 * never by a request-level model string. The adaptive router resolves a model
 * (`DEFAULT_ROUTER_MODEL` = opus) + `maxTokens` (`DEFAULT_ROUTER_MAX_TOKENS`)
 * but the live model-call was injected the BENCH SOLVER port (sonnet/oauth) and
 * streamed against IT — so the resolved fields were inert. This builds the
 * port that actually carries them onto the wire.
 *
 * Provider reality: the router pins a Claude model (anthropic). When an
 * anthropic credential is available (provider resolves to `anthropic`, or an
 * `ANTHROPIC_API_KEY` is present), a dedicated anthropic adapter is built with
 * `{ model, maxTokens }` baked in and returned as `pinned:true`. When no
 * anthropic credential exists (e.g. a ChatGPT-OAuth or OpenAI bench), the model
 * cannot be served, so the call DEGRADES to the base solver port (`pinned:false`)
 * rather than crashing — a documented cross-check, not an inert field. The
 * returned `model` is the model the router request will actually run on.
 *
 * Hermetic: `deps.tryCreateLLM` is injected so callers / tests pass a fake
 * factory; the real driver passes `@/llm`'s `tryCreateLLM`. No `process.env`
 * read here — the composition root threads `env` in.
 */
export const buildModelPinnedPort = (deps: {
  /** Fallback when the pinned model cannot be served (no anthropic credential).
   *  Usually the bench solver port (`deps.llm`). */
  readonly basePort: LLMPort
  /** Canonical un-suffixed model id the router request must run on (opus). */
  readonly model: string
  /** Max output tokens to bake into the pinned adapter. */
  readonly maxTokens: number
  /** Env-driven anthropic-credential probe + adapter factory (inject `@/llm`'s
   *  `tryCreateLLM`-backed builder). Returns `null` when the credential is
   *  absent (then we fall back to `basePort`). */
  readonly buildAnthropicPort: (args: {
    readonly model: string
    readonly maxTokens: number
  }) => LLMPort | null
}): { readonly port: LLMPort; readonly model: string; readonly pinned: boolean } => {
  const pinned = deps.buildAnthropicPort({ model: deps.model, maxTokens: deps.maxTokens })
  if (pinned !== null) {
    return { port: pinned, model: pinned.model ?? deps.model, pinned: true }
  }
  return { port: deps.basePort, model: deps.basePort.model ?? "unknown", pinned: false }
}
