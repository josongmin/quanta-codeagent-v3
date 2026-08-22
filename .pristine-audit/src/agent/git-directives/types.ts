/**
 * ADR-0220 — Git directive types.
 *
 * 5-kind discriminated union of git mutation directives emitted on the
 * stderr-side `::git-*` channel after a confirmed successful mutation. UI
 * processes tail the channel and re-sync without re-shelling git.
 *
 * The discriminant `kind` is also the wire-format prefix kebab (i.e.
 * `::git-create-branch`, `::git-stage`, ...) — the serializer derives the
 * prefix directly from `kind` so the type and protocol can never drift.
 */

/** A single git mutation directive. */
export type GitDirective =
  | { readonly kind: "create-branch"; readonly name: string }
  | { readonly kind: "stage"; readonly paths: readonly string[] }
  | { readonly kind: "commit"; readonly sha: string; readonly message: string }
  | { readonly kind: "push"; readonly remote: string; readonly branch: string }
  | { readonly kind: "create-pr"; readonly url: string; readonly isDraft: boolean }

/** Discriminant literal set — useful for runtime validation. */
export const GIT_DIRECTIVE_KINDS = [
  "create-branch",
  "stage",
  "commit",
  "push",
  "create-pr",
] as const

export type GitDirectiveKind = (typeof GIT_DIRECTIVE_KINDS)[number]

/** Typed parse failure (no thrown errors — UI tail loops keep running). */
export type GitDirectiveParseError =
  | { readonly kind: "not-a-directive" }
  | { readonly kind: "malformed-directive"; readonly reason: string }
  | { readonly kind: "unknown-kind"; readonly received: string }
  | { readonly kind: "shape-mismatch"; readonly reason: string }
