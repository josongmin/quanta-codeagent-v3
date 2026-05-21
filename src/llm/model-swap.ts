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
 * TODO(absorb #7): wire SubmitRetryBotMessage equivalent into loop/CLI
 *   (a `/retry-with <model>` command resolving via {@link resolveRetryModel}
 *   then re-streaming via {@link streamWithModel}, replacing the prior
 *   assistant message keyed by `Message.id`).
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
