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

  const allRows = await readJsonlRows(filePath)
  if (allRows === undefined) {
    // Missing file → no-op (not an error).
    return { keptRows: 0, droppedRows: 0, droppedBytes: 0 }
  }

  const split = splitByCap(allRows, opts.maxCumulativeBytes)
  const result: ApplyRetentionResult = {
    keptRows: split.kept.length,
    droppedRows: split.dropped.length,
    droppedBytes: split.droppedBytes,
  }

  if (opts.dryRun === true) return result
  if (split.dropped.length === 0) return result

  await atomicRewrite(filePath, tmpPath, split.kept)
  return result
}

/**
 * Read a jsonl file and return its row array (without the trailing empty
 * fragment from the final newline). Returns `undefined` if the file does
 * not exist (caller decides what to do).
 */
async function readJsonlRows(filePath: string): Promise<string[] | undefined> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
  const allRows = raw.split("\n")
  if (allRows.length > 0 && allRows[allRows.length - 1] === "") {
    allRows.pop()
  }
  return allRows
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
async function atomicRewrite(filePath: string, tmpPath: string, kept: string[]): Promise<void> {
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
