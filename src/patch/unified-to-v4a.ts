// Pure unified diff -> V4A converter + detector.
//
// Unified diff (POSIX) uses "--- a/file" / "+++ b/file" / "@@ -x,y +x,y @@"
// headers that the V4A parser rejects. This module converts a well-formed
// unified diff to the V4A format that parsePatch understands, without touching
// the per-line +/-/space prefix (both formats share that prefix alphabet).
//
// Design: pure (no I/O), deterministic (same input => byte-identical output).
// Best-effort (no throw) on truncated/missing +++ headers. Inconsistent or
// malformed rename metadata is REJECTED via PatchConvertError — never degraded
// to an in-place update of the old path.

import { normalizeDiffPath, pathAfterGitHeader } from "./git-path"
import { PATCH_SENTINELS, PatchConvertError } from "./types"

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

/** Git meta-header line prefixes that carry no V4A representation. Rename
 *  from/to are NOT discarded here — they are captured into file-section IR. */
const GIT_META_PREFIXES = [
  "diff --git ",
  "index ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "Binary files",
] as const

/** Responsibility: recognise a git meta-header line (no content in V4A). */
const isGitMetaHeader = (line: string): boolean =>
  GIT_META_PREFIXES.some((prefix) => line.startsWith(prefix))

/** The from/to paths of one unified-diff file-pair header, git prefix stripped. */
type FilePairHeader = {
  readonly fromPath: string
  readonly toPath: string
}

/** Rename/copy metadata captured while scanning one git file section. */
type FileSectionMeta = {
  renameFrom?: string
  renameTo?: string
  copy: boolean
}

const emptyMeta = (): FileSectionMeta => ({ copy: false })

/** Responsibility: read the "--- <from>" / "+++ <to>" file-pair header whose
 *  "---" half sits at `i`. Returns null when the "+++" half is missing — the
 *  caller then treats the "---" line as noise and keeps scanning. */
const readFilePairHeader = (lines: string[], i: number): FilePairHeader | null => {
  const fromRaw = (lines[i] ?? "").slice(4)
  const toLine = lines[i + 1] ?? ""
  if (!toLine.startsWith("+++ ") && !toLine.startsWith("+++\t")) return null
  const toRaw = toLine.slice(4)
  return { fromPath: normalizeDiffPath(fromRaw), toPath: normalizeDiffPath(toRaw) }
}

/**
 * Responsibility: walk ONE file section's hunk body, stopping at the next true
 * file boundary, and hand every consumed line to `onLine`. `onLine` returns
 * true when the line it consumed was a hunk header — from that point on the
 * stricter three-line-lookahead boundary test applies.
 *
 * After the first "@@ " hunk header has been seen, guard against the
 * false-positive where a content deletion of a line starting with "-- "
 * produces "--- X" whose next line is "+++ Y" (addition of "++ Y") and the
 * lookahead incorrectly fires. In that case both X and Y start with the same
 * dash/plus pair, so we require the next line NOT to look like a mere content
 * addition when seenHunk is true.
 *
 * Returns the index of the boundary line (or lines.length at end of input).
 */
const scanHunkBody = (
  lines: string[],
  start: number,
  onLine: (line: string) => boolean,
): number => {
  let i = start
  let seenHunk = false
  while (i < lines.length) {
    const l = lines[i] ?? ""
    if (seenHunk ? isHunkAwareBoundary(lines, i) : isTrueFileBoundary(lines, i)) break
    i++
    if (onLine(l)) seenHunk = true
  }
  return i
}

/** Responsibility: consume the body of a DELETED file. A V4A delete op has no
 *  body, so every hunk line is discarded. */
const skipDeletedFileBody = (lines: string[], start: number): number =>
  scanHunkBody(lines, start, (l) => l.startsWith("@@ "))

/** Responsibility: emit the body of an ADDED file — only "+" lines survive;
 *  hunk headers, context lines and "-" lines are dropped. */
const emitAddedFileBody = (lines: string[], start: number, out: string[]): number =>
  scanHunkBody(lines, start, (l) => {
    if (l.startsWith("@@ ") || l === "@@") return true // skip hunk header
    if (l.startsWith("+")) out.push(l) // keep + lines (strip later if needed)
    // context and - lines are skipped for add file
    return false
  })

/** Responsibility: emit the body of an UPDATED file — a unified
 *  "@@ -x,y +x,y @@ <ctx>" header is rewritten to the V4A "@@ <ctx>" form and
 *  every +/-/context/blank line passes through verbatim. */
const emitUpdatedFileBody = (lines: string[], start: number, out: string[]): number =>
  scanHunkBody(lines, start, (l) => {
    if (l.startsWith("@@ ") || l === "@@") {
      const m = l.match(/^@@ [^@]+ @@(?:\s+(.*))?$/)
      const ctx = m?.[1]?.trim()
      out.push(ctx ? `@@ ${ctx}` : "@@")
      return true
    }
    if (l.startsWith("+") || l.startsWith("-") || l.startsWith(" ") || l === "") {
      out.push(l)
    }
    // "\\No newline at end of file" -> skip
    return false
  })

/** Reject incomplete or pair-disagreeing rename metadata. Never fall back to update. */
const requireConsistentRename = (pair: FilePairHeader | null, meta: FileSectionMeta): void => {
  const hasFrom = meta.renameFrom !== undefined
  const hasTo = meta.renameTo !== undefined
  if (hasFrom !== hasTo) {
    throw new PatchConvertError(
      "incomplete rename metadata: both 'rename from' and 'rename to' are required",
    )
  }
  if (meta.renameFrom === undefined || meta.renameTo === undefined) return
  if (meta.copy) {
    throw new PatchConvertError("inconsistent metadata: copy and rename both present")
  }
  if (meta.renameFrom === meta.renameTo) {
    throw new PatchConvertError("rename from and rename to are the same path")
  }
  if (pair === null) return
  if (pair.fromPath === "/dev/null" || pair.toPath === "/dev/null") {
    throw new PatchConvertError("rename metadata cannot combine with /dev/null add/delete")
  }
  if (pair.fromPath !== meta.renameFrom || pair.toPath !== meta.renameTo) {
    throw new PatchConvertError(
      `inconsistent rename metadata: rename from/to '${meta.renameFrom}'→'${meta.renameTo}' vs ---/+++ '${pair.fromPath}'→'${pair.toPath}'`,
    )
  }
}

const emitMoveUpdate = (fromPath: string, toPath: string, out: string[]): void => {
  out.push(PATCH_SENTINELS.updateFile + fromPath)
  out.push(PATCH_SENTINELS.moveTo + toPath)
}

const flushRenameOnly = (meta: FileSectionMeta, out: string[]): void => {
  if (meta.renameFrom === undefined && meta.renameTo === undefined) return
  requireConsistentRename(null, meta)
  if (meta.renameFrom === undefined || meta.renameTo === undefined) return
  emitMoveUpdate(meta.renameFrom, meta.renameTo, out)
}

/** Responsibility: emit ONE V4A file section (op sentinel + body) for an
 *  already-parsed file pair, choosing the add/delete/update/move the pair's
 *  /dev/null placement and rename IR imply. Returns the index just past the
 *  section. */
const emitFileSection = (
  pair: FilePairHeader,
  lines: string[],
  start: number,
  out: string[],
  meta: FileSectionMeta,
): number => {
  requireConsistentRename(pair, meta)

  const isAdd = pair.fromPath === "/dev/null"
  const isDel = pair.toPath === "/dev/null"
  const filePath = isAdd ? pair.toPath : pair.fromPath

  if (isDel) {
    out.push(PATCH_SENTINELS.deleteFile + filePath)
    return skipDeletedFileBody(lines, start)
  }

  if (isAdd) {
    out.push(PATCH_SENTINELS.addFile + filePath)
    return emitAddedFileBody(lines, start, out)
  }

  if (meta.renameFrom !== undefined && meta.renameTo !== undefined) {
    emitMoveUpdate(meta.renameFrom, meta.renameTo, out)
    return emitUpdatedFileBody(lines, start, out)
  }

  // Paths differ without copy metadata: treat as rename+edit.
  if (!meta.copy && pair.fromPath !== pair.toPath) {
    emitMoveUpdate(pair.fromPath, pair.toPath, out)
    return emitUpdatedFileBody(lines, start, out)
  }

  out.push(PATCH_SENTINELS.updateFile + filePath)
  return emitUpdatedFileBody(lines, start, out)
}

const captureRenameMeta = (line: string, meta: FileSectionMeta): boolean => {
  const from = pathAfterGitHeader(line, "rename from")
  if (from !== null) {
    if (meta.renameFrom !== undefined) {
      throw new PatchConvertError("duplicate 'rename from' in one file section")
    }
    meta.renameFrom = from
    return true
  }
  const to = pathAfterGitHeader(line, "rename to")
  if (to !== null) {
    if (meta.renameTo !== undefined) {
      throw new PatchConvertError("duplicate 'rename to' in one file section")
    }
    meta.renameTo = to
    return true
  }
  if (line.startsWith("copy from") || line.startsWith("copy to")) {
    meta.copy = true
    return true
  }
  return false
}

/** Convert a unified diff string to V4A format. Returns best-effort V4A even
 *  on truncated input (missing +++). Inconsistent rename metadata throws
 *  {@link PatchConvertError}. Called only when isUnifiedDiff returns true. */
export const unifiedDiffToV4A = (text: string): string => {
  const lines = text.split("\n")
  const out: string[] = [PATCH_SENTINELS.beginPatch]
  let i = 0
  let meta = emptyMeta()

  while (i < lines.length) {
    const line = lines[i] ?? ""

    if (line.startsWith("diff --git ")) {
      flushRenameOnly(meta, out)
      meta = emptyMeta()
      i++
      continue
    }

    if (captureRenameMeta(line, meta)) {
      i++
      continue
    }

    if (isGitMetaHeader(line)) {
      i++
      continue
    }

    if (line.startsWith("--- ") || line.startsWith("---\t")) {
      const pair = readFilePairHeader(lines, i)
      if (pair === null) {
        i++
        continue
      }
      i = emitFileSection(pair, lines, i + 2, out, meta)
      meta = emptyMeta()
      continue
    }

    i++
  }

  flushRenameOnly(meta, out)
  out.push(PATCH_SENTINELS.endPatch)
  return out.join("\n")
}
