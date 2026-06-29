/**
 * jun-29 OBSERVE-ONLY candidate-pool ledger (pure core).
 *
 * The repair-loop BREADTH path generates B candidates per round and ADOPTS only
 * the selected winner ({@link ./index.ts} `runRound`); the other B-1 candidates'
 * patches/touchedFiles are dropped. That makes the "was there a winning candidate
 * in the pool that the selector missed?" question UN-answerable post-hoc.
 *
 * This module builds a flat, serializable row PER candidate so the driver can
 * persist the WHOLE pool to the observe dir BEFORE selection. It is observe-only:
 * decision impact ZERO (the rows are never read by selection/adopt), so the
 * default-OFF / absent-sink path stays byte-identical.
 *
 * PURE: no fs, no @/agent, no sandbox — just diff-string parsing + field copy, so
 * it is a leaf unit (fast typecheck/test, no full build).
 */

import type { RepairCandidateOutcome } from "./types"

export interface CandidatePoolRow {
  /** 0-based repair round (0 = initial attempt, ≥1 = repair rounds). */
  readonly round: number
  /** 0-based candidate index WITHIN the round's fan-out (generation order). */
  readonly candidateIndex: number
  /** Byte length of this candidate's cumulative diff (0 = empty/no-edit). */
  readonly patchBytes: number
  /** Files the candidate's diff touches (parsed from `diff --git` headers). */
  readonly touchedFiles: readonly string[]
  /** The injected validator's pass verdict for this candidate's fork. */
  readonly validatorOk: boolean
  /** The validator's repro/consensus outcome label when present (resolved /
   *  reproduced / inconclusive / …) — the selection-authority signal. */
  readonly reproOutcome?: string
}

/**
 * Parse the set of repo-relative paths a unified git diff touches, from its
 * `diff --git a/<path> b/<path>` headers (the `b/` side — the post-image path,
 * which is the edited file even on a pure deletion's rename pair). Deduped,
 * insertion-order preserved. Robust to an empty patch (⇒ []).
 */
export const touchedFilesFromDiff = (patch: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of patch.split("\n")) {
    // `diff --git a/foo/bar.py b/foo/bar.py` — take the b/ post-image path.
    const m = /^diff --git a\/(?:[^ ]+) b\/(.+)$/.exec(line)
    if (m === null) continue
    const path = m[1]
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** The validator's repro/consensus label, preferring an explicit consensus
 *  verdict over a raw per-sample outcome (mirrors decision.ts's read order). */
const reproOutcomeOf = (v: RepairCandidateOutcome["validator"]): string | undefined => {
  const consensus = (v as { consensus?: unknown }).consensus
  if (typeof consensus === "string") return consensus
  const reproOutcome = (v as { reproOutcome?: unknown }).reproOutcome
  if (typeof reproOutcome === "string") return reproOutcome
  return undefined
}

/**
 * Build one observe row per candidate, in generation order. The patch itself is
 * NOT inlined (the driver writes each candidate's `.patch` beside the JSONL); the
 * row carries `patchBytes` + parsed `touchedFiles` so the pool can be analyzed
 * (file coverage / winner-present) without re-reading every diff.
 */
export const buildCandidatePoolRows = (
  round: number,
  candidates: readonly RepairCandidateOutcome[],
): CandidatePoolRow[] =>
  candidates.map((c, candidateIndex) => {
    const patch = c.run.patch
    const reproOutcome = reproOutcomeOf(c.validator)
    return {
      round,
      candidateIndex,
      patchBytes: patch.length,
      touchedFiles: touchedFilesFromDiff(patch),
      validatorOk: c.validator.ok === true,
      ...(reproOutcome !== undefined ? { reproOutcome } : {}),
    }
  })
