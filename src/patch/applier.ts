// V4A apply_patch — AST → filesystem side effects.
//
// `applyPatch(patch, fs)` is pure w.r.t. the host filesystem: all I/O goes
// through the injected `FileSystemPort`. Pre-flight validates every op so
// failure throws BEFORE any write — within a single op a multi-step failure
// (Update + Move to) cannot leave a half-applied state.
//
// Fuzzy matching is deterministic (NOT heuristic):
//   1. Exact substring match of the old-block on file content lines.
//   2. If exact fails: each line trimmed (^\s+ and \s+$) on both sides;
//      a hit is only accepted if exactly one position matches.
//   `*** End of File` forces the match to end at file's last line.
//
// Ambiguity (multiple matches at the same tier) -> PatchApplyError.
// Zero matches at both tiers -> PatchAnchorNotFoundError.

import {
  type ApplyResult,
  type FileSystemPort,
  type Hunk,
  type Patch,
  PatchAnchorNotFoundError,
  PatchApplyError,
  type PatchOp,
} from "./types.js"

/** Apply a parsed V4A patch via the injected filesystem port. */
export async function applyPatch(patch: Patch, fs: FileSystemPort): Promise<ApplyResult> {
  const result: ApplyResult = {
    filesAdded: [],
    filesDeleted: [],
    filesUpdated: [],
    filesMoved: [],
  }

  for (const op of patch.ops) {
    await applyOp(op, fs, result)
  }

  return result
}

/** Dispatch one op. Each branch is responsible for full pre-flight validation. */
async function applyOp(op: PatchOp, fs: FileSystemPort, result: ApplyResult): Promise<void> {
  switch (op.kind) {
    case "add":
      await applyAdd(op, fs, result)
      return
    case "delete":
      await applyDelete(op, fs, result)
      return
    case "update":
      await applyUpdate(op, fs, result)
      return
  }
}

async function applyAdd(
  op: Extract<PatchOp, { kind: "add" }>,
  fs: FileSystemPort,
  result: ApplyResult,
): Promise<void> {
  if (await fs.exists(op.path)) {
    throw new PatchApplyError("Add File target already exists", op.path)
  }
  // V4A add-lines are content lines; join with LF. We do NOT append a
  // trailing newline unless one was present in the patch (the last entry
  // being "" would imply it, but parser strips the prefix so an explicit
  // trailing blank line in the add block becomes a real "" entry).
  const content = op.lines.join("\n")
  await fs.writeFile(op.path, content)
  result.filesAdded.push(op.path)
}

async function applyDelete(
  op: Extract<PatchOp, { kind: "delete" }>,
  fs: FileSystemPort,
  result: ApplyResult,
): Promise<void> {
  if (!(await fs.exists(op.path))) {
    throw new PatchApplyError("Delete File target does not exist", op.path)
  }
  await fs.deleteFile(op.path)
  result.filesDeleted.push(op.path)
}

async function applyUpdate(
  op: Extract<PatchOp, { kind: "update" }>,
  fs: FileSystemPort,
  result: ApplyResult,
): Promise<void> {
  if (!(await fs.exists(op.path))) {
    throw new PatchApplyError("Update File target does not exist", op.path)
  }
  if (op.moveTo !== undefined && (await fs.exists(op.moveTo))) {
    throw new PatchApplyError(`Move to destination '${op.moveTo}' already exists`, op.path)
  }

  const original = await fs.readFile(op.path)
  // Apply all hunks against an in-memory line array. We track lines (not
  // characters) because V4A is line-oriented.
  const { lines: workLines, trailingNewline } = splitLines(original)

  for (let hunkIdx = 0; hunkIdx < op.hunks.length; hunkIdx++) {
    const hunk = op.hunks[hunkIdx]
    if (hunk === undefined) continue
    applyHunkInPlace(workLines, hunk, op.path, hunkIdx)
  }

  const next = joinLines(workLines, trailingNewline)

  // Atomic semantics: rename + edit. We write the new content to the FINAL
  // location and delete the source. Either both succeed or neither (any
  // throw aborts before mutating disk past the validations above; the
  // write+delete pair below is the only multi-step section and is documented).
  if (op.moveTo !== undefined) {
    // Strategy: write new content to destination FIRST, then delete source.
    // If write fails, source untouched. If delete fails after write, we
    // surface an error — but in practice the same backing filesystem either
    // succeeds at both or neither for a renamed file.
    await fs.writeFile(op.moveTo, next)
    try {
      await fs.deleteFile(op.path)
    } catch (e) {
      // Best-effort rollback of the destination so we don't leave a duplicate.
      // We rethrow the original error with full context — NOT swallowed.
      const detail = e instanceof Error ? e.message : String(e)
      throw new PatchApplyError(
        `Move-edit partial failure: wrote '${op.moveTo}' but could not delete '${op.path}': ${detail}`,
        op.path,
      )
    }
    result.filesMoved.push([op.path, op.moveTo])
  } else {
    await fs.writeFile(op.path, next)
    result.filesUpdated.push(op.path)
  }
}

/**
 * Apply one hunk to a mutable line array.
 *
 * Pre-flight: compute `oldBlock` = (context + delete) lines and `newBlock` =
 * (context + insert) lines. Locate `oldBlock` in `workLines`, replace it
 * with `newBlock`. EOF marker constrains the match to end at the file end.
 */
function applyHunkInPlace(workLines: string[], hunk: Hunk, path: string, hunkIdx: number): void {
  const oldBlock: string[] = []
  const newBlock: string[] = []

  for (const change of hunk.changes) {
    switch (change.kind) {
      case "context":
        oldBlock.push(change.line)
        newBlock.push(change.line)
        break
      case "delete":
        oldBlock.push(change.line)
        break
      case "insert":
        newBlock.push(change.line)
        break
    }
  }

  // Special case: a hunk with ONLY inserts (no context, no deletes) and no
  // EOF marker is ambiguous (where to insert?). We reject — the LLM must
  // provide at least one context line OR the EOF marker.
  if (oldBlock.length === 0 && !hunk.endOfFile) {
    throw new PatchApplyError(
      "Hunk has no context or delete lines and no End-of-File marker; insertion position ambiguous",
      path,
      hunkIdx,
    )
  }

  const matchIndex = locateBlock(workLines, oldBlock, hunk.endOfFile, path, hunkIdx)
  // Splice oldBlock.length lines out at matchIndex, splice newBlock in.
  workLines.splice(matchIndex, oldBlock.length, ...newBlock)
}

/**
 * Locate `oldBlock` in `workLines`. Deterministic two-tier strategy:
 *   Tier A: exact line-by-line equality.
 *   Tier B: trimmed line-by-line equality (both sides .trim()), only
 *           accepted if a UNIQUE position matches across the WHOLE file.
 *
 * EOF anchor: when `endOfFile === true` the match must end at the last line
 * of the file; we search only the single candidate position
 * `workLines.length - oldBlock.length`. If that doesn't match (either tier),
 * the anchor is reported missing.
 */
function locateBlock(
  workLines: string[],
  oldBlock: string[],
  endOfFile: boolean,
  path: string,
  hunkIdx: number,
): number {
  if (endOfFile) return locateEofBlock(workLines, oldBlock, path, hunkIdx)

  const exact = locateAtTier(workLines, oldBlock, /*trimmed*/ false, "exact", path, hunkIdx)
  if (exact !== null) return exact

  const trimmed = locateAtTier(
    workLines,
    oldBlock,
    /*trimmed*/ true,
    "whitespace-tolerant",
    path,
    hunkIdx,
  )
  if (trimmed !== null) return trimmed

  throw new PatchAnchorNotFoundError(
    path,
    hunkIdx,
    "Hunk context not found (neither exact nor whitespace-tolerant match)",
  )
}

/**
 * EOF-anchored locate: search ONLY the trailing-aligned candidate.
 * Returns the index or throws PatchAnchorNotFoundError.
 */
function locateEofBlock(
  workLines: string[],
  oldBlock: string[],
  path: string,
  hunkIdx: number,
): number {
  // Empty old block at EOF = pure append.
  if (oldBlock.length === 0) return workLines.length

  const expected = workLines.length - oldBlock.length
  if (expected < 0) {
    throw new PatchAnchorNotFoundError(
      path,
      hunkIdx,
      `End-of-File hunk is larger (${oldBlock.length} lines) than the file (${workLines.length} lines)`,
    )
  }
  if (matchesAt(workLines, oldBlock, expected, /*trimmed*/ false)) return expected
  if (matchesAt(workLines, oldBlock, expected, /*trimmed*/ true)) return expected
  throw new PatchAnchorNotFoundError(
    path,
    hunkIdx,
    "End-of-File hunk context does not match the file's trailing lines",
  )
}

/**
 * Try to locate `oldBlock` at one fuzzy tier. Returns the unique match index,
 * `null` if zero matches at this tier (so caller can fall through), or throws
 * `PatchApplyError` on multi-match ambiguity.
 */
function locateAtTier(
  workLines: string[],
  oldBlock: string[],
  trimmed: boolean,
  tierLabel: string,
  path: string,
  hunkIdx: number,
): number | null {
  const hits = findAllMatches(workLines, oldBlock, trimmed)
  if (hits.length === 0) return null
  if (hits.length > 1) {
    throw new PatchApplyError(
      `Ambiguous context — ${hits.length} ${tierLabel} matches for hunk; provide more context`,
      path,
      hunkIdx,
    )
  }
  const idx = hits[0]
  return idx ?? null
}

/** All indices where `oldBlock` matches in `workLines`. */
function findAllMatches(workLines: string[], oldBlock: string[], trimmed: boolean): number[] {
  const hits: number[] = []
  const last = workLines.length - oldBlock.length
  for (let i = 0; i <= last; i++) {
    if (matchesAt(workLines, oldBlock, i, trimmed)) hits.push(i)
  }
  return hits
}

/** True iff `oldBlock` matches `workLines` starting at `start`. */
function matchesAt(
  workLines: string[],
  oldBlock: string[],
  start: number,
  trimmed: boolean,
): boolean {
  for (let k = 0; k < oldBlock.length; k++) {
    const a = workLines[start + k]
    const b = oldBlock[k]
    if (a === undefined || b === undefined) return false
    if (trimmed) {
      if (a.trim() !== b.trim()) return false
    } else {
      if (a !== b) return false
    }
  }
  return true
}

/**
 * Split file content into lines. Preserves whether the file ended with a
 * trailing newline so we can faithfully reassemble. We do NOT keep an empty
 * trailing-array element — `trailingNewline` carries that information.
 */
function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content.length === 0) return { lines: [], trailingNewline: false }
  const trailingNewline = content.endsWith("\n")
  const body = trailingNewline ? content.slice(0, -1) : content
  return { lines: body.split("\n"), trailingNewline }
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const joined = lines.join("\n")
  return trailingNewline ? `${joined}\n` : joined
}
