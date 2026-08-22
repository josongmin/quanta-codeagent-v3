/**
 * Eval app — cross-tier shared types.
 *
 * The eval app composes existing slices (RFC §4 apps/eval — composition only,
 * NOT a new slice). Types here are intentionally minimal and local to the app.
 * Every Tier produces `ScenarioResult`s and appends to ONE store
 * (`storage/result-store.ts`) so the `report/` view is a single aggregation.
 */

/** Stable dot-separated id for a use case leaf, e.g.
 *  `software-quality.debugging.error-message-paste`. Built from the
 *  major/mid/leaf slugs in `taxonomy/usecases.ts`; treat as opaque elsewhere. */
export type UseCaseId = string

/** Tier of evidence the result was produced under. Mirrors the 6-tier verification
 *  stack from `docs/analysis/may-21-coding-agent-query-usecase.md` §검증 방법. */
export type EvalTier = "audit" | "synthetic" | "grounding" | "public" | "trajectory" | "compare"

/** A scenario verdict. `pass`/`fail` are deterministic outcomes; `partial`
 *  means the rubric was met for some items only; `error` is harness failure
 *  (NOT scored against the agent); `skipped` means the scenario was not run. */
export type Verdict = "pass" | "partial" | "fail" | "error" | "skipped"

/** Coverage classification used by Tier 0 audit and `report/coverage-matrix`.
 *  Same value space as the document's `OK / PARTIAL / NO / TBD` markers. */
export type CoverageLevel = "ok" | "partial" | "no" | "tbd"
