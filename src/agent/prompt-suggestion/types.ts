/**
 * Prompt-suggestion slice — shared types (ADR-0467).
 *
 * WHAT: Closed types for the prompt-suggestion + quality reject-gate feature.
 *   Suggests what the user might naturally type next; the crown jewel is the
 *   REJECT GATE that filters bad model output before it is ever shown.
 *
 * SLICE: lives in `@/agent`. This `types.ts` imports ONLY `@/shared` — it is
 *   pure data + the injected-port type. No `@/llm` / `@/tool` / `@/permission`
 *   imports (the model call is port-inverted via {@link SuggestFn}).
 *
 * NO-THROW CONTRACT: this file declares types only. The behaviour modules
 *   (`reject-gate.ts`, `sanitize.ts`, `suppression.ts`, `index.ts`) return
 *   `Result<…>` and never throw past their boundary.
 *
 * EVIDENCE: Claude CLI 2.1.150 reject gate (`GZ8` predicate chain, extracted
 *   verbatim from `.extracted_source/claude-code-cli/_cli-symbols.txt`). Each
 *   `RejectReason` member is one named predicate in that chain.
 */

/**
 * CLOSED enum of every reason the reject gate can refuse a suggestion. This is
 * the reusable crown jewel — each member maps to exactly ONE pure predicate in
 * {@link `./reject-gate`}. Exhaustively switch on it with `assertNever`.
 *
 * Order matters: the gate evaluates predicates in THIS declaration order and
 * returns the FIRST match (mirrors the competitor's short-circuit array), so a
 * suggestion that trips several reasons reports the earliest one.
 */
export type RejectReason =
  | "empty" //              suggestion is empty after trim
  | "done" //               literal "done" (model signalled completion, not a prompt)
  | "meta_text" //          "nothing found" / "no suggestion" / "silence is…" etc.
  | "meta_wrapped" //       fully wrapped in (...) or [...]
  | "error_message" //      starts with an API/error sentinel ("api error:", …)
  | "prefixed_label" //     starts with a `word:\s` label prefix
  | "too_few_words" //      <2 words and not in the short-command whitelist
  | "too_many_words" //     >12 words
  | "too_long" //           length >= 100 chars
  | "multiple_sentences" // contains a sentence boundary `[.!?]\s+[A-Z]`
  | "has_formatting" //     contains a newline, `*`, or `**`
  | "evaluative" //         praise / acknowledgement ("looks good", "perfect", …)
  | "claude_voice" //       assistant voice ("let me", "i'll", "here's", …)

/** The full closed list, in evaluation order — exported so tests and any
 *  observer can assert completeness against the union above. */
export const REJECT_REASONS: readonly RejectReason[] = [
  "empty",
  "done",
  "meta_text",
  "meta_wrapped",
  "error_message",
  "prefixed_label",
  "too_few_words",
  "too_many_words",
  "too_long",
  "multiple_sentences",
  "has_formatting",
  "evaluative",
  "claude_voice",
] as const

/** Verdict of the pure reject gate over a single (already-sanitized) string. */
export type RejectVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: RejectReason }

/**
 * Short-command whitelist (verbatim from the competitor `too_few_words`
 * predicate). A one-word suggestion is normally rejected, EXCEPT these — they
 * are legitimate single-token next-actions a user really would type. Compared
 * case-insensitively against the lowercased trimmed suggestion.
 */
export const SHORT_COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  "yes",
  "yeah",
  "yep",
  "yea",
  "yup",
  "sure",
  "ok",
  "okay",
  "push",
  "commit",
  "deploy",
  "stop",
  "continue",
  "check",
  "exit",
  "quit",
  "no",
])

/** Documented constants for the word/length thresholds. Values are NOT
 *  arbitrary — they are the competitor's exact GZ8 gate numbers, pinned here
 *  with provenance so no caller invents a different threshold. */
export const SUGGESTION_LIMITS = {
  /** `too_few_words`: fewer than this many whitespace-tokens (and not a
   *  whitelisted short command, and not a slash command) is rejected. */
  minWords: 2,
  /** `too_many_words`: more than this many tokens is rejected. */
  maxWords: 12,
  /** `too_long`: length at-or-above this many chars is rejected. */
  maxChars: 100,
} as const

/**
 * Typed, read-only view of the surface state the SUPPRESSION-CONTEXT guard
 * inspects. The orchestrator NEVER shows a suggestion while any of these hold —
 * regardless of what the model produced. Structurally mirrored from the
 * surface so this slice never imports `@/permission` / `@/mcp`.
 */
export interface AppStateView {
  /** Plan mode active — the user is reviewing a plan, not free-typing. */
  readonly planMode: boolean
  /** The session is currently rate-limited (a model call would fail/queue). */
  readonly rateLimited: boolean
  /** An MCP elicitation prompt is open and awaiting the user. */
  readonly elicitationActive: boolean
  /** A permission request is pending the user's allow/deny decision. */
  readonly pendingPermission: boolean
}

/** Why the suppression guard blocked — closed union, exhaustive. */
export type SuppressReason =
  | "plan_mode"
  | "rate_limited"
  | "elicitation_active"
  | "pending_permission"
  | "rejected" //  the model output existed but failed the reject gate
  | "gate_off" //  QUANTA_ENABLE_PROMPT_SUGGESTION not set
  | "no_output" // the SuggestFn returned no candidate

/**
 * INJECTED model-call port (port inversion). The orchestrator does NOT import
 * `@/llm`. The real impl — a dedicated "SUGGESTION MODE" single-shot call with
 * ALL tools denied — is wired at the composition root in `@/apps` and passed
 * in. Returns the RAW model text (pre-sanitize, pre-gate) or `undefined` when
 * the model declined / errored. MUST NOT throw — encode failure as `undefined`.
 */
export type SuggestFn = (signal?: AbortSignal) => Promise<string | undefined>

/** Final outcome the orchestrator returns inside a `Result`. */
export type SuggestionOutcome =
  | { readonly kind: "show"; readonly text: string }
  | { readonly kind: "suppress"; readonly reason: SuppressReason }
