/**
 * Slice a source-text window between two literal anchors, THROWING when either
 * anchor is missing.
 *
 * ## Why this exists
 *
 * `src.slice(src.indexOf(a), src.indexOf(b))` has no failure mode. A missing END
 * anchor yields `-1`, and `String.prototype.slice` reads a negative end as an
 * offset from the end of the string — so the window silently widens to almost the
 * whole file instead of erroring. Every assertion over that window then passes for
 * the wrong reason.
 *
 * Measured, not reasoned. `b3456-feature-seams-hellgate` pinned that the `gh_pr_view`
 * manifest row documents its secondary ci-bot gate, using
 * `slice(indexOf('"gh_pr_view"'), indexOf("lsp_diagnostics"))`. The
 * `lsp_diagnostics` ROW had been deleted and the token survived only in a two-line
 * obituary comment, so the anchor resolved by accident. Deleting that comment —
 * routine tidying, nothing else touched — moved the window from 818 bytes to 50,903,
 * and then stripping the exact documentation the guard exists to pin left it at
 * 11 pass / 0 fail. A false PASS, reachable by deleting a comment.
 *
 * Two other sites were shown to have constructible false passes the same way, and
 * one had a false RED as well: adding a benign line moved a generic `"})"` end
 * anchor in front of the key being asserted.
 *
 * The asymmetry matters: a missing START anchor gives an EMPTY window, which fails
 * loudly. Only the end is dangerous. That is why the shape survives review.
 *
 * ## Contract
 *
 * - both anchors must be present, or this throws naming the one that is missing;
 * - the end anchor is searched from AFTER the start, so an occurrence before the
 *   start cannot silently produce an empty window;
 * - the returned window excludes the end anchor and includes the start anchor,
 *   matching the `slice(indexOf, indexOf)` shape it replaces.
 */
export interface SliceBetweenOptions {
  /** Named in the error, so a failure says WHICH file lost its anchor. */
  readonly label?: string
}

/**
 * `start` may be a literal anchor or an already-resolved offset, covering all three
 * shapes the raw idiom takes: `slice(indexOf(a), indexOf(b))`,
 * `slice(0, indexOf(b))` and `slice(someOffset, indexOf(b, someOffset))`.
 */
export const sliceBetween = (
  src: string,
  start: string | number,
  endAnchor: string,
  opts: SliceBetweenOptions = {},
): string => {
  const where = opts.label === undefined ? "" : ` in ${opts.label}`
  let from: number
  if (typeof start === "number") {
    if (start < 0 || start > src.length) {
      throw new Error(`sliceBetween: start offset ${start} is outside the source${where}`)
    }
    from = start
  } else {
    from = src.indexOf(start)
    if (from === -1) {
      throw new Error(
        `sliceBetween: start anchor ${JSON.stringify(start)} not found${where} — ` +
          `re-anchor this guard rather than letting it assert over the wrong window`,
      )
    }
    from += 0
  }
  const searchFrom = typeof start === "string" ? from + start.length : from
  const end = src.indexOf(endAnchor, searchFrom)
  if (end === -1) {
    throw new Error(
      `sliceBetween: end anchor ${JSON.stringify(endAnchor)} not found after offset ` +
        `${searchFrom}${where} — a raw slice would have read -1 as an offset from the end ` +
        `of the string, widened the window to the rest of the file, and passed for the ` +
        `wrong reason`,
    )
  }
  return src.slice(from, end)
}
