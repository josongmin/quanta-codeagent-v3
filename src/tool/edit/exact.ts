import { inRangeMatchOffsets, type LineRange } from "./line-range"
import type { EditMismatchKind } from "./strategy-hint"

export interface EditOutcome {
  ok: boolean
  message: string
  next?: string
  /** Stable failure-class tag (CR2 follow-up). Present on every `ok: false`
   *  outcome whose failure class the strategy-hint formatter understands;
   *  absent on success and on input-validation failures (identical / empty
   *  old_string) that don't carry a routing implication. */
  kind?: EditMismatchKind
}

/** Splice `newString` into `source` at byte offset `i`, replacing `len` bytes.
 *  Literal splice (NOT `String.replace`) so `$&`/`$1`/`` $` ``/`$'`/`$$` in
 *  `newString` are inserted verbatim, never interpreted as replacement
 *  specials. */
const spliceAt = (source: string, i: number, len: number, newString: string): string =>
  source.slice(0, i) + newString + source.slice(i + len)

/** H12 — exact replacement SCOPED to one or more 1-indexed line ranges. Only
 *  occurrences whose first character lands inside a range are considered, so a
 *  repeated anchor becomes addressable ("the one on lines 40-60") instead of
 *  failing `ambiguous`. Bias preserved: a non-unique in-range match without
 *  `replaceAll` still fails `ambiguous` (a wrong edit is worse than no edit). */
const applyExactEditInRange = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  ranges: readonly LineRange[],
): EditOutcome => {
  const offsets = inRangeMatchOffsets(source, oldString, ranges)
  if (offsets.length === 0) {
    const total = source.split(oldString).length - 1
    // Distinguish "nowhere in the file" from "present but outside your range"
    // so the model knows whether to widen the range vs fix old_string.
    const message =
      total > 0
        ? `old_string occurs ${total}x in the file but NONE within the given line_ranges; widen the range or remove it`
        : "old_string not found in file"
    return { ok: false, message, kind: "not-found" }
  }
  if (offsets.length > 1 && !replaceAll) {
    return {
      ok: false,
      message: `old_string is not unique within line_ranges (${offsets.length} matches); narrow the range or pass replace_all`,
      kind: "ambiguous",
    }
  }
  if (replaceAll) {
    // Splice from the BOTTOM so earlier offsets stay valid as the string grows
    // or shrinks under each replacement.
    let next = source
    for (const i of [...offsets].sort((a, b) => b - a)) {
      next = spliceAt(next, i, oldString.length, newString)
    }
    return {
      ok: true,
      message: `Replaced ${offsets.length} occurrence(s) within line_ranges`,
      next,
    }
  }
  const i = offsets[0] as number
  return {
    ok: true,
    message: "Replaced 1 occurrence(s) within line_ranges",
    next: spliceAt(source, i, oldString.length, newString),
  }
}

/** Exact-string replacement. Requires a unique match unless `replaceAll`.
 *  When `lineRanges` is supplied (H12) the search is constrained to those
 *  1-indexed inclusive line spans; absent / empty ⇒ whole-file search,
 *  byte-identical to the pre-H12 path. */
export const applyExactEdit = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  lineRanges?: readonly LineRange[],
): EditOutcome => {
  if (oldString === newString) {
    return { ok: false, message: "old_string and new_string are identical" }
  }
  if (oldString === "") {
    return { ok: false, message: "old_string must not be empty" }
  }
  if (lineRanges !== undefined && lineRanges.length > 0) {
    return applyExactEditInRange(source, oldString, newString, replaceAll, lineRanges)
  }

  const count = source.split(oldString).length - 1
  if (count === 0) {
    return { ok: false, message: "old_string not found in file", kind: "not-found" }
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      message: `old_string is not unique (${count} matches); pass replace_all or add context`,
      kind: "ambiguous",
    }
  }

  // Non-replaceAll: `count === 1` is guaranteed here, so splice the single
  // match literally. `String.prototype.replace` with a string pattern would
  // interpret `$&`, `$1`, `` $` ``, `$'`, `$$` in `newString` as replacement
  // specials — silently corrupting inserted code that contains those bytes.
  let next: string
  if (replaceAll) {
    next = source.split(oldString).join(newString)
  } else {
    const i = source.indexOf(oldString)
    next = source.slice(0, i) + newString + source.slice(i + oldString.length)
  }
  return { ok: true, message: `Replaced ${replaceAll ? count : 1} occurrence(s)`, next }
}
