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
    return t.startsWith("--- ") || t.startsWith("diff --git ")
  }
  return false
}

/** Strip the "a/" or "b/" git prefix from a unified diff path. */
const stripGitPrefix = (p: string): string =>
  p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p

/** True iff line begins a new file section in a unified diff. */
const isFileBoundary = (line: string): boolean =>
  line.startsWith("--- ") || line.startsWith("diff --git ")

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
    if (line.startsWith("--- ")) {
      const fromRaw = (line.slice(4).split("\t")[0] ?? "").trimEnd()
      const fromPath = stripGitPrefix(fromRaw)
      const toLine = lines[i + 1] ?? ""
      if (!toLine.startsWith("+++ ")) { i++; continue }
      const toRaw = (toLine.slice(4).split("\t")[0] ?? "").trimEnd()
      const toPath = stripGitPrefix(toRaw)
      i += 2

      const isAdd = fromPath === "/dev/null"
      const isDel = toPath === "/dev/null"
      const filePath = isAdd ? toPath : fromPath

      if (isDel) {
        out.push(PATCH_SENTINELS.deleteFile + filePath)
        // Delete op has no body in V4A — skip hunk content
        while (i < lines.length && !isFileBoundary(lines[i] ?? "")) i++
        continue
      }

      if (isAdd) {
        out.push(PATCH_SENTINELS.addFile + filePath)
        while (i < lines.length && !isFileBoundary(lines[i] ?? "")) {
          const l = lines[i] ?? ""
          i++
          if (l.startsWith("@@ ") || l === "@@") continue // skip hunk header
          if (l.startsWith("+")) out.push(l) // keep + lines (strip later if needed)
          // context and - lines are skipped for add file
        }
        continue
      }

      // Normal update
      out.push(PATCH_SENTINELS.updateFile + filePath)
      while (i < lines.length && !isFileBoundary(lines[i] ?? "")) {
        const l = lines[i] ?? ""
        i++
        if (l.startsWith("@@ ") || l === "@@") {
          const m = l.match(/^@@ [^@]+ @@(?:\s+(.*))?$/)
          const ctx = m?.[1]?.trim()
          out.push(ctx ? "@@ " + ctx : "@@")
          continue
        }
        if (l.startsWith("+") || l.startsWith("-") || l.startsWith(" ") || l === "") {
          out.push(l)
        }
        // "\\No newline at end of file" -> skip
      }
      continue
    }

    i++
  }

  out.push(PATCH_SENTINELS.endPatch)
  return out.join("\n")
}
