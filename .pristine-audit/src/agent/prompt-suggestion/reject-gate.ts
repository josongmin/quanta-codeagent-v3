/**
 * Prompt-suggestion slice — PURE reject gate (ADR-0467, crown jewel).
 *
 * WHAT: `rejectGate(suggestion) → RejectVerdict`. A pure, total function from a
 *   (sanitized) candidate string to accept / {reject, reason}. One named
 *   predicate per `RejectReason`, evaluated in declaration order, first match
 *   wins. This is the reusable quality filter that decides whether a
 *   model-produced "what to type next" is worth showing the user.
 *
 * SLICE: `@/agent`. Imports ONLY `@/shared` + sibling `./types`. No IO, no
 *   model call, no clock, no env read — pure string predicates.
 *
 * NO-THROW CONTRACT: total over every string (incl. "", whitespace, unicode,
 *   pathological length). Never throws; always returns a `RejectVerdict`.
 *
 * EVIDENCE: Claude CLI 2.1.150 `GZ8` predicate chain, extracted verbatim
 *   (`.extracted_source/claude-code-cli/_cli-symbols.txt`). The regexes and
 *   word lists below are the competitor's, transcribed 1:1. `H` in the source
 *   is the trimmed raw string; `K` its lowercase; `O` the word count.
 */

import { assertNever } from "@/shared"
import {
  REJECT_REASONS,
  type RejectReason,
  type RejectVerdict,
  SHORT_COMMAND_WHITELIST,
  SUGGESTION_LIMITS,
} from "./types"

/** Precompiled regexes (module-scope so the gate allocates nothing per call). */
const META_SILENCE_RE = /\bsilence is\b|\bstay(s|ing)? silent\b/
const META_SILENCE_ONLY_RE = /^\W*silence\W*$/
const META_WRAPPED_RE = /^\(.*\)$|^\[.*\]$/
const PREFIXED_LABEL_RE = /^\w+:\s/
const MULTI_SENTENCE_RE = /[.!?]\s+[A-Z]/
const HAS_FORMATTING_RE = /[\n*]|\*\*/
const EVALUATIVE_RE =
  /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/
const CLAUDE_VOICE_RE =
  /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i

/** Error/meta sentinels a suggestion must not START with (lowercased compare).
 *  Verbatim from the competitor `error_message` predicate. */
const ERROR_PREFIXES: readonly string[] = [
  "api error:",
  "prompt is too long",
  "request timed out",
  "invalid api key",
  "image was too large",
]

/** Meta-text sentinels: the model said "I have nothing to suggest" in prose. */
const META_TEXT_PREFIXES: readonly string[] = ["nothing to suggest", "no suggestion"]

/**
 * The predicate table. Each entry is `[reason, predicate]`; the predicate is
 * pure over the precomputed `(trimmed, lower, words)` triple. Declaration order
 * IS evaluation order. Typed as a tuple of every reason so the table can never
 * silently drop a member.
 */
type Predicate = (trimmed: string, lower: string, words: number) => boolean

const PREDICATES: Readonly<Record<RejectReason, Predicate>> = {
  empty: (trimmed) => trimmed.length === 0,
  done: (_t, lower) => lower === "done",
  meta_text: (_t, lower) =>
    lower === "nothing found" ||
    lower === "nothing found." ||
    META_TEXT_PREFIXES.some((p) => lower.startsWith(p)) ||
    META_SILENCE_RE.test(lower) ||
    META_SILENCE_ONLY_RE.test(lower),
  meta_wrapped: (trimmed) => META_WRAPPED_RE.test(trimmed),
  error_message: (_t, lower) => ERROR_PREFIXES.some((p) => lower.startsWith(p)),
  prefixed_label: (trimmed) => PREFIXED_LABEL_RE.test(trimmed),
  too_few_words: (trimmed, lower, words) => {
    if (words >= SUGGESTION_LIMITS.minWords) return false
    if (trimmed.startsWith("/")) return false // slash commands are legit one-token
    return !SHORT_COMMAND_WHITELIST.has(lower)
  },
  too_many_words: (_t, _l, words) => words > SUGGESTION_LIMITS.maxWords,
  too_long: (trimmed) => trimmed.length >= SUGGESTION_LIMITS.maxChars,
  multiple_sentences: (trimmed) => MULTI_SENTENCE_RE.test(trimmed),
  has_formatting: (trimmed) => HAS_FORMATTING_RE.test(trimmed),
  evaluative: (_t, lower) => EVALUATIVE_RE.test(lower),
  claude_voice: (trimmed) => CLAUDE_VOICE_RE.test(trimmed),
}

/**
 * Evaluate a single candidate. PURE & TOTAL. Trims first (the competitor's `H`
 * is `raw.trim()`); word count is whitespace-split of the trimmed string.
 *
 * @param suggestion the candidate text (already sanitized by `sanitize.ts`,
 *   but the gate is robust to raw input too).
 */
export function rejectGate(suggestion: string): RejectVerdict {
  const trimmed = suggestion.trim()
  const lower = trimmed.toLowerCase()
  // Empty string ⇒ 0 words (split on "" yields `[""]`, so guard explicitly).
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length

  for (const reason of REJECT_REASONS) {
    if (PREDICATES[reason](trimmed, lower, words)) {
      return { accepted: false, reason }
    }
  }
  return { accepted: true }
}

/** Exhaustiveness witness — referencing every member forces a compile error if
 *  a `RejectReason` is added without a predicate. Pure, no runtime cost beyond
 *  the (dead-by-design) switch when called; not invoked on the hot path. */
export function describeReason(reason: RejectReason): string {
  switch (reason) {
    case "empty":
      return "suggestion was empty"
    case "done":
      return "model signalled completion ('done'), not a prompt"
    case "meta_text":
      return "meta commentary (e.g. 'nothing to suggest')"
    case "meta_wrapped":
      return "fully wrapped in (...) or [...]"
    case "error_message":
      return "begins with an API/error sentinel"
    case "prefixed_label":
      return "begins with a 'label:' prefix"
    case "too_few_words":
      return "fewer than the minimum words and not a whitelisted command"
    case "too_many_words":
      return "more than the maximum words"
    case "too_long":
      return "at or above the maximum character length"
    case "multiple_sentences":
      return "contains multiple sentences"
    case "has_formatting":
      return "contains formatting (newline / markdown)"
    case "evaluative":
      return "evaluative praise / acknowledgement, not an action"
    case "claude_voice":
      return "written in the assistant's voice"
    default:
      return assertNever(reason)
  }
}
