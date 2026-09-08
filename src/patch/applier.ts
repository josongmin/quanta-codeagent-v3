import { detectEol, type EolStyle, joinWithEol, splitEolAware } from "@/shared/eol"
// EOL detection/splitting lives in `@/shared/eol` (SSOT) so `@/patch` does NOT
// reach into `@/tool/edit` (slice fence). A parity ratchet test asserts this
// `detectEol` stays byte-identical to the edit slice's so the two cannot drift.
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

import { type InverseAction, rethrowCommitFailure, rollback } from "./commit-journal"
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
  // F2: a virtual-FS overlay that accumulates the effect of EARLIER ops in this
  // SAME patch (added/deleted/moved/updated paths + their planned content). Each
  // op validates + reads against the overlay — NOT raw disk — so e.g.
  // "delete A"+"add A" and "add A"+"update A" succeed, while a genuine two-ops-
  // write-the-same-final-path collision (e.g. "move A→B"+"add B") is a typed
  // PatchApplyError instead of a silent commit-phase clobber.
  const overlay = new PatchOverlay(fs)
  for (const op of patch.ops) {
    const plan = await planOp(op, overlay, result, (event) => buffered.push(event))
    overlay.applyPlan(plan)
    plans.push(plan)
  }

  // ── Phase 2: COMMIT ──────────────────────────────────────────────────────
  // Execute the planned mutations, journaling an inverse action for each
  // landed step. On ANY failure we replay the journal in reverse to restore
  // the original on-disk state, then rethrow — so a multi-op patch is
  // all-or-nothing across the WHOLE call, not merely within a single op. The
  // rename-edit path uses `fs.renameFile` (the atomic primitive): a partial
  // rename failure that leaks the destination is undone by the journal.
  // Execute the planned mutations, journaling an inverse action for each
  // landed step. On ANY failure we replay the journal in reverse. When every
  // required undo succeeds the original on-disk state is restored and the
  // caller sees a rolled-back commit error. Undo failures are collected and
  // surfaced as rollbackIncomplete — they are never swallowed, and the
  // caller must not assume a clean disk. This is not a claim of multi-file
  // crash atomicity.
  const journal: InverseAction[] = []
  try {
    for (const plan of plans) await commitPlan(plan, fs, journal)
  } catch (err) {
    const failedUndos = await rollback(journal)
    rethrowCommitFailure(err, failedUndos)
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

/** The subset of {@link PatchFileSystemPort} the PLAN phase needs: it only ever
 *  reads (no mutation happens until COMMIT). {@link PatchOverlay} implements it
 *  over the real port + an in-memory diff of prior planned ops. */
interface PatchReadPort {
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

/**
 * F2 — a virtual-FS overlay layered over the real {@link PatchFileSystemPort},
 * for the PLAN phase only. It accumulates the EFFECT of earlier ops in the same
 * patch so each op validates + reads against the patch's evolving state, not
 * raw disk (Codex applies ops against an evolving in-memory model). This makes
 * intra-patch sequences correct:
 *   - "delete A"+"add A" succeeds (add sees A virtually gone),
 *   - "add A"+"update A" succeeds (update reads A's planned content),
 * while a genuine collision (two ops producing the SAME final path, e.g.
 * "move A→B"+"add B") is rejected at plan time by the per-op existence check —
 * a typed {@link PatchApplyError}, never a silent commit-phase clobber.
 *
 * Reads are still side-effect-free: the COMMIT phase replays the unchanged
 * {@link commitPlan} against the real port. The overlay never touches disk.
 */
class PatchOverlay implements PatchReadPort {
  /** path → planned content for paths this patch CREATES or REWRITES. */
  private readonly present = new Map<string, string>()
  /** paths this patch REMOVES (deleted, or the source side of a move). A path in
   *  `present` AND `removed` is treated as present (a later add/rewrite wins). */
  private readonly removed = new Set<string>()

  constructor(private readonly disk: PatchReadPort) {}

  async exists(path: string): Promise<boolean> {
    if (this.present.has(path)) return true
    if (this.removed.has(path)) return false
    return this.disk.exists(path)
  }

  async readFile(path: string): Promise<string> {
    const virtual = this.present.get(path)
    if (virtual !== undefined) return virtual
    if (this.removed.has(path)) {
      // A path the patch already removed cannot be read back. (planUpdate guards
      // this with an exists() check first, so this is defence-in-depth.)
      throw new PatchApplyError("Update File target does not exist", path)
    }
    return this.disk.readFile(path)
  }

  /** Fold one fully-planned op's effect into the overlay so SUBSEQUENT ops see
   *  the patch's evolving virtual state. */
  applyPlan(plan: OpPlan): void {
    switch (plan.kind) {
      case "add":
        this.present.set(plan.path, plan.content)
        this.removed.delete(plan.path)
        return
      case "delete":
        this.present.delete(plan.path)
        this.removed.add(plan.path)
        return
      case "update":
        this.present.set(plan.path, plan.next)
        this.removed.delete(plan.path)
        return
      case "move":
        // The source is gone; the destination now holds the edited content.
        this.present.delete(plan.path)
        this.removed.add(plan.path)
        this.present.set(plan.moveTo, plan.next)
        this.removed.delete(plan.moveTo)
        return
    }
  }
}

/** Validate + plan one op (no disk writes). Buffered observer events for
 *  landed hunks are recorded here but only flushed by the caller AFTER the
 *  whole patch commits. Each branch performs full pre-flight validation. */
async function planOp(
  op: PatchOp,
  fs: PatchReadPort,
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
  journal: InverseAction[],
): Promise<void> {
  // F5 — TRANSACTIONAL: every inverse action is journaled BEFORE the mutating
  // call it undoes. A port whose write/delete/rename PARTIALLY mutates the disk
  // and THEN throws mid-effect would, under the old journal-AFTER-write ordering,
  // leave that step un-journaled and therefore unrecoverable by rollback. The
  // restore content is already captured during planning, so the inverse closure
  // is available pre-write. Inverse actions that throw are collected by
  // rollback (not swallowed). An inverse for a write that never actually landed
  // (the file is absent) must NOT itself throw — hence the existence-guarded delete.
  switch (plan.kind) {
    case "add": {
      journal.push({
        paths: [plan.path],
        undo: async () => {
          if (await fs.exists(plan.path)) await fs.deleteFile(plan.path)
        },
      })
      await fs.writeFile(plan.path, plan.content)
      return
    }
    case "delete": {
      journal.push({
        paths: [plan.path],
        undo: () => fs.writeFile(plan.path, plan.original),
      })
      await fs.deleteFile(plan.path)
      return
    }
    case "update": {
      journal.push({
        paths: [plan.path],
        undo: () => fs.writeFile(plan.path, plan.original),
      })
      await fs.writeFile(plan.path, plan.next)
      return
    }
    case "move": {
      // Apply the edit in place on the source, then atomically rename to the
      // destination. Both inverse actions are journaled BEFORE their mutating
      // call: the source-restore before the in-place write, and the rename-undo
      // before renameFile. A port whose write leaks the edited source then fails
      // (the write-then-throw hazard) is undone by the source-restore; a rename
      // that leaks the destination then fails has its destination reaped. The
      // rename-undo restores the source if the rename already removed it, so the
      // companion source-restore can then return it to its original content.
      journal.push({
        paths: [plan.path],
        undo: () => fs.writeFile(plan.path, plan.original),
      })
      await fs.writeFile(plan.path, plan.next)
      journal.push({
        paths: [plan.moveTo, plan.path],
        undo: async () => {
          if (await fs.exists(plan.moveTo)) await fs.deleteFile(plan.moveTo)
          if (!(await fs.exists(plan.path))) await fs.writeFile(plan.path, plan.next)
        },
      })
      await fs.renameFile(plan.path, plan.moveTo)
      return
    }
  }
}

async function planAdd(
  op: Extract<PatchOp, { kind: "add" }>,
  fs: PatchReadPort,
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
  fs: PatchReadPort,
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
  fs: PatchReadPort,
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
  const { lines: workLines, trailingNewline, eol } = splitLines(original)

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

  const next = joinLines(workLines, trailingNewline, eol)

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

  const { index, tier } = locateBlock(
    workLines,
    oldBlock,
    hunk.endOfFile,
    hunk.contextHeader,
    path,
    hunkIdx,
  )
  // Splice oldBlock.length lines out at matchIndex, splice newBlock in.
  workLines.splice(index, oldBlock.length, ...newBlock)
  return tier
}

/**
 * D7 — resolve the `@@ <header>` jump anchor to a search-floor index.
 *
 * Returns the index of the line JUST AFTER the LAST line whose trimmed text
 * equals the trimmed header, so the subsequent block search is scoped to the
 * region following that anchor (Codex's `@@ class Foo` jump semantics). When the
 * header is absent OR matches no line we return `0` — a whole-file search,
 * byte-identical to the pre-D7 behaviour (STRICTLY ADDITIVE). We match the LAST
 * occurrence so a header like `@@ class B {` jumps past an earlier `class A`
 * body that may coincidentally share lines.
 */
function resolveAnchorFloor(workLines: string[], contextHeader: string | undefined): number {
  if (contextHeader === undefined) return 0
  const needle = contextHeader.trim()
  if (needle === "") return 0
  let floor = 0
  for (let i = 0; i < workLines.length; i++) {
    if ((workLines[i] ?? "").trim() === needle) floor = i + 1
  }
  return floor
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
  contextHeader: string | undefined,
  path: string,
  hunkIdx: number,
): { index: number; tier: FuzzyTier } {
  // The EOF anchor is trailing-aligned (single candidate position), so a `@@`
  // jump header cannot further constrain it — leave that path untouched.
  if (endOfFile) return locateEofBlock(workLines, oldBlock, path, hunkIdx)

  // D7: when an `@@ <header>` is present, scope the tier search to lines after
  // the header. Absent / unmatched header ⇒ floor 0 ⇒ whole-file (byte-ident).
  const floor = resolveAnchorFloor(workLines, contextHeader)
  const scoped = locateFromFloor(workLines, oldBlock, floor, path, hunkIdx)
  if (scoped !== null) return scoped

  // D7 zero-hit fallback: the scoped search found NOTHING (both tiers null).
  // This happens when the block's own first line coincides with the `@@` header
  // (the floor skipped past it) or the block precedes the anchor. Retry the
  // whole file so an `@@` patch is never WORSE than a header-less one — strictly
  // additive. A multi-match AMBIGUITY in the scoped pass throws (not null), so it
  // does NOT reach here; only a genuine zero-hit falls back. Skip when floor is
  // already 0 (the scoped pass WAS the whole file).
  if (floor > 0) {
    const whole = locateFromFloor(workLines, oldBlock, 0, path, hunkIdx)
    if (whole !== null) return whole
  }

  throw new PatchAnchorNotFoundError(
    path,
    hunkIdx,
    "Hunk context not found (neither exact nor whitespace-tolerant match)",
  )
}

/**
 * Run the exact→trimmed tier search from a search floor. Returns the located
 * `{ index, tier }`, or `null` when BOTH tiers find zero matches (so the caller
 * can fall back). A multi-match ambiguity at either tier THROWS (it does not
 * return null) — the anchor narrowed the region but the block is still
 * non-unique, which is a real failure the caller must not paper over.
 */
function locateFromFloor(
  workLines: string[],
  oldBlock: string[],
  floor: number,
  path: string,
  hunkIdx: number,
): { index: number; tier: FuzzyTier } | null {
  const exact = locateAtTier(workLines, oldBlock, /*trimmed*/ false, "exact", floor, path, hunkIdx)
  if (exact !== null) return { index: exact, tier: "exact" }
  const trimmed = locateAtTier(
    workLines,
    oldBlock,
    /*trimmed*/ true,
    "whitespace-tolerant",
    floor,
    path,
    hunkIdx,
  )
  if (trimmed !== null) return { index: trimmed, tier: "whitespace" }
  return null
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
 *
 * GAP A (ADR-0456 mirror of `@/tool/edit/fuzzy.ts#tryScoredCandidate`): on the
 * TRIMMED tier, before throwing on a 2+-match ambiguity we run a deterministic
 * scored-candidate decisive-best tie-break (see {@link decisiveScoredIndex}).
 * If exactly one candidate window's verbatim-exact-line count STRICTLY beats
 * every other, we apply there; a tie at the top keeps today's ambiguous throw
 * (fail-closed). The EXACT tier is UNCHANGED — its 2+-match ambiguity always
 * throws, because every exact window scores `oldBlock.length` (a guaranteed tie
 * that the discriminator rejects anyway), so reusing it would never change the
 * exact path while still risking a misapply; we keep it strictly off-limits.
 */
function locateAtTier(
  workLines: string[],
  oldBlock: string[],
  trimmed: boolean,
  tierLabel: string,
  floor: number,
  path: string,
  hunkIdx: number,
): number | null {
  const hits = findAllMatches(workLines, oldBlock, trimmed, floor)
  if (hits.length === 0) return null
  if (hits.length > 1) {
    // ADR-0456 safety net — ONLY for the trimmed tier (the exact tier's
    // multi-match is an unrecoverable verbatim tie). Recover the apply IFF a
    // single candidate is the strict verbatim-exact best; otherwise fall through
    // to the ambiguous throw, byte-identical to the pre-fix behaviour.
    if (trimmed) {
      const decisive = decisiveScoredIndex(workLines, oldBlock, hits)
      if (decisive !== null) return decisive
    }
    throw new PatchApplyError(
      `Ambiguous context — ${hits.length} ${tierLabel} matches for hunk; provide more context`,
      path,
      hunkIdx,
    )
  }
  const idx = hits[0]
  return idx ?? null
}

/**
 * Score one candidate window (starting at `start`) against `oldBlock`: the COUNT
 * of positions where `workLines[start + k]` equals `oldBlock[k]` VERBATIM
 * (character-for-character), NOT merely after trimming. This is a pure
 * MEASUREMENT — an integer count of an observable property (how many lines the
 * model typed byte-exactly) — with no tunable threshold, no decay, no ratio.
 * Every candidate already matches `oldBlock` under the trimmed projection (that
 * is why it is a hit); the verbatim count tie-breaks them by literal fidelity.
 * Mirrors `@/tool/edit/fuzzy.ts#exactAnchorScore`.
 */
function verbatimScore(workLines: string[], oldBlock: string[], start: number): number {
  let exact = 0
  for (let k = 0; k < oldBlock.length; k++) {
    if (workLines[start + k] === oldBlock[k]) exact++
  }
  return exact
}

/**
 * GAP A — ADR-0456 decisive-best discriminator over the ambiguous trimmed-tier
 * candidate start indices. Returns the UNIQUE index whose {@link verbatimScore}
 * STRICTLY beats every other candidate's score; returns `null` when there is no
 * strict winner (a tie at the maximum), preserving today's ambiguous-throw
 * (fail-closed) behaviour. This is a strict-ordering discriminator, not a fudge
 * threshold: the rule is "unique strict maximum or fail". The bias is
 * deliberately toward the false-negative (fail, ask the model to retry) over the
 * false-positive (apply to the wrong window), the cardinal sin. Identical bias
 * and algorithm to `@/tool/edit/fuzzy.ts#tryScoredCandidate`.
 */
function decisiveScoredIndex(
  workLines: string[],
  oldBlock: string[],
  hits: number[],
): number | null {
  if (hits.length < 2) return null
  const scored = hits.map((start) => ({ start, score: verbatimScore(workLines, oldBlock, start) }))
  let best = scored[0] as { start: number; score: number }
  let runnerUp: { start: number; score: number } | undefined
  for (const c of scored.slice(1)) {
    if (c.score > best.score) {
      runnerUp = best
      best = c
    } else if (runnerUp === undefined || c.score > runnerUp.score) {
      runnerUp = c
    }
  }
  // DECISIVE-best rule: the top score must STRICTLY beat the runner-up. A tie at
  // the maximum (best.score === runnerUp.score) is NOT decisive ⇒ return null so
  // the caller throws ambiguous (fail-closed). `runnerUp` is always defined here
  // (hits.length >= 2), but the guard keeps the discriminator total.
  if (runnerUp === undefined || best.score <= runnerUp.score) return null
  return best.start
}

/** All indices >= `floor` where `oldBlock` matches in `workLines`. `floor` is
 *  the D7 anchor search-floor (0 = whole file). */
function findAllMatches(
  workLines: string[],
  oldBlock: string[],
  trimmed: boolean,
  floor: number,
): number[] {
  const hits: number[] = []
  const last = workLines.length - oldBlock.length
  for (let i = floor; i <= last; i++) {
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
 * Split file content into lines (F1). EOL-aware: detects the file's dominant
 * terminator (CRLF vs LF — SSOT in `@/shared/eol`) and splits EOL-agnostically
 * (`/\r?\n/`) so each work line is stored WITHOUT its trailing `\r`. Because the
 * parser also strips trailing `\r` from patch lines, the EXACT match tier now
 * lines up on a CRLF file (a strict improvement — telemetry reports `"exact"`
 * not `"whitespace"`) instead of every CRLF hunk degrading to the trimmed tier
 * and re-emitting LF (mixed-EOL corruption).
 *
 * Preserves whether the file ended with a trailing newline so we can faithfully
 * reassemble. We do NOT keep an empty trailing-array element — `trailingNewline`
 * carries that information — and the detected `eol` is returned so {@link
 * joinLines} re-appends the file's native terminator.
 */
function splitLines(content: string): {
  lines: string[]
  trailingNewline: boolean
  eol: EolStyle
} {
  const eol = detectEol(content)
  if (content.length === 0) return { lines: [], trailingNewline: false, eol }
  // A trailing terminator is any final `\n` (LF) or `\r\n` (CRLF). Strip the
  // ACTUAL trailing terminator (not the detected dominant one) so a mixed-EOL
  // file whose last line ends in a lone `\n` is not over-sliced.
  const trailingNewline = content.endsWith("\n")
  const trailingLen = content.endsWith("\r\n") ? 2 : trailingNewline ? 1 : 0
  const body = trailingLen > 0 ? content.slice(0, -trailingLen) : content
  return { lines: splitEolAware(body), trailingNewline, eol }
}

/** Rejoin work lines with the file's native EOL and re-append the trailing
 *  terminator (also native) when the original file had one. */
function joinLines(lines: string[], trailingNewline: boolean, eol: EolStyle): string {
  const joined = joinWithEol(lines, eol)
  return trailingNewline ? `${joined}${eol}` : joined
}
