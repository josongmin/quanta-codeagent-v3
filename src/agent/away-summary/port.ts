/**
 * AFK away-summary slice — injected summarizer port + verbatim prompt
 * (ADR-0465).
 *
 * Slices imported: `@/shared` ONLY (Result). This file deliberately does NOT
 * import `@/llm`. The summarizer is a FUNCTION port (mirrors
 * `src/permission/classifier.ts`'s `ClassifierPort`): the composition root in
 * `@/apps` builds the real implementation over `LLMPort` with ALL tools
 * denied, `maxTurns: 1`, `skipTranscript`, and `skipCacheWrite`, then injects
 * it here. This slice owns the PROMPT and the orchestration; it never owns the
 * wire.
 *
 * NO-THROW contract: `SummarizeFn` returns `Promise<Result<string>>`. A
 * programmer-bug or transport failure is encoded as `Err`, never thrown — the
 * runner maps `Err` to a typed `summarizer-error` skip.
 */

import type { Result } from "@/shared"
import type { RecapTurn } from "./types"

/* ------------------------------------------------------------------------- *
 * VERBATIM system prompt (Claude Code 2.1.150 away-summary, lightly adapted).
 * The fidelity of this wording is load-bearing — do not paraphrase. It is the
 * full system prompt for the isolated single-turn query.
 * ------------------------------------------------------------------------- */

/** The away-summary system prompt. Sourced verbatim from Claude Code 2.1.150
 *  (the only adaptation is none — it is reproduced as shipped). Used as the
 *  system message of the isolated, tools-denied, maxTurns=1 query. */
export const AWAY_SUMMARY_SYSTEM_PROMPT =
  "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. " +
  "Lead with the overall goal and current task, then the one next action. " +
  "Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents."

/**
 * INJECTED summarizer port. The real impl (LLM-backed, tools denied,
 * single-turn, skip-transcript, skip-cache-write) is provided by the
 * composition root in `@/apps`. Absent ⇒ the runner cannot be constructed; a
 * caller that has no summarizer simply does not call this slice.
 *
 * Contract:
 *   - `system` is {@link AWAY_SUMMARY_SYSTEM_PROMPT} (the slice passes it; the
 *     adapter MUST use it verbatim as the system message).
 *   - `transcript` is the {@link RecapTurn} projection — the adapter shapes it
 *     into a single user message describing the session so far.
 *   - `signal` (when supplied) MUST be honored: an abort resolves `Err`.
 *   - NO-THROW: any failure (transport, abort, refusal, empty) resolves `Err`
 *     with a short human-readable detail. The adapter MUST NOT reject.
 */
export type SummarizeFn = (args: {
  readonly system: string
  readonly transcript: readonly RecapTurn[]
  readonly signal?: AbortSignal | undefined
}) => Promise<Result<string>>
