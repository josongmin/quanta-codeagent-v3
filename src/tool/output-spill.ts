import { randomUUID } from "node:crypto"
import { readdirSync, rmSync, statSync } from "node:fs"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { errMessage, logger } from "@/shared"

/**
 * Oversized tool-output spill — Phase 1 absorption of Claude Code v2's
 * `replaceOversizedResults` / `replaceOversizedImpl` content-replacement pass.
 *
 * CC enforces a per-message tool_result budget (`persistedOutputCap = 200000`,
 * see analysis/agent-loop-message-normalization.md §2.2): when a tool_result
 * exceeds the cap it persists the original to disk
 * (`.claude/tool-results/<toolUseId>.{txt|json}`) and substitutes a
 * `<persisted-output>…</persisted-output>` placeholder (`MYH`) whose body wraps
 * `DYH`'s `{filepath, preview, hasMore}`. We faithfully echo that wrapper here,
 * keyed off the tool output string (not a per-message byte budget) and writing
 * to `.quanta/tool-output/<uuid>.txt`.
 */

/** Default char cap — mirrors CC's `Xc9 / persistedOutputCap = 200000`. */
export const DEFAULT_TOOL_OUTPUT_MAX = 200_000

/** Chars kept from the head of an oversized output for the preview. */
export const HEAD_CHARS = 8_000

/** Chars kept from the tail of an oversized output for the preview. */
export const TAIL_CHARS = 4_000

/**
 * Default number of most-recent spill files retained in the spill dir.
 * Each new spill prunes the directory down to (at most) this many `.txt`
 * files so `.quanta/tool-output/` cannot grow unboundedly. Overridable via
 * the `QUANTA_TOOL_OUTPUT_SPILL_KEEP` env (see {@link envSpillKeep}).
 */
export const DEFAULT_SPILL_KEEP = 50

/**
 * Resolve the effective spill-retention count: a positive integer is used
 * as-is; `0`, negative, or non-finite ⇒ {@link DEFAULT_SPILL_KEEP}.
 */
export function resolveSpillKeep(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SPILL_KEEP
  }
  return Math.floor(raw)
}

/**
 * Read the `QUANTA_TOOL_OUTPUT_SPILL_KEEP` env override. Unset / empty /
 * `0` / non-numeric ⇒ {@link DEFAULT_SPILL_KEEP}.
 */
export function envSpillKeep(env: Record<string, string | undefined>): number {
  return resolveSpillKeep(Number(env.QUANTA_TOOL_OUTPUT_SPILL_KEEP))
}

/**
 * Injectable SYNCHRONOUS filesystem surface for {@link pruneSpillDir} so tests
 * can drive GC without touching disk. Mirrors the `write` injection on
 * {@link CapToolOutputOptions}. The universal tool-result path
 * ({@link capToolOutput}) uses the async {@link SpillFsOpsAsync} surface
 * instead — this sync form remains for sync-port callers (the eviction spill
 * adapter, whose `EvictionSpillPort.persist` contract is synchronous).
 */
export interface SpillFsOps {
  /** List entry names in `dir`. */
  readdir: (dir: string) => string[]
  /** Last-modified time (ms epoch) of a path; used to rank by recency. */
  mtimeMs: (path: string) => number
  /** Remove a single file path. */
  remove: (path: string) => void
}

/**
 * Async-capable variant of {@link SpillFsOps} — every op may return a Promise
 * (jun-10 silent-failure audit #21: the universal tool-result GC must never
 * issue blocking IO on the shared web-daemon event loop). A plain sync
 * {@link SpillFsOps} is assignable to this type, so existing injections keep
 * working unchanged.
 */
export interface SpillFsOpsAsync {
  /** List entry names in `dir`. */
  readdir: (dir: string) => string[] | Promise<string[]>
  /** Last-modified time (ms epoch) of a path; used to rank by recency. */
  mtimeMs: (path: string) => number | Promise<number>
  /** Remove a single file path. */
  remove: (path: string) => void | Promise<void>
}

const defaultSpillFs: SpillFsOps = {
  readdir: (dir) => readdirSync(dir),
  mtimeMs: (path) => statSync(path).mtimeMs,
  remove: (path) => rmSync(path, { force: true }),
}

const defaultSpillFsAsync: SpillFsOpsAsync = {
  readdir: (dir) => readdir(dir),
  mtimeMs: async (path) => (await stat(path)).mtimeMs,
  remove: (path) => rm(path, { force: true }),
}

/**
 * Best-effort bounded retention for the spill directory: keep at most `keep`
 * of the most-recently-modified `*.txt` spill files, deleting the rest.
 *
 * Contract:
 * - Behavior-preserving for the under-cap path: when the dir holds `<= keep`
 *   spill files nothing is removed (no GC churn on normal use).
 * - Never throws — any fs error (missing dir, racing unlink, stat failure)
 *   is swallowed so a GC problem can never break a tool result. Returns the
 *   list of paths it removed (empty on no-op or on swallowed failure).
 */
export function pruneSpillDir(
  spillDir: string,
  keep: number,
  fs: SpillFsOps = defaultSpillFs,
): string[] {
  const limit = resolveSpillKeep(keep)
  let names: string[]
  try {
    names = fs.readdir(spillDir)
  } catch (e) {
    // The caller only prunes AFTER a successful spill write into this same dir,
    // so an unreadable dir here is a real anomaly (perm/fs fault), not the benign
    // "nothing spilled yet" case — attribute it instead of masking it as "nothing
    // to prune", which would let the dir grow unbounded in silence.
    logger.warn(`output-spill.pruneSpillDir.readdir: ${errMessage(e)}`)
    return []
  }

  const spillFiles = names.filter((n) => n.endsWith(".txt"))
  if (spillFiles.length <= limit) return []

  const ranked: Array<{ path: string; mtimeMs: number }> = []
  for (const name of spillFiles) {
    const path = join(spillDir, name)
    try {
      ranked.push({ path, mtimeMs: fs.mtimeMs(path) })
    } catch {
      // Unstattable entry (e.g. removed mid-scan): treat as oldest so it is
      // a prune candidate, never a survivor.
      ranked.push({ path, mtimeMs: Number.NEGATIVE_INFINITY })
    }
  }

  const removed: string[] = []
  for (const path of pruneCandidates(ranked, limit)) {
    try {
      fs.remove(path)
      removed.push(path)
    } catch (e) {
      // Best-effort: skip this file, keep pruning the rest — but attribute it:
      // an undeletable spill file defeats the retention bound this function
      // exists to enforce, and silence makes the growth undiagnosable.
      logger.warn(`output-spill.pruneSpillDir.remove: ${errMessage(e)}`)
    }
  }
  return removed
}

/** Shared prune POLICY: rank newest-first, return everything past the keep
 *  window. Single source so the sync and async prune surfaces cannot drift. */
function pruneCandidates(
  ranked: ReadonlyArray<{ path: string; mtimeMs: number }>,
  limit: number,
): string[] {
  return [...ranked]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(limit)
    .map((e) => e.path)
}

/**
 * Async twin of {@link pruneSpillDir} — identical semantics (same
 * {@link pruneCandidates} policy, same never-throws best-effort contract,
 * same no-op-under-limit fast path) over an awaitable fs surface. This is the
 * prune the universal tool-result path uses so GC never issues blocking IO on
 * the shared event loop (jun-10 silent-failure audit #21).
 */
export async function pruneSpillDirAsync(
  spillDir: string,
  keep: number,
  fs: SpillFsOpsAsync = defaultSpillFsAsync,
): Promise<string[]> {
  const limit = resolveSpillKeep(keep)
  let names: string[]
  try {
    names = await fs.readdir(spillDir)
  } catch (e) {
    // Same anomaly as the sync twin: prune only runs after a successful spill
    // write, so an unreadable dir is a real fault, never "nothing spilled yet".
    logger.warn(`output-spill.pruneSpillDirAsync.readdir: ${errMessage(e)}`)
    return []
  }

  const spillFiles = names.filter((n) => n.endsWith(".txt"))
  if (spillFiles.length <= limit) return []

  const ranked: Array<{ path: string; mtimeMs: number }> = []
  for (const name of spillFiles) {
    const path = join(spillDir, name)
    try {
      ranked.push({ path, mtimeMs: await fs.mtimeMs(path) })
    } catch {
      // Unstattable entry (e.g. removed mid-scan): treat as oldest so it is
      // a prune candidate, never a survivor.
      ranked.push({ path, mtimeMs: Number.NEGATIVE_INFINITY })
    }
  }

  const removed: string[] = []
  for (const path of pruneCandidates(ranked, limit)) {
    try {
      await fs.remove(path)
      removed.push(path)
    } catch (e) {
      // Best-effort: skip this file, keep pruning the rest — attributed for the
      // same reason as the sync twin (an undeletable file defeats retention).
      logger.warn(`output-spill.pruneSpillDirAsync.remove: ${errMessage(e)}`)
    }
  }
  return removed
}

export interface CapToolOutputOptions {
  /** Char cap; outputs at or below this are returned byte-identical. */
  maxChars: number
  /** Directory (created lazily) the full output is written into. */
  spillDir: string
  /**
   * Injected writer for the spill file (path, data). Defaults to a lazy
   * async mkdir + writeFile (`node:fs/promises`) — never sync IO on the
   * shared event loop. A returned Promise is AWAITED before the result is
   * produced. Override in tests to avoid IO.
   */
  write?: (path: string, data: string) => void | Promise<void>
  /**
   * Max number of most-recent spill files retained after a write. `0`,
   * negative, or non-finite ⇒ {@link DEFAULT_SPILL_KEEP}. Defaults to
   * {@link DEFAULT_SPILL_KEEP}.
   */
  spillKeep?: number
  /**
   * Injected fs surface used for the post-write GC prune. Override in tests
   * to drive retention without disk IO. Ops may return Promises (awaited);
   * plain sync {@link SpillFsOps} injections remain assignable.
   */
  spillFs?: SpillFsOpsAsync
}

export interface CapToolOutputResult {
  /** The (possibly excerpted) output to hand back to the model. */
  output: string
  /** Absolute-ish spill path written, when the output was over cap. */
  spillPath?: string
}

async function defaultWrite(path: string, data: string): Promise<void> {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")))
  if (dir) await mkdir(dir, { recursive: true })
  await writeFile(path, data)
}

/**
 * Resolve the effective cap: explicit `maxChars` ›› positive value as-is;
 * `0`, negative, or non-finite ⇒ {@link DEFAULT_TOOL_OUTPUT_MAX}. The
 * `QUANTA_TOOL_OUTPUT_MAX` env override is applied by the caller (registry)
 * so this stays pure; an env of 0/unset/invalid falls back to the default.
 */
export function resolveMaxChars(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TOOL_OUTPUT_MAX
  }
  return Math.floor(raw)
}

/**
 * Read the `QUANTA_TOOL_OUTPUT_MAX` env override. Unset / empty / `0` /
 * non-numeric ⇒ {@link DEFAULT_TOOL_OUTPUT_MAX}.
 */
export function envMaxChars(env: Record<string, string | undefined>): number {
  return resolveMaxChars(Number(env.QUANTA_TOOL_OUTPUT_MAX))
}

/**
 * If `output` exceeds `maxChars`, persist the FULL output to
 * `<spillDir>/<uuid>.txt` and return a head+tail excerpt wrapped in a
 * `<persisted-output>` marker (faithfully echoing CC's `MYH` placeholder —
 * see analysis/agent-loop-message-normalization.md §2.2). Sub-cap outputs are
 * returned byte-identical with no IO.
 *
 * Pure except for the single `write` call (injectable for tests). ASYNC end
 * to end (jun-10 silent-failure audit #21): this runs on the UNIVERSAL
 * tool-result path (`ToolRegistry.run`), shared by every session of the web
 * daemon — the spill write and the GC prune must never block the event loop.
 */
export async function capToolOutput(
  output: string,
  opts: CapToolOutputOptions,
): Promise<CapToolOutputResult> {
  const maxChars = resolveMaxChars(opts.maxChars)
  if (output.length <= maxChars) {
    return { output }
  }

  const spillPath = join(opts.spillDir, `${randomUUID()}.txt`)
  const write = opts.write ?? defaultWrite
  await write(spillPath, output)

  // Bound the spill dir so it can never grow unboundedly. Best-effort:
  // pruneSpillDirAsync never throws/rejects, so a GC failure cannot break
  // this result. Awaited (not floated) so the bound holds deterministically
  // by the time the result is produced.
  await pruneSpillDirAsync(
    opts.spillDir,
    resolveSpillKeep(opts.spillKeep),
    opts.spillFs ?? defaultSpillFsAsync,
  )

  const originalChars = output.length
  const head = output.slice(0, HEAD_CHARS)
  // Guard against head/tail overlap on small caps: never re-show head bytes.
  const tailStart = Math.max(HEAD_CHARS, originalChars - TAIL_CHARS)
  const tail = output.slice(tailStart)
  const omitted = tailStart - HEAD_CHARS

  const marker =
    `<persisted-output>\n` +
    `Output (${originalChars} chars) exceeded the ${maxChars}-char tool-result ` +
    `budget and was persisted to disk. The full output is at: ${spillPath}\n` +
    `Read that file (e.g. with the Read tool) to see the complete output.\n` +
    `Below is a ${HEAD_CHARS}-char head + ${TAIL_CHARS}-char tail excerpt ` +
    `(${omitted} chars omitted in the middle).\n` +
    `--- head ---\n` +
    `${head}\n` +
    `--- … ${omitted} chars omitted … ---\n` +
    `${tail}\n` +
    `</persisted-output>`

  return { output: marker, spillPath }
}
