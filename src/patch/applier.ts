import { errMessage } from "@/shared"
// V4A apply_patch — AST → filesystem side effects.
//
// `applyPatch(patch, fs)` is pure w.r.t. the host filesystem: all I/O goes
// through the injected `PatchFileSystemPort`. Pre-flight validates every op so
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
  type Hunk,
  type Patch,
  PatchAnchorNotFoundError,
  PatchApplyError,
  type PatchFileSystemPort,
  type PatchObservation,
  type PatchObserver,
  type PatchOp,
  type PatchTracePort,
} from "./types"

/** Internal: a guaranteed-no-throw observer wrapper. Production calls pass
 *  through an optional end-user observer AND an optional injected
 *  {@link PatchTracePort} so the canonical `quanta.patch.*` vocabulary keys are
 *  activated WITHOUT `@/patch` reaching into `@/observability` at runtime
 *  (closed-port DI — the OTel binding lives in the adapter the composition root
 *  passes). Absent trace port ⇒ no tracing (byte-identical to no telemetry);
 *  absent user observer ⇒ trace-only (or nothing if both absent). A throw from
 *  EITHER sink is caught + swallowed so apply semantics are independent of
 *  telemetry health (mirrors `@/observability/spans.ts`). */
const wrapObserver = (
  observer: PatchObserver | undefined,
  trace: PatchTracePort | undefined,
): PatchObserver => {
  return (event: PatchObservation) => {
    if (observer !== undefined) {
      try {
        observer(event)
      } catch {
        // User-observer throw must not stop the canonical trace emit either.
      }
    }
    if (trace !== undefined) {
      try {
        trace.recordPatchOp(event)
      } catch {
        // Telemetry bugs MUST NOT abort the apply pipeline.
      }
    }
  }
}

/** Apply a parsed V4A patch via the injected filesystem port. Per-op telemetry
 *  is emitted ONLY through the injected {@link PatchTracePort} (`trace`) — an
 *  absent port is a byte-identical no-op (default-OFF; `@/patch` never reaches
 *  into `@/observability`, the OTel binding lives in the adapter the composition
 *  root passes). An optional `observer` receives the same event stream for
 *  in-process consumers (tests, harnesses); production callers omit it. Neither
 *  the observer nor the trace port receives patch text, file content, hunk
 *  lines, or anchor strings — only the categorical op
 *  (`"add" | "update" | "delete" | "move"`) and (for landed update hunks) the
 *  fuzzy-match tier (`"exact" | "whitespace"`). */
export async function applyPatch(
  patch: Patch,
  fs: PatchFileSystemPort,
  observer?: PatchObserver,
  trace?: PatchTracePort,
): Promise<ApplyResult> {
  const emit = wrapObserver(observer, trace)

  // ── Phase 1: PLAN ────────────────────────────────────────────────────────
  // Validate every op and compute its concrete mutations (read files, locate
  // hunks, derive new content) WITHOUT touching disk. Any failure here — a
  // missing target, an occupied move destination, an unlocatable anchor — is
  // raised before a single byte is written, so the host filesystem is
  // guaranteed untouched. Observer events are buffered, never emitted, in this
  // phase: a plan that later aborts must produce ZERO observations.
  const result: ApplyResult = {
    filesAdded: [],
    filesDeleted: [],
    filesUpdated: [],
    filesMoved: [],
  }
  const buffered: PatchObservation[] = []
  const plans: OpPlan[] = []
  for (const op of patch.ops) {
    plans.push(await planOp(op, fs, result, (event) => buffered.push(event)))
  }

  // ── Phase 2: COMMIT ──────────────────────────────────────────────────────
  // Execute the planned mutations, journaling an inverse action for each
  // landed step. On ANY failure we replay the journal in reverse to restore
  // the original on-disk state, then rethrow — so a multi-op patch is
  // all-or-nothing across the WHOLE call, not merely within a single op. The
  // rename-edit path uses `fs.renameFile` (the atomic primitive): a partial
  // rename failure that leaks the destination is undone by the journal.
  const journal: Array<() => Promise<void>> = []
  try {
    for (const plan of plans) await commitPlan(plan, fs, journal)
  } catch (err) {
    await rollback(journal)
    // A commit-phase I/O failure (e.g. a write/rename that the port rejects
    // mid-flight) surfaces as a typed PatchApplyError so callers keep a single
    // error contract — UNLESS it is already one of our typed patch errors.
    if (err instanceof PatchApplyError || err instanceof PatchAnchorNotFoundError) throw err
    throw new PatchApplyError(`Patch commit failed and was rolled back: ${errMessage(err)}`, "")
  }

  // Commit succeeded — only now are observations real. Flush in patch order.
  for (const event of buffered) emit(event)
  return result
}

/** A fully-validated, side-effect-free description of one op's mutations,
 *  ready to commit. Derived in phase 1; executed in phase 2. */
type OpPlan =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string; original: string }
  | { kind: "update"; path: string; original: string; next: string }
  | {
      kind: "move"
      path: string
      moveTo: string
      original: string
      next: string
    }

/** Replay journaled inverse actions newest-first to restore the pre-commit
 *  on-disk state. Inverse-action failures are swallowed: rollback is
 *  best-effort and must never mask the original error that triggered it. */
async function rollback(journal: Array<() => Promise<void>>): Promise<void> {
  for (let i = journal.length - 1; i >= 0; i--) {
    const undo = journal[i]
    if (undo === undefined) continue
    try {
      await undo()
    } catch {
      // Best-effort: a failed undo must not eclipse the triggering error.
    }
  }
}

/** Validate + plan one op (no disk writes). Buffered observer events for
 *  landed hunks are recorded here but only flushed by the caller AFTER the
 *  whole patch commits. Each branch performs full pre-flight validation. */
async function planOp(
  op: PatchOp,
  fs: PatchFileSystemPort,
  result: ApplyResult,
  buffer: PatchObserver,
): Promise<OpPlan> {
  switch (op.kind) {
    case "add":
      return planAdd(op, fs, result, buffer)
    case "delete":
      return planDelete(op, fs, result, buffer)
    case "update":
      return planUpdate(op, fs, result, buffer)
  }
}

/** Execute one planned op, pushing inverse actions onto `journal` as each
 *  on-disk step lands so a later failure can be rolled back. */
async function commitPlan(
  plan: OpPlan,
  fs: PatchFileSystemPort,
  journal: Array<() => Promise<void>>,
): Promise<void> {
  switch (plan.kind) {
    case "add": {
      await fs.writeFile(plan.path, plan.content)
      journal.push(() => fs.deleteFile(plan.path))
      return
    }
    case "delete": {
      await fs.deleteFile(plan.path)
      journal.push(() => fs.writeFile(plan.path, plan.original))
      return
    }
    case "update": {
      await fs.writeFile(plan.path, plan.next)
      journal.push(() => fs.writeFile(plan.path, plan.original))
      return
    }
    case "move": {
      // Apply the edit in place on the source, then atomically rename to the
      // destination. We journal the rename-undo BEFORE invoking renameFile:
      // a port whose rename leaks the destination then fails mid-flight (the
      // write-then-throw hazard) must still have its destination reaped. The
      // undo deletes the destination if present and restores the source so the
      // companion write-undo can return it to its original content.
      await fs.writeFile(plan.path, plan.next)
      journal.push(() => fs.writeFile(plan.path, plan.original))
      journal.push(async () => {
        if (await fs.exists(plan.moveTo)) await fs.deleteFile(plan.moveTo)
        if (!(await fs.exists(plan.path))) await fs.writeFile(plan.path, plan.next)
      })
      await fs.renameFile(plan.path, plan.moveTo)
      return
    }
  }
}

async function planAdd(
  op: Extract<PatchOp, { kind: "add" }>,
  fs: PatchFileSystemPort,
  result: ApplyResult,
  buffer: PatchObserver,
): Promise<OpPlan> {
  if (await fs.exists(op.path)) {
    throw new PatchApplyError("Add File target already exists", op.path)
  }
  // V4A add-lines are content lines; join with LF. We do NOT append a
  // trailing newline unless one was present in the patch (the last entry
  // being "" would imply it, but parser strips the prefix so an explicit
  // trailing blank line in the add block becomes a real "" entry).
  const content = op.lines.join("\n")
  result.filesAdded.push(op.path)
  buffer({ op: "add" })
  return { kind: "add", path: op.path, content }
}

async function planDelete(
  op: Extract<PatchOp, { kind: "delete" }>,
  fs: PatchFileSystemPort,
  result: ApplyResult,
  buffer: PatchObserver,
): Promise<OpPlan> {
  if (!(await fs.exists(op.path))) {
    throw new PatchApplyError("Delete File target does not exist", op.path)
  }
  // Capture the original content so the commit phase can journal a restore.
  const original = await fs.readFile(op.path)
  result.filesDeleted.push(op.path)
  buffer({ op: "delete" })
  return { kind: "delete", path: op.path, original }
}

async function planUpdate(
  op: Extract<PatchOp, { kind: "update" }>,
  fs: PatchFileSystemPort,
  result: ApplyResult,
  buffer: PatchObserver,
): Promise<OpPlan> {
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

  // The op category emitted alongside each hunk's fuzzy tier: a `moveTo`
  // update becomes the `"move"` category in telemetry so dashboards can
  // count renames separately from in-place updates.
  const hunkOp: "update" | "move" = op.moveTo !== undefined ? "move" : "update"
  for (let hunkIdx = 0; hunkIdx < op.hunks.length; hunkIdx++) {
    const hunk = op.hunks[hunkIdx]
    if (hunk === undefined) continue
    const tier = applyHunkInPlace(workLines, hunk, op.path, hunkIdx)
    buffer({ op: hunkOp, fuzzyMatchTier: tier })
  }

  const next = joinLines(workLines, trailingNewline)

  if (op.moveTo !== undefined) {
    result.filesMoved.push([op.path, op.moveTo])
    buffer({ op: "move" })
    return { kind: "move", path: op.path, moveTo: op.moveTo, original, next }
  }
  result.filesUpdated.push(op.path)
  buffer({ op: "update" })
  return { kind: "update", path: op.path, original, next }
}

/** Fuzzy-tier label emitted to telemetry when a hunk lands. Mirrors the
 *  literal union declared in `vocabulary.ts#QUANTA_ATTRS.patch.fuzzyMatchTier`
 *  (`"exact" | "whitespace" | "fuzzy"`). The V4A applier currently exposes
 *  the first two tiers — pure-trimmed equality is reported as `"whitespace"`. */
type FuzzyTier = "exact" | "whitespace" | "fuzzy"

/**
 * Apply one hunk to a mutable line array.
 *
 * Pre-flight: compute `oldBlock` = (context + delete) lines and `newBlock` =
 * (context + insert) lines. Locate `oldBlock` in `workLines`, replace it
 * with `newBlock`. EOF marker constrains the match to end at the file end.
 *
 * Returns the {@link FuzzyTier} the locator settled on, so the caller can
 * forward it to a {@link PatchObserver} without re-deriving from the
 * grammar (NEVER the matched anchor text — only the tier label).
 */
function applyHunkInPlace(
  workLines: string[],
  hunk: Hunk,
  path: string,
  hunkIdx: number,
): FuzzyTier {
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

  const { index, tier } = locateBlock(workLines, oldBlock, hunk.endOfFile, path, hunkIdx)
  // Splice oldBlock.length lines out at matchIndex, splice newBlock in.
  workLines.splice(index, oldBlock.length, ...newBlock)
  return tier
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
 *
 * Returns `{ index, tier }` — `tier` reports which strategy succeeded so the
 * caller can forward it to telemetry.
 */
function locateBlock(
  workLines: string[],
  oldBlock: string[],
  endOfFile: boolean,
  path: string,
  hunkIdx: number,
): { index: number; tier: FuzzyTier } {
  if (endOfFile) return locateEofBlock(workLines, oldBlock, path, hunkIdx)

  const exact = locateAtTier(workLines, oldBlock, /*trimmed*/ false, "exact", path, hunkIdx)
  if (exact !== null) return { index: exact, tier: "exact" }

  const trimmed = locateAtTier(
    workLines,
    oldBlock,
    /*trimmed*/ true,
    "whitespace-tolerant",
    path,
    hunkIdx,
  )
  if (trimmed !== null) return { index: trimmed, tier: "whitespace" }

  throw new PatchAnchorNotFoundError(
    path,
    hunkIdx,
    "Hunk context not found (neither exact nor whitespace-tolerant match)",
  )
}

/**
 * EOF-anchored locate: search ONLY the trailing-aligned candidate.
 * Returns `{ index, tier }` or throws PatchAnchorNotFoundError.
 */
function locateEofBlock(
  workLines: string[],
  oldBlock: string[],
  path: string,
  hunkIdx: number,
): { index: number; tier: FuzzyTier } {
  // Empty old block at EOF = pure append.
  if (oldBlock.length === 0) return { index: workLines.length, tier: "exact" }

  const expected = workLines.length - oldBlock.length
  if (expected < 0) {
    throw new PatchAnchorNotFoundError(
      path,
      hunkIdx,
      `End-of-File hunk is larger (${oldBlock.length} lines) than the file (${workLines.length} lines)`,
    )
  }
  if (matchesAt(workLines, oldBlock, expected, /*trimmed*/ false)) {
    return { index: expected, tier: "exact" }
  }
  if (matchesAt(workLines, oldBlock, expected, /*trimmed*/ true)) {
    return { index: expected, tier: "whitespace" }
  }
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
