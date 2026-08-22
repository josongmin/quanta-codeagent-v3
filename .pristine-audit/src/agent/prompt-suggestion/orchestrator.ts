/**
 * Prompt-suggestion slice — orchestrator (ADR-0467).
 *
 * WHAT: `runPromptSuggestion(req) → Result<SuggestionOutcome>`. Ties the slice
 *   together in the canonical order:
 *     1. gate OFF                 → suppress `gate_off`     (no model call)
 *     2. suppression context      → suppress <ctx reason>   (no model call)
 *     3. signal already aborted    → suppress `no_output`    (no model call)
 *     4. call injected SuggestFn (SUGGESTION MODE, tools denied)
 *          - undefined / blank     → suppress `no_output`
 *     5. sanitize the raw output  (strip <suggestion> / label / quotes)
 *     6. pure reject gate
 *          - rejected              → suppress `rejected`
 *          - accepted              → show {text}
 *   The model is consulted AT MOST ONCE and ONLY after the cheap pure gates
 *   pass, so the OFF / suppressed / aborted paths make zero LLM calls.
 *
 * SLICE: `@/agent`. Imports `@/shared` (Result) + this slice's siblings only.
 *   The model call is the injected {@link SuggestFn} (port inversion) — this
 *   slice NEVER imports `@/llm` / `@/tool` / `@/permission`.
 *
 * NO-THROW CONTRACT: returns `Result<SuggestionOutcome>`; a throwing or
 *   rejecting `SuggestFn` is caught and mapped to `suppress no_output` (the
 *   honest degrade — we simply show nothing). Never throws past the boundary.
 *
 * DEFAULT-OFF: gated on `QUANTA_ENABLE_PROMPT_SUGGESTION === "1"` (mirrors
 *   Claude's `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`). Unset ⇒ always returns
 *   `{kind:"suppress", reason:"gate_off"}` WITHOUT calling the model — a
 *   deployment that does not set the flag renders nothing and makes zero calls:
 *   byte-identical to today.
 */

import { gateOnStrict, ok, type Result } from "@/shared"
import { rejectGate } from "./reject-gate"
import { sanitizeSuggestion } from "./sanitize"
import { suppressionReason } from "./suppression"
import type { AppStateView, SuggestFn, SuggestionOutcome } from "./types"

/** The env var that opts a deployment in. Mirrors Claude Code's
 *  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`. Value MUST be exactly `"1"`. */
export const PROMPT_SUGGESTION_ENV = "QUANTA_ENABLE_PROMPT_SUGGESTION"

/**
 * Pure gate check. Reads ONLY the injected env record (never `process.env`).
 * Strict `=== "1"` so `"0"`/`"true"`/`"on"` keep the feature OFF.
 */
export const promptSuggestionEnabled = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => gateOnStrict(env, PROMPT_SUGGESTION_ENV)

/**
 * The "SUGGESTION MODE" system prompt the injected {@link SuggestFn}'s real
 * adapter should use. Exported so the composition root builds the dedicated
 * single-shot call (ALL tools denied) from a single source of truth. The
 * sanitizer expects the `<suggestion>…</suggestion>` wrapper this asks for.
 */
export const SUGGESTION_MODE_SYSTEM_PROMPT = `SUGGESTION MODE.

Suggest the single next thing the user might naturally type — a short, concrete next instruction in the USER's voice, not yours. Output ONLY the suggestion wrapped in <suggestion></suggestion> tags, nothing else.

Rules:
- 2 to 12 words. No formatting, no markdown, no multiple sentences.
- Do NOT write in the assistant's voice ("let me", "I'll", "here's").
- Do NOT praise or acknowledge ("looks good", "perfect").
- If you have nothing useful to suggest, output <suggestion></suggestion> (empty).`

/** Input to the orchestrator. */
export interface PromptSuggestionRequest {
  /** Env record carrying the default-OFF gate. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Typed surface state for the suppression-context guard. */
  readonly state: AppStateView
  /** Optional cancellation. A pre-aborted signal short-circuits to `no_output`
   *  before the model is consulted. */
  readonly signal?: AbortSignal
}

/**
 * Run one suggestion attempt. See the file header for the guard order. The
 * `Result` wrapper is `ok` for every NORMAL outcome (show OR suppress) — a
 * suppression is a valid result, not an error. (The slice has no failure mode
 * that escapes as `Err` today; the signature keeps `Result` for forward-compat
 * with future hard faults and to satisfy the port no-throw convention.)
 */
export async function runPromptSuggestion(
  suggest: SuggestFn,
  req: PromptSuggestionRequest,
): Promise<Result<SuggestionOutcome>> {
  if (!promptSuggestionEnabled(req.env)) {
    return ok({ kind: "suppress", reason: "gate_off" })
  }

  const ctx = suppressionReason(req.state)
  if (ctx !== null) {
    return ok({ kind: "suppress", reason: ctx })
  }

  if (req.signal?.aborted === true) {
    return ok({ kind: "suppress", reason: "no_output" })
  }

  // The ONLY model call. A throw/reject is the honest "show nothing" degrade.
  let raw: string | undefined
  try {
    raw = await suggest(req.signal)
  } catch {
    return ok({ kind: "suppress", reason: "no_output" })
  }

  if (raw === undefined) {
    return ok({ kind: "suppress", reason: "no_output" })
  }

  const sanitized = sanitizeSuggestion(raw)
  const verdict = rejectGate(sanitized)
  if (!verdict.accepted) {
    return ok({ kind: "suppress", reason: "rejected" })
  }

  return ok({ kind: "show", text: sanitized })
}
