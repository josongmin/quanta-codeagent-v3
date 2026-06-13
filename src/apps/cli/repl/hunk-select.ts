/**
 * `apps/cli/repl/hunk-select` — CLI per-hunk accept/reject helpers (T05).
 *
 * The interactive `[h]` verb in {@link buildCliOnConfirm} delegates here:
 *   - {@link renderHunkChoices}  numbers the diff's atomic hunks for display,
 *   - {@link parseHunkSelection} turns the operator's answer ("1,3", "all",
 *     "2-4", "none") into the accepted hunk-id list,
 *   - {@link shapePartialDecision} maps the partial-apply executor result onto a
 *     {@link ConfirmDecision} (a `deny_and_steer`: the original whole-call tool
 *     is DENIED so it cannot over-apply, while the accepted subset was already
 *     written to disk by the executor — the steer tells the model exactly what
 *     landed so its view of the file stays correct).
 *
 * PURE (no I/O): these are deterministic transforms, unit-tested in isolation.
 * The disk write lives in `@/runner/hunk-apply` (atomic + mode-preserving +
 * staleness-guarded); this module only renders, parses, and shapes the decision.
 */

import type { ConfirmDecision } from "@/agent"
import { type DiffHunk, splitHunks } from "@/runner/diff-ops"
import type { HunkApplyResult } from "@/runner/hunk-apply"
import { green, red } from "@/ui/ui-helpers"

/** Render the diff's atomic hunks as a numbered menu the operator picks from.
 *  Each hunk shows `[N]` + its `@@`-style anchor and the changed lines (`- old`
 *  / `+ new`), colour-matched to the main preview. Pure string builder. */
export const renderHunkChoices = (before: string, after: string): string => {
  const hunks = splitHunks(before, after)
  const lines: string[] = []
  for (const h of hunks) {
    lines.push(hunkHeader(h))
    for (const op of h.ops) {
      if (op.kind === "del") lines.push(red(`    - ${op.line}`))
      else lines.push(green(`    + ${op.line}`))
    }
  }
  return lines.join("\n")
}

const hunkHeader = (h: DiffHunk): string =>
  `[${h.index + 1}] @@ -${h.oldStart} +${h.newStart} @@ (-${h.delCount}/+${h.addCount})`

/**
 * Parse an operator selection string into the accepted hunk ids, in DIFF ORDER
 * (not input order), deduped. Accepts:
 *   - `all` / `a`            → every id,
 *   - `none` / `n` / `` (empty) → none,
 *   - comma/space lists of 1-based numbers and `N-M` inclusive ranges.
 * Unknown / out-of-range / non-numeric tokens are silently dropped — never
 * throws (a fat-fingered token must not crash the approval).
 */
export const parseHunkSelection = (raw: string, ids: readonly string[]): string[] => {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === "" || trimmed === "none" || trimmed === "n") return []
  if (trimmed === "all" || trimmed === "a") return [...ids]
  const picked = new Set<number>() // 1-based indices
  for (const token of trimmed.split(/[\s,]+/)) {
    if (token === "") continue
    const range = token.match(/^(\d+)-(\d+)$/)
    if (range) {
      // CLAMP to the valid 1-based id range BEFORE iterating. Indices outside
      // [1, ids.length] are dropped by the final filter anyway, so a pathological
      // `1-999999999` must never materialize a billion-entry Set (OOM/hang that
      // would wedge the blocking approval prompt). A reversed range (lo>hi) adds
      // nothing (the loop body never runs).
      const lo = Math.max(1, Number(range[1]))
      const hi = Math.min(ids.length, Number(range[2]))
      for (let n = lo; n <= hi; n++) picked.add(n)
      continue
    }
    if (/^\d+$/.test(token)) picked.add(Number(token))
  }
  // Project onto valid 1-based positions, preserving diff order.
  return ids.filter((_id, i) => picked.has(i + 1))
}

/**
 * Map a partial-apply {@link HunkApplyResult} onto the {@link ConfirmDecision}
 * the gate consumes. ALWAYS a `deny_and_steer`: the original whole-call tool is
 * refused (it must not run and over-write the rejected hunks), and the steer
 * reports ground truth so the model's file model stays accurate:
 *   - `applied` → names the accepted + rejected hunks ("the file now reflects
 *     only the accepted changes"),
 *   - `stale`   → tells the model NOTHING was applied (file changed since the
 *     preview) so it re-reads instead of assuming a partial landed,
 *   - `error`   → surfaces the write failure (no false success).
 */
export const shapePartialDecision = (
  result: HunkApplyResult,
  selected: readonly string[],
  allIds: readonly string[],
  path: string,
): ConfirmDecision => {
  if (result.status === "applied") {
    const accepted = result.appliedHunkIds
    const rejected = allIds.filter((id) => !accepted.includes(id))
    return {
      decision: "deny_and_steer",
      steer:
        `Operator accepted only a SUBSET of your proposed changes to ${path} and I applied ` +
        `exactly those hunks (accepted: ${fmt(accepted)}; rejected: ${fmt(rejected)}). ` +
        `Your original tool call was NOT run as-is. ${path} now reflects ONLY the accepted ` +
        `hunks — re-read it if you need the exact current contents before continuing.`,
    }
  }
  if (result.status === "stale") {
    return {
      decision: "deny_and_steer",
      steer:
        `No hunks were applied to ${path}: it changed since the diff was previewed ` +
        `(staleness guard), so the selection (${fmt(selected)}) was discarded with zero writes. ` +
        `Re-read ${path} and propose the edit again against its current contents.`,
    }
  }
  return {
    decision: "deny_and_steer",
    steer:
      `The partial apply to ${path} failed (${result.reason}); no changes were written. ` +
      `Re-read ${path} and try again.`,
  }
}

const fmt = (ids: readonly string[]): string => (ids.length > 0 ? ids.join(", ") : "none")
