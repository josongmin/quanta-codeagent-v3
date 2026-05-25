/**
 * ADR-0260 — types for the LexicalSearch slice.
 *
 * `LexicalHit` is the unit-of-retrieval emitted by every adapter.
 * `LexicalError` is a 5-arm closed union — new arms MUST also update
 * `ALL_LEXICAL_ERROR_KINDS` so the hellgate's exhaustive-switch test
 * compile-fails until every consumer covers the new arm.
 */

/** Single retrieval hit. `score` is adapter-defined (BM25 score for the
 *  pure adapter; match-count for the ripgrep adapter). Sort order is
 *  always descending by score, then ascending by id (byte-stable). */
export interface LexicalHit {
  readonly id: string
  readonly score: number
  readonly text: string
  readonly metadata?: Readonly<Record<string, string>>
}

/** Reason the ripgrep adapter had to step down from `rg` — surfaced
 *  ONCE on the first `index` result so observability can log the
 *  fallback without re-probing every query. */
export type LexicalDegradeReason = "rg-missing" | "grep-missing"

/** Closed-union failure code. The slice's caller pattern-matches on
 *  `.kind` and never parses error messages. */
export type LexicalError =
  | { readonly kind: "no-search-binary"; readonly detail: string }
  | {
      readonly kind: "spawn-failed"
      readonly binary: "rg" | "grep"
      readonly detail: string
    }
  | {
      readonly kind: "parse-failed"
      readonly binary: "rg" | "grep"
      readonly detail: string
    }
  | {
      readonly kind: "invalid-query"
      readonly raw: string
      readonly reason: "empty" | "too-large"
    }
  | { readonly kind: "aborted"; readonly binary?: "rg" | "grep" }

/** Tuple of every `LexicalError.kind` value — must stay in sync with the
 *  union above. The hellgate cross-references this against the switch in
 *  HELL-LX-15; adding an arm without updating both fails the test. */
export const ALL_LEXICAL_ERROR_KINDS = [
  "no-search-binary",
  "spawn-failed",
  "parse-failed",
  "invalid-query",
  "aborted",
] as const

export type LexicalErrorKind = (typeof ALL_LEXICAL_ERROR_KINDS)[number]
