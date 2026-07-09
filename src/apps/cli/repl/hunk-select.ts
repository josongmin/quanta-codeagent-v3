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
 * ONE exception (UUX-6-15): {@link parseHunkSelection} emits an observation-only
 * operator notice for tokens it dropped — the caller sits in a frozen file, so
 * the "ignored: …" feedback rides the WS-G bus (no sink ⇒ no-op, still
 * deterministic w.r.t. the returned selection). The pure detailed transform is
 * {@link parseHunkSelectionDetailed}.
 */

import type { ConfirmDecision } from "@/agent"
import { type DiffHunk, splitHunks } from "@/runner/diff-ops"
import type { HunkApplyResult } from "@/runner/hunk-apply"
import { emitOperatorNotice } from "@/shared"
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

/** Result of {@link parseHunkSelectionDetailed}: the accepted ids plus every
 *  input token that contributed NOTHING to the selection (non-numeric,
 *  out-of-range, reversed/empty range) so the caller can tell the operator
 *  instead of silently dropping a fat-fingered pick. */
export interface HunkSelectionParse {
  readonly selected: string[]
  readonly ignored: string[]
}

/**
 * Parse an operator selection string into the accepted hunk ids, in DIFF ORDER
 * (not input order), deduped — AND report the rejected tokens (UUX-6-15).
 * Accepts:
 *   - `all` / `a`            → every id,
 *   - `none` / `n` / `` (empty) → none,
 *   - comma/space lists of 1-based numbers and `N-M` inclusive ranges.
 * Unknown / out-of-range / non-numeric tokens never throw (a fat-fingered
 * token must not crash the approval); each one that yields ZERO valid indices
 * lands in `ignored` (input order, verbatim). A range that still selects at
 * least one hunk after clamping is NOT reported — it contributed. Pure.
 */
export const parseHunkSelectionDetailed = (
  raw: string,
  ids: readonly string[],
): HunkSelectionParse => {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === "" || trimmed === "none" || trimmed === "n") return { selected: [], ignored: [] }
  if (trimmed === "all" || trimmed === "a") return { selected: [...ids], ignored: [] }
  const picked = new Set<number>() // 1-based indices
  const ignored: string[] = []
  for (const token of trimmed.split(/[\s,]+/)) {
    if (token === "") continue
    if (!applySelectionToken(token, ids.length, picked)) ignored.push(token)
  }
  // Project onto valid 1-based positions, preserving diff order.
  return { selected: ids.filter((_id, i) => picked.has(i + 1)), ignored }
}

/** Apply ONE selection token onto the picked-index set. Returns `true` iff
 *  the token contributed at least one valid 1-based index (a no-contribution
 *  token is what the caller reports as ignored). Range handling CLAMPS to
 *  `[1, count]` BEFORE iterating: indices outside the id range are dropped by
 *  the caller's final filter anyway, so a pathological `1-999999999` must
 *  never materialize a billion-entry Set (OOM/hang that would wedge the
 *  blocking approval prompt). A reversed range (lo>hi) adds nothing. */
const applySelectionToken = (token: string, count: number, picked: Set<number>): boolean => {
  const range = token.match(/^(\d+)-(\d+)$/)
  if (range) {
    const lo = Math.max(1, Number(range[1]))
    const hi = Math.min(count, Number(range[2]))
    for (let n = lo; n <= hi; n++) picked.add(n)
    return hi >= lo
  }
  if (!/^\d+$/.test(token)) return false
  const n = Number(token)
  if (n < 1 || n > count) return false
  picked.add(n)
  return true
}

/**
 * Back-compat single-value parse — the seam the (frozen) interactive picker in
 * `runtime-context-compose.ts` calls. Selection semantics are byte-identical to
 * {@link parseHunkSelectionDetailed}; when tokens were dropped it additionally
 * emits ONE info operator notice ("ignored: …") so the operator learns their
 * pick was partially discarded (UUX-6-15 — previously a silent drop). The
 * notice is observation-only: no sink installed ⇒ no-op.
 */
export const parseHunkSelection = (raw: string, ids: readonly string[]): string[] => {
  const { selected, ignored } = parseHunkSelectionDetailed(raw, ids)
  if (ignored.length > 0) {
    emitOperatorNotice({
      severity: "info",
      source: "hunk-select",
      message: `ignored: ${ignored.join(", ")}`,
      hint: `valid picks are 1-${ids.length}, "all", or "none"`,
    })
  }
  return selected
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
