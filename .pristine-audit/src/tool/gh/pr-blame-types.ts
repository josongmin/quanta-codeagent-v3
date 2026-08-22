/**
 * ADR-0103 — `gh_pr_blame` typed shapes.
 *
 * Mirrors the subset of `gh pr view --json reviewThreads` JSON that the
 * blame parser depends on. Split into its own module so the tool factory,
 * the pure parser, and the hellgate test files all import the SAME shape
 * (one source of truth — no drift between tool, parser, and tests).
 *
 * Why pull this out of `index.ts`:
 *  - Closed module boundary: the parser/renderer module can be unit-tested
 *    against canned `RawPrViewJson` records without spinning up a runner.
 *  - Type-level firewall: a future schema change to `gh pr view` shows up
 *    as a TypeScript error at the parser site, not deep inside a tool
 *    factory closure.
 *  - `index.ts` (the gh-slice barrel) stays a thin re-export over the
 *    9 tool factories rather than holding 130 lines of blame internals.
 */

export interface ReviewThreadComment {
  readonly author?: { readonly login?: string }
  readonly body?: string
}

export interface ReviewThread {
  readonly path?: string
  readonly line?: number | null
  readonly originalLine?: number | null
  readonly isResolved?: boolean
  readonly isOutdated?: boolean
  readonly comments?: { readonly nodes?: readonly ReviewThreadComment[] }
}

export interface RawPrViewJson {
  readonly url?: string
  readonly headRefName?: string
  readonly baseRefName?: string
  readonly reviewThreads?: { readonly nodes?: readonly ReviewThread[] } | readonly ReviewThread[]
}

/** ADR-0103 fixed: comments within ±N lines of the requested anchor count
 *  as relevant. Kept conservative (5) so the tool returns a focused window;
 *  too wide and the result drowns the user in unrelated review noise. */
export const PR_BLAME_PROXIMITY_LINES = 5
