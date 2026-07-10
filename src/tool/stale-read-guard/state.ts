/**
 * Stale-read-guard — the pure ReadFileState + the write-time freshness check
 * + the post-bash stale detector (ADR-0474).
 *
 * WHAT:
 *   - {@link ReadFileState}: a `Map<path, mtimeMs>` recorded at READ time, with
 *     `record(path, mtimeMs)` and `checkFresh(path, currentMtimeMs)`.
 *   - {@link guardWrite}: a Result-shaped gate the write/edit tool calls BEFORE
 *     writing — `err(StaleReadError)` when the target is stale, `ok()` otherwise.
 *   - {@link staleAfterBash}: pure detector that, given the read-state, the
 *     files whose mtime changed during a bash run, and the bash command, returns
 *     the subset of read files that are now stale (only when the command matched
 *     a {@link WRITE_COMMAND_MARKERS} marker).
 *
 * ADR: ADR-0474.
 * Slices imported: `@/shared` (Result/ok/err) + this slice's `types`/`markers`.
 * NO `@/storage` — the host supplies real mtimes (FileSystemPort at integration).
 * NO-THROW: every method/function returns a value, never throws.
 *
 * DEFAULT-OFF: this module performs NO env reads and NO gating itself; the host
 * checks {@link staleReadGuardEnabled} (see ./gate) before constructing/calling
 * any of this. An unset deployment never instantiates the state ⇒ byte-identical.
 */

import { byteCompare, err, ok, type Result } from "@/shared"
import { isWriteCommand } from "./markers"
import { type Freshness, StaleReadError } from "./types"

/** A path + its recorded read-time mtime. Used by {@link staleAfterBash}'s
 *  changed-file input shape. */
export interface MtimeObservation {
  readonly path: string
  /** Filesystem mtime in epoch milliseconds, as the host's FileSystemPort
   *  reports it (`stat().mtimeMs`). */
  readonly currentMtimeMs: number
}

/**
 * Hard cap on the number of distinct `(path, offset, limit)` ranges the H9 dedup
 * map retains. The dedup map is a PURE OPTIMIZATION (a missing entry only forces
 * the read tool to render full content — never a correctness change), so over a
 * long run an agent that reads a million DISTINCT windows must not grow this map
 * without bound. Once the cap is reached we evict the OLDEST inserted key (FIFO —
 * `Map` preserves insertion order) before admitting the new one, so the map size
 * is bounded by this constant regardless of how many distinct ranges are read.
 *
 * 8192 distinct ranges is far more than any single turn's working set yet bounds
 * the map to a few hundred KB. NOT a magic number sprinkled inline — it is the
 * one named bound, overridable per-instance via the {@link ReadFileState}
 * constructor for tests / host tuning.
 */
export const DEFAULT_RANGE_DEDUP_CAP = 8192

/**
 * Pure, in-memory record of the mtime each file carried when the agent last
 * READ it. One instance per agent run (lives on ToolContext at integration).
 *
 * Path identity: the caller MUST pass an already-canonical absolute path (the
 * host's fs-jail resolves before recording). This module does NOT normalize —
 * it compares paths byte-for-byte so that the read tool and the write/edit tool
 * agree only when they reference the literally same resolved path.
 */
export class ReadFileState {
  private readonly mtimes = new Map<string, number>()

  /**
   * H9 read-side dedup (additive, ORTHOGONAL to the freshness `mtimes` above).
   *
   * Keyed by `(path, offset, limit)` RANGE → a CONTENT HASH of the file's text
   * as read when that EXACT range was last read (UUX-6-07 content-truth: the
   * value used to be the read-time mtime, but an mtime-preserving content
   * rewrite then served a stale `file_unchanged` verdict — the hash of the
   * just-read bytes can never lie; the read tool reads the file EVERY time
   * anyway, since the dedup saves TOKENS, not disk IO). The freshness map keys
   * on path ALONE (a write to ANY part of a read file is a clobber); the dedup
   * map must key on the RANGE so a re-read of a DIFFERENT window is NOT
   * mistaken for an identical re-read. Kept SEPARATE so neither map's
   * semantics leak into the other — `record`/`checkFresh`/`paths` are
   * byte-identical to pre-H9.
   *
   * LAZILY allocated: stays `undefined` until the first `recordReadRange` call,
   * so a deployment that never opts into H9 (the read tool only calls these
   * methods when `runtimeConfig().readDedup` is on) pays ZERO extra allocation.
   *
   * BOUNDED: capped at {@link rangeDedupCap} entries with FIFO eviction (see
   * {@link recordReadRange}) so a long run reading unboundedly many DISTINCT
   * ranges cannot grow this map without limit.
   */
  private rangeHashes: Map<string, string> | undefined

  /** The cap on {@link rangeHashes}. Injected (defaults to
   *  {@link DEFAULT_RANGE_DEDUP_CAP}) so tests can drive the eviction path with a
   *  tiny bound and the host can tune it — never a hardcoded inline magic value. */
  private readonly rangeDedupCap: number

  /** @param rangeDedupCap max distinct ranges the H9 dedup map retains (FIFO
   *  eviction past it). Must be ≥ 1; a non-positive value is clamped to 1 so the
   *  map can always hold the just-recorded entry. */
  constructor(rangeDedupCap: number = DEFAULT_RANGE_DEDUP_CAP) {
    this.rangeDedupCap = rangeDedupCap >= 1 ? Math.floor(rangeDedupCap) : 1
  }

  /** Record (or overwrite) the mtime observed when `path` was read. A re-read
   *  refreshes the baseline — that is exactly the corrective action the stale
   *  message asks for. */
  record(path: string, mtimeMs: number): void {
    this.mtimes.set(path, mtimeMs)
  }

  /** H9 — the canonical dedup key for a `(path, offset, limit)` range. The
   *  `\x00` (NUL) separator can never appear in a numeric component and is
   *  vanishingly unlikely in a resolved absolute path, so the joined key is
   *  unambiguous (two distinct ranges never collide onto one key). `offset` and
   *  `limit` are the RESOLVED effective values (after the read tool applies its
   *  defaults), so two calls that resolve to the same window share a key even
   *  if one spelled `limit` implicitly. */
  private static rangeKey(path: string, offset: number, limit: number): string {
    return `${path}\x00${offset}\x00${limit}`
  }

  /** H9 — record (or overwrite) the CONTENT HASH of the text read for the
   *  EXACT `(path, offset, limit)` range. The hash is an opaque string the
   *  CALLER computes over the just-read content (this pure slice does no
   *  hashing itself — the read tool owns the digest choice); equality of two
   *  recorded hashes ⇔ the model already holds byte-identical content.
   *  Allocates the dedup map on first use (see {@link rangeHashes}). NO-THROW.
   *  ORTHOGONAL to {@link record} — callers that want write-blocking freshness
   *  still call `record` too. */
  recordReadRange(path: string, offset: number, limit: number, contentHash: string): void {
    this.rangeHashes ??= new Map<string, string>()
    const map = this.rangeHashes
    const key = ReadFileState.rangeKey(path, offset, limit)
    // Re-recording an existing key must REFRESH (not grow): delete-then-set so the
    // key also moves to the FIFO tail (most-recently-used survives eviction).
    map.delete(key)
    map.set(key, contentHash)
    // FIFO eviction once past the cap — `Map` iterates in insertion order, so the
    // first key is the oldest. The dedup map is a pure optimization (an evicted
    // entry only forces a full re-render, never a wrong result), so dropping the
    // oldest is always safe. Loop (not a single delete) to stay bounded even if a
    // smaller cap is injected mid-life.
    while (map.size > this.rangeDedupCap) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /** H9 — the recorded content hash for the EXACT `(path, offset, limit)`
   *  range, or `undefined` when that range was never read this run (or the
   *  dedup map was never allocated). A return that === the hash of the
   *  JUST-READ content is the dedup short-circuit signal (the model already
   *  holds these exact bytes); ANY difference (content changed — even with a
   *  preserved mtime — different range, never read) yields a
   *  non-matching/`undefined` value and the caller renders full content.
   *  NO-THROW. */
  recordedRangeHash(path: string, offset: number, limit: number): string | undefined {
    return this.rangeHashes?.get(ReadFileState.rangeKey(path, offset, limit))
  }

  /** Has `path` been read (and thus has a freshness baseline) in this run? */
  has(path: string): boolean {
    return this.mtimes.has(path)
  }

  /** The recorded read-time mtime for `path`, or undefined if never read. */
  recordedMtime(path: string): number | undefined {
    return this.mtimes.get(path)
  }

  /** Drop `path`'s baseline (e.g. after the file is deleted). NO-THROW. */
  forget(path: string): void {
    this.mtimes.delete(path)
  }

  /** Every path with a recorded read-time baseline this run. Used by the
   *  post-bash detector to re-stat the files the agent has read and find the
   *  ones a build/format command just rewrote. NO-THROW. */
  paths(): readonly string[] {
    return [...this.mtimes.keys()]
  }

  /**
   * Compare the current on-disk mtime against the recorded read-time mtime.
   *   - never read           → `{kind:"unread"}` (no baseline; caller allows)
   *   - current === recorded → `{kind:"fresh"}`
   *   - current  >  recorded → `{kind:"stale", ...}` (externally modified)
   *   - current  <  recorded → `{kind:"fresh"}` (mtime moved BACKWARD: a restore
   *       or clock-skew; we do NOT block — the agent's own copy is at least as
   *       new as disk, blocking would be a false positive; only a FORWARD move
   *       is evidence of an external write after the read).
   *
   * Strict inequality on a forward move is the closed signal (no tolerance
   * window / magic epsilon): any advance of the integer-ms mtime past the
   * recorded value is an external modification.
   */
  checkFresh(path: string, currentMtimeMs: number): Freshness {
    const recorded = this.mtimes.get(path)
    if (recorded === undefined) return { kind: "unread" }
    if (currentMtimeMs > recorded) {
      return { kind: "stale", recordedMtimeMs: recorded, currentMtimeMs }
    }
    return { kind: "fresh" }
  }
}

/**
 * Write-time gate. The write/edit tool calls this with the target path and the
 * file's CURRENT on-disk mtime (from the FileSystemPort) BEFORE applying the
 * mutation.
 *
 *   - stale  → `err(StaleReadError)` — the tool surfaces the re-read message and
 *     does NOT write.
 *   - fresh / unread → `ok()` — the tool proceeds. `unread` is allowed on
 *     purpose: a file the agent never read (e.g. a brand-new file it is creating)
 *     has no baseline and therefore cannot be "stale".
 *
 * NO-THROW: returns a Result, never throws.
 */
export const guardWrite = (
  state: ReadFileState,
  path: string,
  currentMtimeMs: number,
): Result<void, StaleReadError> => {
  const fresh = state.checkFresh(path, currentMtimeMs)
  if (fresh.kind === "stale") {
    return err(new StaleReadError(path, fresh.recordedMtimeMs, fresh.currentMtimeMs))
  }
  return ok(undefined)
}

/**
 * Post-bash stale detector. Given the read-state, the bash command that just
 * ran, and the set of files whose mtime the host observed change during the run,
 * return the read files that are now stale.
 *
 * Precision rule (BOTH conditions required):
 *   1. the command's leading token is a known {@link WRITE_COMMAND_MARKERS}
 *      marker (e.g. `bun`, `make`, `prettier`), AND
 *   2. the file was previously READ in this run AND its current mtime advanced
 *      past the recorded read-time mtime.
 *
 * A non-marker command (`git status`, `ls`, `grep`) returns `[]` even if some
 * file's mtime changed (an unrelated process) — we only warn on commands that
 * could plausibly be the cause. A marker command that touched only UNREAD files
 * also returns `[]` (nothing the agent relies on went stale).
 *
 * Result is sorted with `@/shared`'s `byteCompare` (locale-independent code-unit
 * order) for deterministic reminders. NO-THROW.
 */
export const staleAfterBash = (
  state: ReadFileState,
  command: string,
  changed: readonly MtimeObservation[],
): readonly string[] => {
  if (!isWriteCommand(command)) return []
  const stale: string[] = []
  for (const obs of changed) {
    const verdict = state.checkFresh(obs.path, obs.currentMtimeMs)
    if (verdict.kind === "stale") stale.push(obs.path)
  }
  // Deterministic order via the canonical locale-independent comparator.
  stale.sort(byteCompare)
  return stale
}
