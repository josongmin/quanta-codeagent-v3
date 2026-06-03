/**
 * AFK away-summary slice — shared types (ADR-0465).
 *
 * What it does: a tiny "you stepped away, here's a recap" generator that
 * the CLI renders when the user returns to an in-progress session. Faithful
 * to Claude Code 2.1.150's away-summary: an isolated single-turn query with
 * ALL tools denied, gated behind an env flag, default OFF.
 *
 * Slices imported: `@/shared` ONLY (Result/ok/err). This slice lives in
 * `@/agent` but does NOT import `@/llm` — the LLM call is injected as a
 * {@link SummarizeFn} callback (port inversion, mirrors
 * `src/permission/classifier.ts`'s `ClassifierPort`). The composition root
 * in `@/apps` wires the real LLM (tools denied, maxTurns 1, skipTranscript +
 * skipCacheWrite) into the callback.
 *
 * NO-THROW contract: every exported function returns a `Result` or a plain
 * value (never throws). Programmer-bug inputs (empty transcript, absent
 * gate) are encoded as a typed `skip`, not an exception.
 */

/** A minimal, LLM-agnostic projection of one conversation turn. The slice
 *  never sees the full `@/llm` `Message` shape — the composition root maps
 *  the live transcript down to this projection so the slice stays decoupled
 *  from the wire format (slice-isolation discipline). */
export interface RecapTurn {
  /** Who authored the turn. Only these two roles matter for the recap
   *  guard; tool-result / system framing is collapsed out by the mapper. */
  readonly role: "user" | "assistant"
  /** Flattened plain-text content of the turn (no markdown, no blocks).
   *  Empty string is allowed — `shouldEmit` treats a transcript of only
   *  empty assistant turns as "no real activity". */
  readonly text: string
}

/** Why a recap was NOT produced. Closed union so the CLI can branch
 *  exhaustively on `kind` and stay silent (never render a half-recap). */
export type AwaySkipReason =
  /** `QUANTA_ENABLE_AWAY_SUMMARY` is not `"1"` — the default-OFF path. */
  | { readonly kind: "gate-off" }
  /** No real activity yet (fresh / empty conversation — fewer than one
   *  prior assistant turn with content). Recapping nothing is noise. */
  | { readonly kind: "no-activity" }
  /** The injected summarizer returned `Err` (LLM unavailable, aborted,
   *  refusal, etc.). The CLI renders nothing rather than a broken recap. */
  | { readonly kind: "summarizer-error"; readonly detail: string }
  /** The run was aborted via the supplied `AbortSignal` before/while the
   *  summarizer was consulted. */
  | { readonly kind: "aborted" }
  /** The summarizer succeeded but returned blank text — nothing to show. */
  | { readonly kind: "empty-recap" }
  /** The summarizer succeeded but the recap blew its word budget (the model
   *  ignored the verbatim "under 40 words" instruction). Rendering an
   *  over-long wall of text defeats the at-a-glance purpose, so the CLI stays
   *  silent rather than show a recap that violates its own contract. Carries
   *  the observed/limit word counts for `--debug`. */
  | { readonly kind: "over-budget"; readonly words: number; readonly limit: number }

/** Outcome of {@link runAwaySummary}. `ok` carries the recap text the CLI
 *  prints; `skip` carries a typed reason the CLI uses to stay silent. */
export type AwaySummaryOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "skip"; readonly reason: AwaySkipReason }

/** Inputs to a single recap attempt. `env` is injected (the slice never
 *  reads `process.env` itself — slice-boundary invariant) so the gate is
 *  hermetically testable. `signal` is optional; when it fires the run
 *  short-circuits to a `{kind:"aborted"}` skip. */
export interface AwaySummaryRequest {
  /** The conversation so far, mapped down to {@link RecapTurn}s by the
   *  composition root. Newest-last (chronological). */
  readonly transcript: readonly RecapTurn[]
  /** The host's already-loaded environment. The gate reads
   *  `QUANTA_ENABLE_AWAY_SUMMARY` from here — never from `process.env`. */
  readonly env: AwaySummaryEnv
  /** Aborts the run (e.g. user starts typing again before the recap lands). */
  readonly signal?: AbortSignal | undefined
}

/** The env projection the gate reads. A plain record so tests pass `{}` for
 *  the OFF path and `{ QUANTA_ENABLE_AWAY_SUMMARY: "1" }` for the ON path. */
export type AwaySummaryEnv = Readonly<Record<string, string | undefined>>
