/**
 * Single source of truth for build/cache-shaped path exclusions across the
 * bench harness.
 *
 * T2 — Patch sanitizer prune-at-source. The bench `runner.ts` previously
 * captured patches with `git diff --cached` and then filtered TEST paths in
 * `sourceOnlyDiff`, but build/cache pollution (`outputs/`, `__pycache__/`,
 * `.claude/worktrees/`, …) was caught only AFTER the fact by the failure
 * classifier's `dirty_cache_leak` signal — and only when the *entire* patch
 * was cache-shaped. A mixed source+cache patch (real django run, 2026-05-21)
 * shipped to the grader and aborted at turns=0.
 *
 * Fix: exclude these paths at the git layer using pathspec `:(exclude,top)…`
 * magic so a leaked `outputs/.../worktree` gitlink never enters the index
 * diff in the first place. `top` makes the pathspec repo-rooted (not
 * cwd-relative) so the exclusion holds regardless of the bench's chdir.
 *
 * Mirror invariant: `CACHE_PATH_RE` is derived from the same list and is
 * imported by `failure-classifier.ts`. After T2 the classifier's
 * `dirty_cache_leak` signal becomes an INVARIANT ALARM — if it ever fires
 * in normal operation the contract was violated upstream.
 *
 * NEVER widen this list with speculative entries. The set below mirrors the
 * classifier's prior local regex exactly (so the SSOT swap is byte-equivalent
 * for the classifier) plus `.claude/worktrees/` — the missing entry that
 * caused the django leak.
 */

/** Canonical noise directory names (no trailing `/`). The git pathspec list
 *  and the classifier regex are both derived from this single array, so the
 *  SSOT invariant cannot drift. Mirrors `failure-classifier.ts`'s prior
 *  local `CACHE_PATH_RE` alternation exactly, plus `.claude/worktrees`. */
const CACHE_DIR_NAMES: readonly string[] = [
  "outputs",
  ".cache",
  "__pycache__",
  "dist",
  "build",
  "node_modules",
  ".tox",
  ".venv",
  "venv",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".claude/worktrees",
]

/**
 * Git pathspec exclude arguments suitable for `git diff -- . :(exclude,top)…`.
 * The `top` magic anchors each pathspec to the repository root so a
 * sub-directory `git diff` invocation excludes the same paths.
 *
 * Usage:
 *   git("diff", "--cached", "--", ".", ...CACHE_PATHSPECS)
 */
export const CACHE_PATHSPECS: readonly string[] = CACHE_DIR_NAMES.map(
  (p) => `:(exclude,top)${p}/`,
)

/** Escape a literal string for inclusion in a RegExp alternation. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Build/cache-shaped path family. Matched on segment boundaries so a real
 * `outputs` package wouldn't be flagged unless it is literally under
 * `outputs/`. Imported by `failure-classifier.ts`'s `isDirtyCacheLeak` —
 * after T2 this should fire 0 times in normal operation (the runner prunes
 * at source); a positive match indicates the prune-at-source contract was
 * violated upstream.
 */
export const CACHE_PATH_RE = new RegExp(
  `(^|/)(${CACHE_DIR_NAMES.map(escapeRe).join("|")})/`,
)
