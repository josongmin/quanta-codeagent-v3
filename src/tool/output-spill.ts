import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readdirSync, rmSync, type Stats, statSync } from "node:fs"
import { lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { errMessage, logger } from "@/shared"
import type {
  SpillDirRefusal,
  SpillDirRefusalKind,
  SpillDirRefusalOf,
} from "@/shared/spill-refusal-types"

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
 *
 * CONTAINMENT (NW-2, sep-14 SEC-ADV-2): `<cwd>/.quanta` belongs to whatever repo
 * the session was started in. A repo that shipped `.quanta/tool-output` (or
 * `.quanta`) as a symlink used to receive the spill write AND the keep-N `*.txt`
 * prune wherever the link pointed — prompt-free, from the read-only `read` tool.
 * Every spill now goes through {@link openSpillDirAsync} / {@link openSpillDir},
 * which create and `lstat` each component quanta owns and refuse (no write, no
 * prune) unless each one is a real directory.
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
 * `spillDir` is a {@link ContainedSpillDir}: this deletes files, so it only
 * accepts a directory {@link openSpillDir} / {@link openSpillDirAsync} verified
 * (NW-2). A plain path does not typecheck.
 *
 * Contract:
 * - Behavior-preserving for the under-cap path: when the dir holds `<= keep`
 *   spill files nothing is removed (no GC churn on normal use).
 * - Never throws — any fs error (missing dir, racing unlink, stat failure)
 *   is swallowed so a GC problem can never break a tool result. Returns the
 *   list of paths it removed (empty on no-op or on swallowed failure).
 */
export function pruneSpillDir(
  spillDir: ContainedSpillDir,
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
 * {@link ContainedSpillDir} parameter, same {@link pruneCandidates} policy, same
 * never-throws best-effort contract, same no-op-under-limit fast path) over an
 * awaitable fs surface. This is the prune the universal tool-result path uses so
 * GC never issues blocking IO on the shared event loop (jun-10 silent-failure
 * audit #21).
 */
export async function pruneSpillDirAsync(
  spillDir: ContainedSpillDir,
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

/**
 * The spill location's components under the session working directory — the
 * ONLY components quanta creates for a spill. Both production spill paths
 * (`ToolRegistry.run` and the tier-1 eviction port wired in
 * `compaction-wire.ts`) pass `join(cwd, ".quanta", "tool-output")`.
 */
const SPILL_DIR_SEGMENTS = [".quanta", "tool-output"] as const

// Why an over-budget output was not persisted: the closed refusal kinds and
// their per-kind shapes are defined in `@/shared/spill-refusal-types`, because
// the refusal travels past this slice (dispatch result, `tool_result` event,
// JSONL line). Re-exported here next to the renderers below.
export type {
  SpillDirRefusal,
  SpillDirRefusalKind,
  SpillDirRefusalOf,
} from "@/shared/spill-refusal-types"
export { SPILL_DIR_REFUSAL_KINDS } from "@/shared/spill-refusal-types"

/** Model- and log-facing reason for each refusal kind, typed per kind so a
 *  renderer reads only the fields its kind carries. */
export const SPILL_DIR_REFUSAL_REASON: {
  readonly [K in SpillDirRefusalKind]: (refusal: SpillDirRefusalOf<K>) => string
} = {
  "not-spill-location": (r) => `${r.path} is not a <working directory>/.quanta/tool-output path`,
  symlink: (r) =>
    `${r.path} is a symbolic link; tool output is only written to a real directory inside the working directory`,
  "not-a-directory": (r) => `${r.path} is not a directory`,
  unavailable: (r) => `${r.path} could not be created or inspected (${r.cause})`,
  "write-failed": (r) => `${r.path} could not be written (${r.cause})`,
}

/** Correlates the refusal's kind with its renderer (the generic keeps
 *  `SPILL_DIR_REFUSAL_REASON[kind]` and the refusal on the same `K`). */
const renderRefusal = <K extends SpillDirRefusalKind>(refusal: SpillDirRefusalOf<K>): string =>
  SPILL_DIR_REFUSAL_REASON[refusal.kind](refusal)

export const describeSpillRefusal = (refusal: SpillDirRefusal): string => renderRefusal(refusal)

/** The refusal for a spill file whose write threw or rejected after its
 *  directory was opened. Shared by {@link capToolOutput} and the eviction spill
 *  adapter so both report a failed write the same way. */
export const writeFailedRefusal = (
  path: string,
  e: unknown,
): SpillDirRefusalOf<"write-failed"> => ({
  kind: "write-failed",
  path,
  cause: errMessage(e),
})

declare const containedSpillDirBrand: unique symbol
/** A spill directory whose quanta-created components were each verified, by
 *  `lstat`, to be a real directory. Only {@link openSpillDir} /
 *  {@link openSpillDirAsync} produce one, and {@link pruneSpillDir} /
 *  {@link pruneSpillDirAsync} accept nothing else. */
export type ContainedSpillDir = string & { readonly [containedSpillDirBrand]: true }

export type SpillDirVerdict =
  | { readonly ok: true; readonly dir: ContainedSpillDir }
  | { readonly ok: false; readonly refusal: SpillDirRefusal }

/** The directory the spill components live under, or the refusal when
 *  `spillDir` is not `<root>/.quanta/tool-output`. Pure. */
const spillRoot = (spillDir: string): string | SpillDirRefusal => {
  const target = resolve(spillDir)
  let at = target
  for (let i = SPILL_DIR_SEGMENTS.length - 1; i >= 0; i--) {
    if (basename(at) !== SPILL_DIR_SEGMENTS[i]) return { kind: "not-spill-location", path: target }
    at = dirname(at)
  }
  return at
}

/** Shared component POLICY for both walkers: an `lstat` result must be a real
 *  directory. `lstat` never follows the final link, so a symlink — to a
 *  directory or dangling — is seen as itself. */
const componentRefusal = (path: string, st: Stats): SpillDirRefusal | undefined => {
  if (st.isSymbolicLink()) return { kind: "symlink", path }
  if (!st.isDirectory()) return { kind: "not-a-directory", path }
  return undefined
}

/** `mkdir` reports an existing entry — directory, file, or symlink (it never
 *  follows the final component) — as EEXIST; the `lstat` after it decides. */
const isAlreadyExists = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "EEXIST"

const ensureComponentAsync = async (path: string): Promise<Stats> => {
  try {
    await mkdir(path)
  } catch (e) {
    if (!isAlreadyExists(e)) throw e
  }
  return lstat(path)
}

const ensureComponentSync = (path: string): Stats => {
  try {
    mkdirSync(path)
  } catch (e) {
    if (!isAlreadyExists(e)) throw e
  }
  return lstatSync(path)
}

/**
 * Open the spill directory for a write + prune: create each component in
 * {@link SPILL_DIR_SEGMENTS} one level at a time (never `recursive`, so nothing
 * is ever created through a link) and `lstat` it. Components are checked in
 * order, so `tool-output` is only created once `.quanta` is known to be a real
 * directory. Never throws: an IO failure is the `unavailable` refusal.
 */
export async function openSpillDirAsync(spillDir: string): Promise<SpillDirVerdict> {
  const root = spillRoot(spillDir)
  if (typeof root !== "string") return { ok: false, refusal: root }
  let at = root
  for (const segment of SPILL_DIR_SEGMENTS) {
    at = join(at, segment)
    let st: Stats
    try {
      st = await ensureComponentAsync(at)
    } catch (e) {
      return { ok: false, refusal: { kind: "unavailable", path: at, cause: errMessage(e) } }
    }
    const refusal = componentRefusal(at, st)
    if (refusal !== undefined) return { ok: false, refusal }
  }
  return { ok: true, dir: at as ContainedSpillDir }
}

/** Sync twin of {@link openSpillDirAsync} for the synchronous eviction spill
 *  port — same {@link spillRoot} and {@link componentRefusal} policy. */
export function openSpillDir(spillDir: string): SpillDirVerdict {
  const root = spillRoot(spillDir)
  if (typeof root !== "string") return { ok: false, refusal: root }
  let at = root
  for (const segment of SPILL_DIR_SEGMENTS) {
    at = join(at, segment)
    let st: Stats
    try {
      st = ensureComponentSync(at)
    } catch (e) {
      return { ok: false, refusal: { kind: "unavailable", path: at, cause: errMessage(e) } }
    }
    const refusal = componentRefusal(at, st)
    if (refusal !== undefined) return { ok: false, refusal }
  }
  return { ok: true, dir: at as ContainedSpillDir }
}

export interface CapToolOutputOptions {
  /** Char cap; outputs at or below this are returned byte-identical. */
  maxChars: number
  /** `<cwd>/.quanta/tool-output`, the directory the full output is written
   *  into. Opened by {@link openSpillDirAsync} before any write or prune. */
  spillDir: string
  /**
   * Injected writer for the spill file (path, data), called only after the
   * spill dir was opened. Defaults to an async writeFile (`node:fs/promises`)
   * — never sync IO on the shared event loop. A returned Promise is AWAITED
   * before the result is produced; a throw or rejection is the `write-failed`
   * refusal. Override in tests to avoid the file write.
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
  /** The spill file, set only when the full output was written to it. */
  spillPath?: string
  /** Set when the output was over cap but not persisted — the spill dir was
   *  refused or the write failed. Nothing was pruned, and `output` says why. */
  spillRefusal?: SpillDirRefusal
}

async function defaultWrite(path: string, data: string): Promise<void> {
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
 * If `output` exceeds `maxChars`, open `spillDir` with {@link openSpillDirAsync},
 * write the FULL output to `<spillDir>/<uuid>.txt`, prune the directory, and
 * return a head+tail excerpt wrapped in a `<persisted-output>` marker (faithfully
 * echoing CC's `MYH` placeholder — see
 * analysis/agent-loop-message-normalization.md §2.2). Sub-cap outputs are
 * returned byte-identical with no IO.
 *
 * When the directory is refused or the write fails, nothing is pruned,
 * `spillPath` is unset, `spillRefusal` says why, and `output` is a
 * `<truncated-output>` excerpt carrying the same reason. Spill IO never makes
 * this throw.
 *
 * IO: the directory is opened with real per-component `mkdir` + `lstat` calls
 * (not injectable); the write (`write`) and the prune (`spillFs`) are
 * injectable for tests. ASYNC end to end (jun-10 silent-failure audit #21):
 * this runs on the UNIVERSAL tool-result path (`ToolRegistry.run`), shared by
 * every session of the web daemon — no spill IO may block the event loop.
 */
export async function capToolOutput(
  output: string,
  opts: CapToolOutputOptions,
): Promise<CapToolOutputResult> {
  const maxChars = resolveMaxChars(opts.maxChars)
  if (output.length <= maxChars) {
    return { output }
  }

  const opened = await openSpillDirAsync(opts.spillDir)
  if (!opened.ok) return refusedSpill(output, maxChars, opened.refusal)

  const spillPath = join(opened.dir, `${randomUUID()}.txt`)
  const write = opts.write ?? defaultWrite
  try {
    await write(spillPath, output)
  } catch (e) {
    // The same fail-closed result as a refused directory, and no prune. A
    // partly written file can remain; the next successful spill's prune bounds it.
    return refusedSpill(output, maxChars, writeFailedRefusal(spillPath, e))
  }

  // Bound the spill dir so it can never grow unboundedly. Best-effort:
  // pruneSpillDirAsync never throws/rejects, so a GC failure cannot break
  // this result. Awaited (not floated) so the bound holds deterministically
  // by the time the result is produced.
  await pruneSpillDirAsync(
    opened.dir,
    resolveSpillKeep(opts.spillKeep),
    opts.spillFs ?? defaultSpillFsAsync,
  )

  const marker =
    `<persisted-output>\n` +
    `Output (${output.length} chars) exceeded the ${maxChars}-char tool-result ` +
    `budget and was persisted to disk. The full output is at: ${spillPath}\n` +
    `Read that file (e.g. with the Read tool) to see the complete output.\n` +
    excerptLines(output) +
    `</persisted-output>`

  return { output: marker, spillPath }
}

/** Fail closed: the model gets the excerpt plus the reason the rest is gone; the
 *  operator gets the same reason in the log. */
function refusedSpill(
  output: string,
  maxChars: number,
  refusal: SpillDirRefusal,
): CapToolOutputResult {
  const reason = describeSpillRefusal(refusal)
  logger.warn(`output-spill.capToolOutput: spill refused — ${reason}`)
  const marker =
    `<truncated-output>\n` +
    `Output (${output.length} chars) exceeded the ${maxChars}-char tool-result ` +
    `budget and was NOT persisted to disk: ${reason}.\n` +
    `Only this excerpt is available; narrow the call (e.g. offset/limit or a filter) ` +
    `to see the omitted part.\n` +
    excerptLines(output) +
    `</truncated-output>`
  return { output: marker, spillRefusal: refusal }
}

/** The head + tail excerpt block shared by the persisted and the refused
 *  marker, ending in a newline. */
function excerptLines(output: string): string {
  const head = output.slice(0, HEAD_CHARS)
  // Guard against head/tail overlap on small caps: never re-show head bytes.
  const tailStart = Math.max(HEAD_CHARS, output.length - TAIL_CHARS)
  const tail = output.slice(tailStart)
  const omitted = tailStart - HEAD_CHARS
  return (
    `Below is a ${HEAD_CHARS}-char head + ${TAIL_CHARS}-char tail excerpt ` +
    `(${omitted} chars omitted in the middle).\n` +
    `--- head ---\n` +
    `${head}\n` +
    `--- … ${omitted} chars omitted … ---\n` +
    `${tail}\n`
  )
}
