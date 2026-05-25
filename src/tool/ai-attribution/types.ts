/**
 * ADR-0257 — types for the AI-attribution tool (MVP slice).
 *
 * The tool searches a snippet against an external training-data / public-code
 * corpus and returns ranked attribution matches. This MVP slice ships only the
 * closed-port shape, deterministic headless stub, and tool registration; a real
 * search adapter (BigCode / Sourcegraph / GitHub Code Search) is the follow-up.
 *
 * `SearchError` is a CLOSED 4-arm union (project convention — see
 * `src/shared/errors.ts`) so policy / tool code can branch on `.kind` without
 * parsing error messages. Adding a 5th variant requires updating every
 * exhaustive `switch` site (test harness + tool result mapping) — the test
 * battery seals the closed shape.
 *
 * `License` is a CLOSED 5-arm union (`MIT` / `Apache-2.0` / `GPL-3.0` /
 * `proprietary` / `unknown`). Adapters that detect a richer SPDX set MUST map
 * to one of these arms (the obvious mapping is `proprietary` for any commercial
 * license without an OSS classifier and `unknown` for missing / unparseable
 * metadata) — keeping the surface narrow lets the dispatch layer reason about
 * license risk without parsing arbitrary SPDX strings.
 */

/** CLOSED 5-arm license union surfaced on every `AttributionMatch`. */
export type License = "MIT" | "Apache-2.0" | "GPL-3.0" | "proprietary" | "unknown"

/** A single attribution candidate returned by a search adapter. `similarity` is
 *  in `[0, 1]` inclusive (the port validator clamps + rejects out-of-range
 *  values from a misbehaving adapter). `url` is OPTIONAL — some sources only
 *  expose a name/sha pair without a fetchable URL. */
export interface AttributionMatch {
  /** Free-form source identifier (e.g. `"github.com/foo/bar@<sha>"`). */
  readonly source: string
  readonly license: License
  /** Similarity score, `0` ≤ similarity ≤ `1`. Higher is more similar. */
  readonly similarity: number
  /** Optional URL for navigation (`https://…` when the source has one). */
  readonly url?: string
}

/** Caller-supplied filters / caps for one search call. Both fields are optional;
 *  the tool layer applies sensible defaults (no minimum similarity, no max cap)
 *  when omitted. */
export interface SearchOpts {
  /** Drop matches with `similarity < minSimilarity`. Range `[0, 1]`. */
  readonly minSimilarity?: number
  /** Truncate to the top `maxResults` AFTER sorting by similarity desc. */
  readonly maxResults?: number
}

/** CLOSED 4-arm failure code surfaced from `AIAttributionSearch.search`.
 *
 *   - `empty-snippet`     — snippet is empty after the trim performed by the
 *                           tool layer.
 *   - `snippet-too-large` — snippet exceeded the 10 KB byte cap.
 *   - `search-failed`     — adapter / network / parse failure. `cause` carries
 *                           the underlying error message for diagnostics.
 *   - `aborted`           — caller's `AbortSignal` fired before / during the
 *                           call.
 */
export type SearchError =
  | { kind: "empty-snippet" }
  | { kind: "snippet-too-large"; sizeBytes: number; maxBytes: number }
  | { kind: "search-failed"; cause: string }
  | { kind: "aborted" }

/** Byte cap enforced by both the tool input validator and the port wrapper. */
export const SNIPPET_MAX_BYTES = 10_000

/** Anchor tuple — every `License` literal MUST appear here. A compile-error
 *  satisfies-check below pins the set. */
export const LICENSES = [
  "MIT",
  "Apache-2.0",
  "GPL-3.0",
  "proprietary",
  "unknown",
] as const satisfies ReadonlyArray<License>

/** Anchor tuple — every `SearchError["kind"]` literal MUST appear here. */
export const SEARCH_ERROR_KINDS = [
  "empty-snippet",
  "snippet-too-large",
  "search-failed",
  "aborted",
] as const satisfies ReadonlyArray<SearchError["kind"]>

// In-slice structural checks: every literal in the closed union must appear in
// the anchor tuple. The reverse direction is enforced by the `satisfies` above.
type _LicensesAnchorCoversUnion = License extends (typeof LICENSES)[number]
  ? true
  : { error: "LICENSES is missing a union member" }
type _SearchErrorAnchorCoversUnion = SearchError["kind"] extends (typeof SEARCH_ERROR_KINDS)[number]
  ? true
  : { error: "SEARCH_ERROR_KINDS is missing a union member" }
const _licensesAnchorCheck: _LicensesAnchorCoversUnion = true
const _searchErrorAnchorCheck: _SearchErrorAnchorCoversUnion = true
void _licensesAnchorCheck
void _searchErrorAnchorCheck
