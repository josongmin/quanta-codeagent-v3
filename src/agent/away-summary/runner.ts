/**
 * AFK away-summary slice — gate, shouldEmit guard, and runner (ADR-0465).
 *
 * Slices imported: this slice's own `port`/`types` ONLY (no `@/shared` import —
 * the no-throw narrator uses an inline `never` binding rather than `assertNever`
 * so it degrades to a string instead of throwing past the boundary).
 * NO `@/llm` — the summarizer arrives as the injected {@link SummarizeFn}.
 *
 * DEFAULT-OFF: the behavior is gated on `QUANTA_ENABLE_AWAY_SUMMARY === "1"`
 * (mirrors Claude's `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`). When the flag is unset
 * the runner returns `{kind:"skip", reason:{kind:"gate-off"}}` WITHOUT ever
 * consulting the summarizer — so a deployment that does not set the flag makes
 * zero LLM calls and renders nothing: byte-identical to today.
 *
 * NO-THROW contract: every function returns a value (Result/outcome/boolean),
 * never throws. The summarizer's `Err` and an aborted signal are both encoded
 * as typed skip reasons.
 */

import { AWAY_SUMMARY_SYSTEM_PROMPT, type SummarizeFn } from "./port"
import type { AwaySummaryOutcome, AwaySummaryRequest, RecapTurn } from "./types"

/** The env var that opts a deployment into the away-summary. Mirrors Claude
 *  Code's `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`. Value MUST be exactly `"1"`. */
export const AWAY_SUMMARY_ENV = "QUANTA_ENABLE_AWAY_SUMMARY"

/** Hard ceiling on recap length, in whitespace-delimited words. NOT a tunable
 *  heuristic: it is the literal budget the verbatim system prompt commands
 *  ("Recap in under 40 words") — the runner enforces what the prompt asks so a
 *  model that ignores the instruction cannot surface an over-long wall of text.
 *  "under 40" ⇒ a recap of MORE than this many words is rejected. */
export const AWAY_SUMMARY_MAX_WORDS = 40

/** Count whitespace-delimited words in a (already-trimmed) string. Empty ⇒ 0. */
const wordCount = (text: string): number => (text.length === 0 ? 0 : text.split(/\s+/).length)

/**
 * Pure gate check. `true` ⇒ the feature is opted in for this deployment.
 * Reads ONLY the injected env record (never `process.env`). Strict `=== "1"`
 * so an accidental `"0"` / `"true"` / `"on"` keeps the feature OFF — the
 * single documented opt-in value matches Claude's flag semantics.
 */
export const awaySummaryEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[AWAY_SUMMARY_ENV] === "1"

/**
 * Pure activity guard. A recap is only worth showing AFTER real work has
 * happened — never on a fresh or empty conversation.
 *
 * Signal (closed-form, no magic threshold): at least ONE prior assistant turn
 * that carries non-blank content. That is the minimal evidence that the agent
 * actually did something to recap. A transcript of only user messages (the
 * user typed, stepped away before any response) or only blank assistant turns
 * (e.g. a turn that produced solely a tool call the mapper flattened to "")
 * has nothing to summarize.
 */
export const shouldEmit = (transcript: readonly RecapTurn[]): boolean =>
  transcript.some((turn) => turn.role === "assistant" && turn.text.trim().length > 0)

/**
 * Run a single away-summary attempt.
 *
 * Order of guards (each is a cheap, side-effect-free check BEFORE the
 * summarizer is consulted, so the OFF / no-activity / pre-aborted paths make
 * zero LLM calls):
 *   1. gate OFF                  → skip `gate-off`
 *   2. signal already aborted    → skip `aborted`
 *   3. no real activity          → skip `no-activity`
 *   4. call the injected summarizer:
 *        - Err                   → skip `summarizer-error` (or `aborted` when
 *                                  the signal is the cause)
 *        - signal aborted late   → skip `aborted` (a recap that lands after the
 *                                  user returned is stale — discard it)
 *        - blank text            → skip `empty-recap`
 *        - over {@link AWAY_SUMMARY_MAX_WORDS} words → skip `over-budget`
 *        - text                  → ok (trimmed)
 *
 * NEVER throws. The summarizer is invoked at most once.
 */
export const runAwaySummary = async (
  summarize: SummarizeFn,
  req: AwaySummaryRequest,
): Promise<AwaySummaryOutcome> => {
  if (!awaySummaryEnabled(req.env)) {
    return { kind: "skip", reason: { kind: "gate-off" } }
  }
  if (req.signal?.aborted === true) {
    return { kind: "skip", reason: { kind: "aborted" } }
  }
  if (!shouldEmit(req.transcript)) {
    return { kind: "skip", reason: { kind: "no-activity" } }
  }

  const result = await summarize({
    system: AWAY_SUMMARY_SYSTEM_PROMPT,
    transcript: req.transcript,
    signal: req.signal,
  })

  if (!result.ok) {
    // A summarizer that honors the signal reports abort as Err; surface it as
    // the more specific `aborted` skip when the signal is the cause.
    if (req.signal?.aborted) {
      return { kind: "skip", reason: { kind: "aborted" } }
    }
    return {
      kind: "skip",
      reason: { kind: "summarizer-error", detail: errorDetail(result.error) },
    }
  }

  // A summarizer that resolves `ok` AFTER the user returned (signal aborted
  // mid-flight) produced a stale recap — discard it with the same precedence as
  // the Err-while-aborted branch above. Rendering a recap the user no longer
  // waits for is the exact noise this feature avoids.
  if (req.signal?.aborted) {
    return { kind: "skip", reason: { kind: "aborted" } }
  }

  const text = result.value.trim()
  if (text.length === 0) {
    return { kind: "skip", reason: { kind: "empty-recap" } }
  }
  const words = wordCount(text)
  if (words > AWAY_SUMMARY_MAX_WORDS) {
    return {
      kind: "skip",
      reason: { kind: "over-budget", words, limit: AWAY_SUMMARY_MAX_WORDS },
    }
  }
  return { kind: "ok", text }
}

/** Coerce an unknown port error into a short human-readable detail string.
 *  No-throw: handles Error, string, and arbitrary shapes. */
const errorDetail = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return "unknown summarizer error"
  }
}

/** Exhaustive narrator for a skip reason — handy for `--debug` logging at the
 *  surface. Pure and NO-THROW (unlike `assertNever`): the `_exhaustive: never`
 *  binding makes TS fail to COMPILE if a new skip kind is added without a case
 *  here, but at runtime an unchecked cast degrades to a generic string rather
 *  than throwing past the boundary. */
export const describeSkip = (outcome: AwaySummaryOutcome): string => {
  if (outcome.kind === "ok") return "recap produced"
  const r = outcome.reason
  switch (r.kind) {
    case "gate-off":
      return `away-summary disabled (${AWAY_SUMMARY_ENV} != "1")`
    case "no-activity":
      return "no prior assistant activity to recap"
    case "summarizer-error":
      return `summarizer failed: ${r.detail}`
    case "aborted":
      return "recap aborted"
    case "empty-recap":
      return "summarizer returned blank text"
    case "over-budget":
      return `recap exceeded word budget (${r.words} > ${r.limit})`
    default: {
      // Unreachable while the union is closed (TS fails to compile if a new
      // skip kind is added without a case above). At runtime an unchecked cast
      // could still land here, so degrade to a generic string WITHOUT throwing —
      // reuse the no-throw stringifier so a circular/un-stringifiable shape
      // cannot blow `describeSkip`'s documented NO-THROW contract.
      const _exhaustive: never = r
      return `unknown skip reason: ${errorDetail(_exhaustive)}`
    }
  }
}
