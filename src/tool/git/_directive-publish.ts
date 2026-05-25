/**
 * ADR-0220 + ADR-0234 shared dual-surface publisher for git directives.
 *
 * Mutating git tools (`commit`, `branch_switch`, future `gh_pr_create`) may
 * publish a directive on success to TWO orthogonal surfaces:
 *
 *  - ADR-0220 `GitDirectiveEmitter` (legacy direct emit; no phase guard).
 *  - ADR-0234 `GitDirectiveCollector` (phase-aware turn-scoped buffer; the
 *    loop flushes at turn end with `phase: "final-answer"`).
 *
 * Either / both / neither may be wired. The duplication across the two
 * surfaces (typed directive build → try/emit-then-swallow → try/record-then-
 * swallow) is real but trivial; pulling it into ONE helper here:
 *
 *   1. keeps each tool body simple (one call instead of 18 LOC),
 *   2. caps the per-tool cognitive-complexity (biome lint cliff),
 *   3. guarantees the swallow discipline is identical across tools — a
 *      future "should this throw?" reconsideration is one edit instead of N.
 */

import type { GitDirective as Directive0220, GitDirectiveEmitter } from "../../agent/git-directives"
import type { GitDirective as Directive0234, GitDirectiveCollector } from "../../git/directive-emit"

/** Subset of directive kinds whose shape is BYTE-IDENTICAL across the two
 *  surfaces (ADR-0220 and ADR-0234 — `stage`/`push` shapes differ between
 *  the two ADRs, but `commit` / `create-branch` / `create-pr` are the same).
 *  Restricting the helper to this subset lets the two surfaces share one
 *  directive value without a per-kind conversion. The mutating git tools
 *  in this slice (`commit`, `branch_switch`) only ever emit kinds in this
 *  subset, so the constraint is non-restrictive in practice. */
export type SharedGitDirective = Extract<
  Directive0220 & Directive0234,
  { kind: "commit" | "create-branch" | "create-pr" }
>

/** Publish a directive on the two orthogonal surfaces. Either/both/neither
 *  may be `undefined`; absent surface ⇒ no-op. Each surface is wrapped in
 *  try/catch so a sink failure cannot poison the tool result (the mutation
 *  already succeeded). */
export const publishGitDirective = (
  directive: SharedGitDirective,
  surfaces: {
    readonly emitter?: GitDirectiveEmitter
    readonly collector?: GitDirectiveCollector
  },
): void => {
  const { emitter, collector } = surfaces
  if (emitter !== undefined) {
    try {
      emitter.emit(directive)
    } catch {
      // Emit failures NEVER poison the tool result (host channel may be
      // unavailable; mutation already succeeded). Swallow per ADR-0220.
    }
  }
  if (collector !== undefined) {
    try {
      collector.record(directive)
    } catch {
      // `record()` is no-throw per contract; try/catch is defense-in-depth
      // for a misbehaving custom port. Same swallow discipline as above.
    }
  }
}
