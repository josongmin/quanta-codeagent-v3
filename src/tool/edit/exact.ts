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

/** Exact-string replacement. Phase 1 only — fuzzy matching is Phase 2.
 *  Requires a unique match unless `replaceAll`. */
export const applyExactEdit = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditOutcome => {
  if (oldString === newString) {
    return { ok: false, message: "old_string and new_string are identical" }
  }
  if (oldString === "") {
    return { ok: false, message: "old_string must not be empty" }
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
