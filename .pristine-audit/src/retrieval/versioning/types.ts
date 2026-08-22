/**
 * @/retrieval/versioning public types — ADR-0266.
 *
 * Three primitives:
 *   - `ModelTag`              — canonicalised identity of an embedder run
 *   - `InvalidationDecision`  — the result of comparing two tags
 *   - `ParseError`            — closed 4-arm union from the canonical codec
 *
 * Slice is a leaf — depends on nothing in `@/retrieval` proper. The
 * versioning port lives next to the embedders so a single import path
 * carries the type contract; the rules themselves are pure functions.
 */

/**
 * Canonical identity of an embedding model invocation.
 *
 * `canonical` is the round-trippable string form
 * `{provider}-{model}-v{version}-d{dim}` (see `tag-codec.ts`). It is
 * present on every `ModelTag` so callers can persist or log a single
 * field without re-serialising.
 */
export interface ModelTag {
  readonly provider: string
  readonly model: string
  readonly version: string
  readonly dim: number
  readonly canonical: string
}

/**
 * Outcome of `Invalidator.check(stored, current)`.
 *
 * `reason` is OPTIONAL on the type (no `exactOptionalPropertyTypes`
 * narrowing) so `{ stale: false }` is a valid literal — callers don't
 * need to spell `reason: undefined` in the fresh case.
 */
export interface InvalidationDecision {
  readonly stale: boolean
  readonly reason?: string
}

/**
 * Closed 4-arm union for `tag-codec.parse` failures. Exhaustive switch
 * coverage is enforced by HELL-MT-15.
 */
export type ParseError =
  | { kind: "malformed"; raw: string }
  | { kind: "missing-dim"; raw: string }
  | { kind: "missing-version"; raw: string }
  | { kind: "empty-field"; raw: string; field: "provider" | "model" }
