/**
 * ADR-0068 Wave B — 3-file atomic writer for the Phase 2 consolidator.
 *
 * Owns the on-disk side of Phase 2:
 *
 *   1. `ensureDir()` — creates `~/.quanta/memory/` with chmod 0700 and
 *      (when enabled) `git init` + local user.name/email.  Idempotent.
 *   2. `readExisting()` — surfaces prior MEMORY.md / raw_memories.md /
 *      memory_summary.md content (or null when absent).  Feeds back into
 *      the Phase 2 LLM so user manual edits survive consolidation.
 *   3. `writeAtomic()` — the load-bearing primitive.  Writes all three
 *      files in a temp-then-rename dance so an interrupted run never
 *      leaves a half-baked memory tree.  Then (when git is enabled)
 *      commits the change and reports the SHA.
 *
 * Atomicity model (deterministic, no heuristics):
 *
 *     temp.MEMORY.md.tmp.<pid>.<ts>       ←─┐
 *     temp.raw_memories.md.tmp.<pid>.<ts>   ├─ Phase A: write 3 temp files
 *     temp.memory_summary.md.tmp.<pid>.<ts> ←─┘
 *
 *     rename(temp.MEMORY.md → MEMORY.md)               ←─┐
 *     rename(temp.raw_memories.md → raw_memories.md)     ├─ Phase B: 3 renames (POSIX-atomic)
 *     rename(temp.memory_summary.md → memory_summary.md) ←─┘
 *
 *     git add . && git commit -m "..."                  ←── Phase C: durable history
 *
 * If any Phase A step throws, every already-written temp file is
 * best-effort unlinked (ENOENT swallowed; other unlink errors swallowed
 * to avoid masking the original cause — the caller sees the real error).
 * If a Phase B rename throws, we again best-effort clean up surviving
 * temps; the writer surfaces the original throw.  A Phase C git failure
 * is surfaced as a {@link MemoryWriteError} carrying stderr.
 *
 * Negative invariants:
 *   1. No silent truncation.  Caps (MEMORY_MAX_BYTES /
 *      MEMORY_SUMMARY_MAX_BYTES) are pre-checked and throw
 *      {@link MemoryWriteError} BEFORE any temp file is written.
 *      raw_memories.md is unbounded by design.
 *   2. No fallback path — gitEnabled=true and a `git commit` failure
 *      AFTER renames (rare, e.g. user-installed pre-commit hook
 *      rejecting our payload) becomes a hard error so the watermark is
 *      not advanced.  Operator must fix the hook.
 *   3. NodeFsLike is a port — every fs primitive is injectable so unit
 *      tests do not touch disk.  Integration tests bind it to
 *      `node:fs/promises`.
 */
import { errMessage } from "@/shared"
import { MEMORY_DIR_MODE, MEMORY_MAX_BYTES, MEMORY_SUMMARY_MAX_BYTES } from "./constants"
import type { GitPort } from "./git"
import { type MemoryDirPaths, MemoryWriteError } from "./types"

/** Testable subset of `node:fs/promises`.  Hand-rolled rather than
 *  inheriting the real module so a unit-test fake (Map<path, string>)
 *  can implement exactly the surface the writer uses. */
export interface NodeFsLike {
  mkdir(p: string, options: { recursive: true; mode?: number }): Promise<string | undefined>
  chmod(p: string, mode: number): Promise<void>
  readFile(p: string, encoding: "utf8"): Promise<string>
  writeFile(p: string, content: string, encoding: "utf8"): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(p: string): Promise<void>
  access(p: string): Promise<void>
}

/** Constructor options.  `gitEnabled=false` swaps in a NullGitPort
 *  externally and disables Phase C entirely (gitCommitSha is null). */
export interface MemoryWriterOptions {
  /** Defaults to `true`. `false` skips Phase C (gitCommitSha is null). */
  readonly gitEnabled?: boolean
  /** Injected clock so unit tests get deterministic temp-file suffixes
   *  (`.tmp.<pid>.<now()>`). Defaults to {@link Date.now}. */
  readonly now?: () => number
}

/** Payload accepted by {@link MemoryWriter.writeAtomic}.  Three files in
 *  one shot — atomicity is per-call, not per-file.  Cap enforcement
 *  happens BEFORE any side effect. */
export interface MemoryWriteContent {
  readonly memoryMd: string
  readonly rawMemoriesMd: string
  readonly memorySummaryMd: string
}

/** Result of a successful writeAtomic.  `gitCommitSha` is null when
 *  gitEnabled is false OR when the commit produced no change (clean
 *  tree — happens on a re-run with byte-identical output). */
export interface MemoryWriteResult {
  readonly gitCommitSha: string | null
}

/** ENOENT classification helper.  Both Bun's promises layer and the
 *  classic Node layer use `code === 'ENOENT'`; some test fakes throw
 *  plain Error("ENOENT...") so we also match by message prefix as a
 *  defensive last resort. */
const isENOENT = (err: unknown): boolean => {
  if (err === null || typeof err !== "object") return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === "ENOENT") return true
  if (typeof e.message === "string" && e.message.startsWith("ENOENT")) {
    return true
  }
  return false
}

/** Build the temp-file path for a given final-path target.  Format is
 *  `<final>.tmp.<pid>.<now>` so concurrent writers (theoretically:
 *  two Phase 2 runs racing in different processes — Codex prevents this
 *  via per-DB lock) never clash. */
const tempPathFor = (finalPath: string, pid: number, now: number): string =>
  `${finalPath}.tmp.${pid}.${now}`

/** 3-file atomic writer.  Construct ONCE per Phase 2 run (cheap — just
 *  holds bound ports).  Methods are independent; the writer is
 *  stateless beyond its constructor args. */
export class MemoryWriter {
  constructor(
    public readonly paths: MemoryDirPaths,
    private readonly fs: NodeFsLike,
    private readonly git: GitPort,
    private readonly opts: MemoryWriterOptions = {},
  ) {}

  /** Idempotent setup.  mkdir(recursive) then chmod 0700 then (if
   *  enabled) `git init` when no repo exists yet.  Errors propagate —
   *  ensureDir is a precondition of every other writer method and a
   *  silent failure here would corrupt downstream invariants. */
  async ensureDir(): Promise<void> {
    try {
      await this.fs.mkdir(this.paths.root, {
        recursive: true,
        mode: MEMORY_DIR_MODE,
      })
    } catch (err) {
      throw new MemoryWriteError(`mkdir failed: ${errMessage(err)}`, this.paths.root)
    }
    // chmod is separate from mkdir's `mode` because the `mode` option
    // is only applied at CREATE time — an existing dir keeps its prior
    // mode.  We re-apply unconditionally so a permissive pre-existing
    // dir gets tightened on every run.
    try {
      await this.fs.chmod(this.paths.root, MEMORY_DIR_MODE)
    } catch (err) {
      throw new MemoryWriteError(`chmod failed: ${errMessage(err)}`, this.paths.root)
    }
    if (this.opts.gitEnabled ?? true) {
      const already = await this.git.isRepo(this.paths.root)
      if (!already) {
        await this.git.init(this.paths.root)
      }
    }
  }

  /** Read prior content for all three files.  Returns `null` per-slot
   *  for missing files (ENOENT).  Non-ENOENT failures propagate as
   *  {@link MemoryWriteError}. */
  async readExisting(): Promise<{
    memoryMd: string | null
    rawMemoriesMd: string | null
    memorySummaryMd: string | null
  }> {
    const memoryMd = await this.readMaybe(this.paths.memoryMd)
    const rawMemoriesMd = await this.readMaybe(this.paths.rawMemoriesMd)
    const memorySummaryMd = await this.readMaybe(this.paths.memorySummaryMd)
    return { memoryMd, rawMemoriesMd, memorySummaryMd }
  }

  /** Read or return null on ENOENT.  Internal helper for
   *  {@link readExisting}. */
  private async readMaybe(p: string): Promise<string | null> {
    try {
      return await this.fs.readFile(p, "utf8")
    } catch (err) {
      if (isENOENT(err)) return null
      throw new MemoryWriteError(`readFile failed: ${errMessage(err)}`, p)
    }
  }

  /** Atomic 3-file write.  See module-level comment for the full
   *  algorithm.  Returns `{ gitCommitSha }`; `gitCommitSha` is `null`
   *  when git is disabled or the commit was a no-op. */
  async writeAtomic(content: MemoryWriteContent): Promise<MemoryWriteResult> {
    // Phase 0 — cap enforcement.  Throw BEFORE any side effect so a
    // bad LLM output cannot leave temp files lying around.
    const memBytes = Buffer.byteLength(content.memoryMd, "utf8")
    if (memBytes > MEMORY_MAX_BYTES) {
      throw new MemoryWriteError(
        `MEMORY.md ${memBytes} bytes exceeds MEMORY_MAX_BYTES (${MEMORY_MAX_BYTES})`,
        this.paths.memoryMd,
      )
    }
    const summaryBytes = Buffer.byteLength(content.memorySummaryMd, "utf8")
    if (summaryBytes > MEMORY_SUMMARY_MAX_BYTES) {
      throw new MemoryWriteError(
        `memory_summary.md ${summaryBytes} bytes exceeds MEMORY_SUMMARY_MAX_BYTES (${MEMORY_SUMMARY_MAX_BYTES})`,
        this.paths.memorySummaryMd,
      )
    }
    // raw_memories.md: NO cap.  Append-only Phase 1 ingestion trail.

    // Build the 3 temp paths with one shared (pid, now) tuple so a
    // grep on the directory after a crash identifies an aborted Phase 2
    // run as a single cohort.
    const pid = process.pid
    const ts = (this.opts.now ?? Date.now)()
    const tempMemory = tempPathFor(this.paths.memoryMd, pid, ts)
    const tempRaw = tempPathFor(this.paths.rawMemoriesMd, pid, ts)
    const tempSummary = tempPathFor(this.paths.memorySummaryMd, pid, ts)

    // Phase A — write 3 temps.  Track which succeeded for cleanup on
    // failure of a later step.
    const writtenTemps: string[] = []
    try {
      await this.fs.writeFile(tempMemory, content.memoryMd, "utf8")
      writtenTemps.push(tempMemory)
      await this.fs.writeFile(tempRaw, content.rawMemoriesMd, "utf8")
      writtenTemps.push(tempRaw)
      await this.fs.writeFile(tempSummary, content.memorySummaryMd, "utf8")
      writtenTemps.push(tempSummary)
    } catch (err) {
      await this.cleanupTemps(writtenTemps)
      throw new MemoryWriteError(`temp write failed: ${errMessage(err)}`, this.paths.root)
    }

    // Phase B — 3 renames.  Ordered (memory → raw → summary).  POSIX
    // rename is atomic within a filesystem; the renames themselves are
    // sequenced so a partial failure leaves the writer in a known state
    // (some renames done, others not — the surviving temps are cleaned
    // up best-effort so the next run is not confused).
    const remainingTemps = [...writtenTemps]
    try {
      await this.fs.rename(tempMemory, this.paths.memoryMd)
      remainingTemps.shift()
      await this.fs.rename(tempRaw, this.paths.rawMemoriesMd)
      remainingTemps.shift()
      await this.fs.rename(tempSummary, this.paths.memorySummaryMd)
      remainingTemps.shift()
    } catch (err) {
      await this.cleanupTemps(remainingTemps)
      throw new MemoryWriteError(`rename failed: ${errMessage(err)}`, this.paths.root)
    }

    // Phase C — git commit (when enabled).
    if (this.opts.gitEnabled ?? true) {
      const message = `consolidate ${new Date(ts).toISOString()}`
      try {
        const sha = await this.git.addCommit(this.paths.root, message)
        return { gitCommitSha: sha }
      } catch (err) {
        // The renames already landed — surface a precise error message
        // so the caller knows the disk state is consistent but the
        // history is missing (watermark must NOT advance, see
        // runPhase2()).
        throw new MemoryWriteError(
          `rename succeeded but git commit failed: ${errMessage(err)}`,
          this.paths.root,
        )
      }
    }
    return { gitCommitSha: null }
  }

  /** Best-effort temp cleanup.  ENOENT is swallowed because a partially-
   *  written temp may not exist; other errors are swallowed to avoid
   *  masking the original failure (the writer's contract is that the
   *  thrown error reflects the FIRST failure, not the cleanup ones). */
  private async cleanupTemps(paths: ReadonlyArray<string>): Promise<void> {
    for (const p of paths) {
      try {
        await this.fs.unlink(p)
      } catch (err) {
        if (isENOENT(err)) continue
        // Swallow non-ENOENT cleanup failures by design (see above).
        // We do NOT log here — observability is the caller's job and
        // logging from a library primitive would couple this slice to
        // the telemetry layer.
      }
    }
  }
}
