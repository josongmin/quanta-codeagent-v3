// Pure unified diff -> V4A converter + detector.
//
// Unified diff (POSIX) uses "--- a/file" / "+++ b/file" / "@@ -x,y +x,y @@"
// headers that the V4A parser rejects. This module converts a well-formed
// unified diff to the V4A format that parsePatch understands, without touching
// the per-line +/-/space prefix (both formats share that prefix alphabet).
//
// Design: pure (no I/O), no-throw (caller gets best-effort V4A on malformed
// input), deterministic (same input => byte-identical output).

import { PATCH_SENTINELS } from "./types"

/** True iff text looks like a unified diff rather than a V4A patch.
 *  Heuristic: first non-blank line starts with "--- " or "diff --git ".
 *  False-positives are harmless — the converter output still parse-or-throw. */
export const isUnifiedDiff = (text: string): boolean => {
  for (const line of text.split("\n")) {
    const t = line.trimEnd()
    if (t === "") continue
    return t.startsWith("--- ") || t.startsWith("---\t") || t.startsWith("diff --git ")
  }
  return false
}

/** Strip the "a/" or "b/" git prefix from a unified diff path. */
const stripGitPrefix = (p: string): string =>
  p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p

/** True iff line begins a new file section in a unified diff.
 *  NOTE: this is ONLY safe for the outer loop context where we know we are
 *  looking at potential file headers, NOT inside hunk bodies. For the inner
 *  while loops, use isTrueFileBoundary which requires lookahead. */
const _isFileBoundary = (line: string): boolean =>
  line.startsWith("--- ") || line.startsWith("diff --git ")

/**
 * Lookahead-aware file boundary check for use inside hunk body while loops.
 *
 * A line that starts with '--- ' is ONLY a true file boundary if the
 * immediately following line starts with '+++ '. Without this lookahead,
 * any content line whose text starts with '-- ' (SQL/Haskell/Lua comments,
 * YAML '---' separators, etc.) would prematurely terminate the hunk body,
 * silently discarding all remaining hunk lines.
 *
 * A line starting with 'diff --git ' is always a true file boundary.
 */
const isTrueFileBoundary = (lines: string[], i: number): boolean => {
  const l = lines[i] ?? ""
  if (l.startsWith("diff --git ")) return true
  if (l.startsWith("--- ") || l.startsWith("---\t")) {
    const next = lines[i + 1] ?? ""
    return next.startsWith("+++ ") || next.startsWith("+++\t")
  }
  return false
}

/**
 * Stricter boundary check used AFTER the first "@@ " hunk header has been
 * seen. At that point a "--- " line may be either a real next-file header OR
 * a deletion of a line whose content starts with "-- " (SQL/Haskell comment,
 * etc.) — and the lookahead-based isTrueFileBoundary can false-positive when
 * the very next line is an addition of a line starting with "++ " (producing
 * "+++ …" which looks like a +++ header).
 *
 * In a well-formed unified diff, a real "--- X / +++ Y" file header pair is
 * ALWAYS followed immediately by a "@@ " hunk header (on the line at i+2).
 * A false-positive occurs when "--- X" is a deletion and "+++ Y" is an
 * addition that are INSIDE an active hunk body — in that case lines[i+2] is
 * more hunk content, not "@@ ". We exploit this three-line lookahead to
 * distinguish the two cases while still correctly detecting real file
 * boundaries in plain multi-file unified diffs (no "diff --git" separator).
 *
 * "diff --git " is always unambiguous and is returned as-is.
 */
const isHunkAwareBoundary = (lines: string[], i: number): boolean => {
  const l = lines[i] ?? ""
  if (l.startsWith("diff --git ")) return true
  if (l.startsWith("--- ") || l.startsWith("---\t")) {
    const next = lines[i + 1] ?? ""
    if (!next.startsWith("+++ ") && !next.startsWith("+++\t")) return false
    // Three-line lookahead: a real "--- / +++" file header pair is immediately
    // followed by a "@@ " hunk header. If lines[i+2] is NOT "@@ " (and is
    // non-empty hunk content), this is a false-positive inside an active hunk.
    const afterNext = lines[i + 2] ?? ""
    // Accept if the line after "+++ " starts a new hunk, is empty (end of
    // diff), or is another meta-line that git emits before "@@ ". The key
    // rejection is when afterNext is a hunk content line (+/-/space) — those
    // cannot appear between "+++ " and "@@ " in valid unified diff.
    if (
      afterNext.startsWith("+") ||
      afterNext.startsWith("-") ||
      (afterNext.startsWith(" ") && afterNext !== "")
    ) {
      return false
    }
    return true
  }
  return false
}

/** Convert a unified diff string to V4A format. Returns best-effort V4A even
 *  on malformed input — parsePatch will throw PatchParseError if the result
 *  is still invalid. Called only when isUnifiedDiff returns true. */
export const unifiedDiffToV4A = (text: string): string => {
  const lines = text.split("\n")
  const out: string[] = [PATCH_SENTINELS.beginPatch]
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""

    // Skip git diff meta-header lines (no content in V4A)
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("Binary files")
    ) {
      i++
      continue
    }

    // File pair: "--- <from>\n+++ <to>"
    if (line.startsWith("--- ") || line.startsWith("---\t")) {
      const fromRaw = (line.slice(4).split("\t")[0] ?? "").trimEnd()
      const fromPath = stripGitPrefix(fromRaw)
      const toLine = lines[i + 1] ?? ""
      if (!toLine.startsWith("+++ ") && !toLine.startsWith("+++\t")) {
        i++
        continue
      }
      const toRaw = (toLine.slice(4).split("\t")[0] ?? "").trimEnd()
      const toPath = stripGitPrefix(toRaw)
      i += 2

      const isAdd = fromPath === "/dev/null"
      const isDel = toPath === "/dev/null"
      const filePath = isAdd ? toPath : fromPath

      if (isDel) {
        out.push(PATCH_SENTINELS.deleteFile + filePath)
        // Delete op has no body in V4A — skip hunk content.
        // After seeing the first "@@ " hunk header, guard against the
        // false-positive where a content deletion of a line starting with "-- "
        // produces "--- X" whose next line is "+++ Y" (addition of "++ Y") and
        // the lookahead incorrectly fires. In that case both X and Y start with
        // the same dash/plus pair, so we require the next line NOT to look like
        // a mere content addition when seenHunk is true.
        {
          let seenHunk = false
          while (i < lines.length) {
            const l = lines[i] ?? ""
            if (seenHunk ? isHunkAwareBoundary(lines, i) : isTrueFileBoundary(lines, i)) break
            i++
            if (l.startsWith("@@ ")) seenHunk = true
          }
        }
        continue
      }

      if (isAdd) {
        out.push(PATCH_SENTINELS.addFile + filePath)
        {
          let seenHunk = false
          while (i < lines.length) {
            const l = lines[i] ?? ""
            if (seenHunk ? isHunkAwareBoundary(lines, i) : isTrueFileBoundary(lines, i)) break
            i++
            if (l.startsWith("@@ ") || l === "@@") {
              seenHunk = true
              continue // skip hunk header
            }
            if (l.startsWith("+")) out.push(l) // keep + lines (strip later if needed)
            // context and - lines are skipped for add file
          }
        }
        continue
      }

      // Normal update
      out.push(PATCH_SENTINELS.updateFile + filePath)
      {
        let seenHunk = false
        while (i < lines.length) {
          const l = lines[i] ?? ""
          if (seenHunk ? isHunkAwareBoundary(lines, i) : isTrueFileBoundary(lines, i)) break
          i++
          if (l.startsWith("@@ ") || l === "@@") {
            seenHunk = true
            const m = l.match(/^@@ [^@]+ @@(?:\s+(.*))?$/)
            const ctx = m?.[1]?.trim()
            out.push(ctx ? `@@ ${ctx}` : "@@")
            continue
          }
          if (l.startsWith("+") || l.startsWith("-") || l.startsWith(" ") || l === "") {
            out.push(l)
          }
          // "\\No newline at end of file" -> skip
        }
      }
      continue
    }

    i++
  }

  out.push(PATCH_SENTINELS.endPatch)
  return out.join("\n")
}
