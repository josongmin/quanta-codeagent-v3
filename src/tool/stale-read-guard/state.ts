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

  /** Record (or overwrite) the mtime observed when `path` was read. A re-read
   *  refreshes the baseline — that is exactly the corrective action the stale
   *  message asks for. */
  record(path: string, mtimeMs: number): void {
    this.mtimes.set(path, mtimeMs)
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
