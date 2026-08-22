/**
 * Cumulative-bytes sliding-window retention for JsonlRecorder files (ADR-0035).
 *
 * Source pattern: Codex `codex-logs-retention-pattern` memory — production-
 * verified after Codex jsonl logs grew to 14.8 GB in the wild. The fix
 * (here) is a tail-first cumulative-bytes walk: keep newest rows until the
 * cumulative byte tally crosses `maxCumulativeBytes`, drop the rest,
 * rewrite the file atomically.
 *
 * Hard rules baked in (RFC §§3.1, 16):
 *  - Zero new npm dep (uses only `node:fs/promises`, `node:path`).
 *  - Zero fallback: line lengths are computed strictly via
 *    `Buffer.byteLength(line, 'utf8')`. No estimate, no rounding.
 *  - Zero swallowed error: an existing `.tmp` file (from a prior aborted
 *    run) is the contract for "another writer holds it" — we throw
 *    `JsonlRecorderRetentionBusyError`, never silently delete.
 *  - Add-only seam: this file is NEW; `jsonl-recorder.ts` is unchanged.
 *    Callers reach the new functionality via `applyRetention(filePath, opts)`.
 *
 * Atomicity:
 *  1. Read file (newest-first walk).
 *  2. Write surviving lines to `<filePath>.tmp` (fresh exclusive create).
 *  3. `rename(<filePath>.tmp, <filePath>)` — atomic on POSIX, atomic
 *     within the same filesystem.
 *  4. Re-read the ORIGINAL inode (via a handle opened before the rename)
 *     and O_APPEND any rows a live writer added during (2)–(3) onto the
 *     new file — see the LOST-UPDATE GUARD comment in `applyRetention`.
 *  Crash between (2) and (3) leaves the original file intact + a `.tmp`
 *  sentinel — the next retention call will see the sentinel and refuse
 *  loudly (`JsonlRecorderRetentionBusyError`). The operator decides
 *  whether to delete the `.tmp` or investigate.
 */
import { open, readFile, rename, stat } from "node:fs/promises"

/**
 * Thrown when retention cannot proceed because a sibling `.tmp` file exists
 * (signals an aborted prior retention run, or another concurrent writer).
 * No retry, no silent skip — the operator must intervene.
 */
export class JsonlRecorderRetentionBusyError extends Error {
  readonly code = "jsonl_retention_busy"
  readonly tmpPath: string

  constructor(tmpPath: string) {
    super(
      `jsonl retention refused: sibling tmp file exists at ${tmpPath} (aborted prior run or concurrent writer); investigate and remove`,
    )
    this.name = "JsonlRecorderRetentionBusyError"
    this.tmpPath = tmpPath
  }
}

export interface ApplyRetentionOpts {
  /**
   * Maximum cumulative bytes (utf-8) to retain. MUST be a finite, positive
   * number. Caller MUST provide — no default (ADR-0035: defaults belong to
   * the policy layer, not the mechanism).
   */
  maxCumulativeBytes: number
  /**
   * When true, compute kept/dropped counts WITHOUT writing the file or
   * touching the `.tmp`. Useful for surfacing retention pressure from
   * dashboards without mutating state.
   */
  dryRun?: boolean
  /**
   * TEST-ONLY interleaving seam. Invoked exactly once, right AFTER the snapshot
   * read and BEFORE the rewrite, so a test can drive a concurrent append into
   * the read→rename window and prove the lost-update guard. Never set in
   * production. NO-OP when absent.
   */
  _afterReadForTest?: () => Promise<void>
  /**
   * TEST-ONLY interleaving seam. Invoked exactly once, AFTER the `.tmp` file is
   * written+fsynced and BEFORE the rename, so a test can drive a concurrent
   * append into the residual write→rename window and prove the post-rename
   * late-tail salvage (jun-10 silent-failure audit #20). Never set in
   * production. NO-OP when absent.
   */
  _beforeRenameForTest?: () => Promise<void>
}

export interface ApplyRetentionResult {
  /** Rows kept (newest-first). */
  keptRows: number
  /** Rows dropped (oldest-first). */
  droppedRows: number
  /** Sum of utf-8 byte lengths (excluding the trailing newline) of dropped rows. */
  droppedBytes: number
}

const TMP_SUFFIX = ".tmp"

/**
 * Apply cumulative-bytes sliding-window retention to a jsonl file.
 *
 * @param filePath Absolute (or cwd-relative) path to a jsonl file.
 * @param opts See {@link ApplyRetentionOpts}.
 * @throws {RangeError} if `maxCumulativeBytes` is not a finite, positive number.
 * @throws {JsonlRecorderRetentionBusyError} if a sibling `.tmp` file exists.
 */
export async function applyRetention(
  filePath: string,
  opts: ApplyRetentionOpts,
): Promise<ApplyRetentionResult> {
  if (!Number.isFinite(opts.maxCumulativeBytes) || opts.maxCumulativeBytes <= 0) {
    throw new RangeError(
      `applyRetention: maxCumulativeBytes must be a finite positive number; got ${opts.maxCumulativeBytes}`,
    )
  }
  const tmpPath = `${filePath}${TMP_SUFFIX}`
  if (await pathExists(tmpPath)) {
    throw new JsonlRecorderRetentionBusyError(tmpPath)
  }

  const before = await readJsonlRowsWithSize(filePath)
  if (before === undefined) {
    // Missing file → no-op (not an error).
    return { keptRows: 0, droppedRows: 0, droppedBytes: 0 }
  }
  const allRows = before.rows

  if (opts._afterReadForTest !== undefined) await opts._afterReadForTest()

  const split = splitByCap(allRows, opts.maxCumulativeBytes)
  const result: ApplyRetentionResult = {
    keptRows: split.kept.length,
    droppedRows: split.dropped.length,
    droppedBytes: split.droppedBytes,
  }

  if (opts.dryRun === true) return result
  if (split.dropped.length === 0) return result

  // LOST-UPDATE GUARD: a live writer may O_APPEND fresh rows to the file at any
  // point while we rewrite. Two windows exist:
  //  (a) snapshot-read → tail-re-read: appends land past `before.bytes` on the
  //      ORIGINAL inode. We re-read that grown tail just before the rewrite and
  //      bake it into the kept set.
  //  (b) tail-re-read → rename (the residual write+fsync+rename window): late
  //      appends still target the ORIGINAL inode, which the rename orphans. We
  //      hold a read handle opened on the original inode BEFORE the rename and
  //      re-read it AFTER the rename — repeating until it stops growing — then
  //      O_APPEND the salvaged rows onto the NEW file.
  // Real guarantee: no whole-row append by an open-per-append writer (the
  // JsonlRecorder appends via `appendFileSync`) is dropped, provided its append
  // syscall completes before our final post-rename re-check; the salvage loop
  // only ends once the orphaned inode is stable, and only writers that opened
  // the path BEFORE the rename can still reach it, so in-flight appends are
  // finite and the loop terminates. Window-(b) rows are re-appended after the
  // rename, so they may land AFTER rows a live writer already appended to the
  // new file — ordering across the rewrite boundary is best-effort; loss is
  // not. The append is atomic per POSIX O_APPEND, so every grown tail is a
  // sequence of WHOLE rows; we re-split on newline.
  await rewriteWithSalvage(filePath, tmpPath, split.kept, before.bytes, opts._beforeRenameForTest)
  return result
}

/** The lost-update-guarded rewrite described above: catch-up tail read (window
 *  a), atomic rewrite, then the post-rename late-tail salvage loop (window b)
 *  via a handle opened on the original inode BEFORE the rename. */
async function rewriteWithSalvage(
  filePath: string,
  tmpPath: string,
  splitKept: readonly string[],
  snapshotBytes: number,
  beforeRenameForTest?: () => Promise<void>,
): Promise<void> {
  let origHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    origHandle = await open(filePath, "r")
  } catch (err) {
    // Vanished file (parity with the prior path-based tail read): no original
    // inode to salvage from — proceed with the rewrite alone.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  try {
    let kept = [...splitKept]
    let consumedBytes = snapshotBytes
    if (origHandle !== undefined) {
      // Window (a): catch-up tail read, baked into the rewrite itself.
      const tail = await readAppendedTail(origHandle, consumedBytes)
      consumedBytes = tail.endByte
      if (tail.rows.length > 0) kept = [...kept, ...tail.rows]
    }

    await atomicRewrite(filePath, tmpPath, kept, beforeRenameForTest)

    if (origHandle !== undefined) {
      // Window (b): salvage rows appended to the now-orphaned original inode
      // during write+fsync+rename, looping until its size is stable.
      let late = await readAppendedTail(origHandle, consumedBytes)
      while (late.rows.length > 0) {
        consumedBytes = late.endByte
        await appendRows(filePath, late.rows)
        late = await readAppendedTail(origHandle, consumedBytes)
      }
    }
  } finally {
    if (origHandle !== undefined) await origHandle.close()
  }
}

/** Read whole rows that grew past byte offset `fromByte` on the inode behind
 *  `handle` (NOT the path — after the rename the path points at the NEW file
 *  while the handle still reaches the orphaned original). Returns the rows and
 *  the byte offset consumed (`endByte`), so successive calls resume where the
 *  previous one stopped. The trailing newline of the last row is stripped (row
 *  arrays are newline-joined on write). */
async function readAppendedTail(
  handle: Awaited<ReturnType<typeof open>>,
  fromByte: number,
): Promise<{ rows: string[]; endByte: number }> {
  const st = await handle.stat()
  if (st.size <= fromByte) return { rows: [], endByte: fromByte }
  const len = st.size - fromByte
  const buf = Buffer.alloc(len)
  await handle.read(buf, 0, len, fromByte)
  let tail = buf.toString("utf8")
  if (tail.endsWith("\n")) tail = tail.slice(0, -1)
  if (tail.length === 0) return { rows: [], endByte: st.size }
  return { rows: tail.split("\n"), endByte: st.size }
}

/** O_APPEND the salvaged rows onto `filePath` (the NEW file post-rename).
 *  Atomic per POSIX O_APPEND, so a live writer appending concurrently can
 *  interleave between rows but never tear one. */
async function appendRows(filePath: string, rows: string[]): Promise<void> {
  const handle = await open(filePath, "a")
  try {
    await handle.write(`${rows.join("\n")}\n`)
  } finally {
    await handle.close()
  }
}

/**
 * Read a jsonl file and return its row array (without the trailing empty
 * fragment from the final newline). Returns `undefined` if the file does
 * not exist (caller decides what to do).
 */
async function readJsonlRowsWithSize(
  filePath: string,
): Promise<{ rows: string[]; bytes: number } | undefined> {
  let raw: Buffer
  try {
    raw = await readFile(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
  // `bytes` is the EXACT on-disk size at snapshot time — the offset from which a
  // concurrent O_APPEND writes. Must be the byte length (not the utf-8 string
  // length) so multibyte rows do not shift the appended-tail offset.
  const bytes = raw.byteLength
  const allRows = raw.toString("utf8").split("\n")
  if (allRows.length > 0 && allRows[allRows.length - 1] === "") {
    allRows.pop()
  }
  return { rows: allRows, bytes }
}

interface SplitResult {
  kept: string[]
  dropped: string[]
  droppedBytes: number
}

/**
 * Tail-first cumulative-bytes walk. Returns the kept (newest-first
 * preserved) and dropped row sets, plus the dropped payload byte count
 * (excluding the trailing newline of each dropped row — that's a
 * caller-facing "bytes you lost" metric).
 *
 * The cap comparison uses `byteLength(row) + 1` per row so the newline
 * separating rows on disk is counted against the cap — otherwise the
 * resulting file could exceed `maxCumulativeBytes` on disk.
 */
function splitByCap(allRows: readonly string[], maxCumulativeBytes: number): SplitResult {
  let cumulative = 0
  let firstKeptIndex = allRows.length
  for (let i = allRows.length - 1; i >= 0; i--) {
    const row = allRows[i] ?? ""
    const rowBytes = Buffer.byteLength(row, "utf8") + 1
    if (cumulative + rowBytes > maxCumulativeBytes) break
    cumulative += rowBytes
    firstKeptIndex = i
  }
  const dropped = allRows.slice(0, firstKeptIndex)
  const kept = allRows.slice(firstKeptIndex)
  let droppedBytes = 0
  for (const row of dropped) {
    droppedBytes += Buffer.byteLength(row, "utf8")
  }
  return { kept, dropped, droppedBytes }
}

/**
 * Atomic rewrite: write to `<file>.tmp` with O_EXCL, fsync, then rename.
 * If the tmp file is created by a racing writer between our existence
 * check and our open, `EEXIST` surfaces as `JsonlRecorderRetentionBusyError`.
 */
async function atomicRewrite(
  filePath: string,
  tmpPath: string,
  kept: string[],
  beforeRenameForTest?: () => Promise<void>,
): Promise<void> {
  const body = kept.length === 0 ? "" : `${kept.join("\n")}\n`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmpPath, "wx")
    await handle.writeFile(body, { encoding: "utf8" })
    await handle.sync()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JsonlRecorderRetentionBusyError(tmpPath)
    }
    throw err
  } finally {
    if (handle !== undefined) await handle.close()
  }
  if (beforeRenameForTest !== undefined) await beforeRenameForTest()
  await rename(tmpPath, filePath)
}

/**
 * Convenience for tests / dashboards: report on-disk size and last-row
 * timestamp without applying retention. Returns 0/undefined for missing
 * files (not an error — file may simply not exist yet).
 */
export async function inspectRetentionState(filePath: string): Promise<{
  fileBytes: number
  rowCount: number
}> {
  try {
    const st = await stat(filePath)
    const raw = await readFile(filePath, "utf8")
    const rows = raw.split("\n").filter((l) => l.length > 0)
    return { fileBytes: st.size, rowCount: rows.length }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { fileBytes: 0, rowCount: 0 }
    }
    throw err
  }
}

// =============================================================================
// Internal helpers (not exported).
// =============================================================================

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}
