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

import { runtimeConfig } from "@/shared"

/** Audited default noise directory names (no trailing `/`). Both the git
 *  pathspec list and the classifier regex are derived from this single array
 *  PLUS `runtimeConfig().cachePathspecsExtra` (operator MERGE seam), so the
 *  SSOT invariant cannot drift. Mirrors `failure-classifier.ts`'s prior
 *  local `CACHE_PATH_RE` alternation exactly, plus `.claude/worktrees`. */
export const DEFAULT_CACHE_DIR_NAMES: readonly string[] = [
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

/** Effective directory-name list = defaults ∪ env extras, deduped, order
 *  preserved (defaults first, extras after). Recomputed per call so a test
 *  flipping the env between cases sees the change after `__resetRuntimeConfig`. */
const effectiveDirNames = (): readonly string[] => {
  const extras = runtimeConfig().cachePathspecsExtra
  if (extras.length === 0) return DEFAULT_CACHE_DIR_NAMES
  const seen = new Set<string>(DEFAULT_CACHE_DIR_NAMES)
  const out = [...DEFAULT_CACHE_DIR_NAMES]
  for (const e of extras) {
    const norm = e.replace(/\/+$/, "")
    if (norm.length > 0 && !seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

/**
 * Git pathspec exclude arguments suitable for `git diff -- . :(exclude,top)…`.
 * The `top` magic anchors each pathspec to the repository root so a
 * sub-directory `git diff` invocation excludes the same paths. Includes any
 * operator-supplied extras from `QUANTA_BENCH_CACHE_PATHSPECS_EXTRA`.
 *
 * Usage:
 *   git("diff", "--cached", "--", ".", ...getCachePathspecs())
 */
export const getCachePathspecs = (): readonly string[] =>
  effectiveDirNames().map((p) => `:(exclude,top)${p}/`)

/** Back-compat re-export for callers that capture the spread at module init.
 *  The function form `getCachePathspecs()` is preferred when an env override
 *  needs to be respected mid-process (tests; otherwise immaterial). */
export const CACHE_PATHSPECS: readonly string[] = getCachePathspecs()

/** Escape a literal string for inclusion in a RegExp alternation. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Build/cache-shaped path family. Matched on segment boundaries so a real
 * `outputs` package wouldn't be flagged unless it is literally under
 * `outputs/`. Imported by `failure-classifier.ts`'s `isDirtyCacheLeak` —
 * after T2 this should fire 0 times in normal operation (the runner prunes
 * at source); a positive match indicates the prune-at-source contract was
 * violated upstream. Recomputed per call for the same env-test reason as
 * `getCachePathspecs()`.
 */
export const getCachePathRe = (): RegExp =>
  new RegExp(`(^|/)(${effectiveDirNames().map(escapeRe).join("|")})/`)

/** Back-compat: regex frozen at module load. New code should call
 *  `getCachePathRe()` for env-override sensitivity. */
export const CACHE_PATH_RE: RegExp = getCachePathRe()
