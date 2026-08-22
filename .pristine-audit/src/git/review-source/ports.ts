/** RFC-02 B1/B3 — injected read ports for review-source resolution.
 *
 *  The pure resolver and generated-file filter never shell out. All git reads
 *  arrive through these narrow, injected ports; the concrete implementations
 *  live in `@/tool/git/review-source-adapter` (which binds the existing
 *  `GitRunner`). This keeps `@/git/review-source` a pure leaf and lets tests
 *  drive resolution/filtering with an in-memory fake. */

/** Revision resolution seam used by the diff-source resolver (B1). */
export interface GitReadPort {
  /** Resolve/peel a revision to a concrete commit oid, or `null` if it does not
   *  resolve to exactly one commit (missing, ambiguous, non-commit). The adapter
   *  implements this with `git rev-parse --verify --quiet <rev>^{commit}`. */
  resolveCommit(rev: string): Promise<string | null>
}

/** Result of a raw `git check-attr -z` invocation (B3). */
export type CheckAttrResult = { ok: true; stdout: string } | { ok: false; message: string }

/** `git check-attr` seam used by the generated-file filter (B3). Kept separate
 *  from {@link GitReadPort} so B1 depends on ref resolution only. */
export interface GeneratedAttributePort {
  /** Run `git check-attr -z <attribute> -- <paths...>` and return raw stdout
   *  (NUL-delimited triplets) or a typed failure. Paths are passed after `--`
   *  so a leading-`-` filename can never be read as a git option. */
  checkAttr(attribute: string, paths: readonly string[]): Promise<CheckAttrResult>
}
