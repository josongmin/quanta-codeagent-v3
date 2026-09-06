/**
 * ADR-0163 Phase D — file-based OAuth refresh lock (cross-process same-machine).
 *
 * Closed-port impl of {@link OAuthRefreshLockPort}. Mutual exclusion via the
 * filesystem: `~/.quanta/locks/{key}.lock` carries the holderId + expiresAt
 * as a JSON blob. Two processes on the same machine see the same file; the
 * loser observes the file and returns `would-wait`.
 *
 * Stale-lock recovery: at `tryAcquire` we read the existing file (if any). If
 * its `expiresAt <= clock.now()`, we treat it as released (overwrite). No
 * background reaper, no daemon — same negative invariant as InMemoryLock.
 *
 * Closed-port discipline (DIP):
 *   - `LockFileStorePort` abstracts the file I/O (test parity, no node:fs
 *     direct touch inside this module).
 *   - `ClockPort` (reused from oidc-federation) for `now()`.
 *
 * Store mutations are conditional. Stale takeover, renewal, and release all
 * compare the exact body previously read before replacing/deleting it. Without
 * that CAS contract two stale observers can both return `acquired`, or an old
 * holder can delete a newer holder's lock after a read/delete race.
 *
 * Plane-clean: imports only the port (sibling) + the leaf ClockPort. No SDK,
 * no `node:fs` direct touch.
 */

import type { ClockPort } from "../llm/oidc-federation"
import type { LockResult, OAuthRefreshLockPort } from "./oauth-refresh-lock"

/** File store port — abstracts the on-disk operations the lock needs. Tests
 *  provide an in-memory implementation; production wires `node:fs/promises`.
 *  Single-responsibility: read / write / delete / check. */
export interface LockFileStorePort {
  /** Read the lock file's JSON content, or `null` if it does not exist. */
  read(key: string): Promise<string | null>
  /** Create only when absent. */
  writeExclusive(key: string, content: string): Promise<"ok" | "exists">
  /** Replace or delete only while the exact body read by the caller is still
   * current. `null` deletes. */
  compareAndSwap(key: string, expected: string, next: string | null): Promise<"ok" | "changed">
}

interface FileLockPayload {
  readonly holderId: string
  readonly expiresAt: number
  readonly pid: number
}

/** Parse a raw lock-file body into a {@link FileLockPayload}. Returns `null`
 *  when JSON is corrupt OR shape is wrong — both surfaces are "treat as
 *  stale" at the call site. Extracted for cognitive-complexity discipline:
 *  keeps `tryAcquire` focused on the state-machine, not on parsing. */
const parseLockPayload = (raw: string): FileLockPayload | null => {
  try {
    const obj = JSON.parse(raw) as Partial<FileLockPayload>
    if (
      typeof obj.holderId === "string" &&
      typeof obj.expiresAt === "number" &&
      typeof obj.pid === "number"
    ) {
      return obj as FileLockPayload
    }
    return null
  } catch {
    return null
  }
}

export interface FileBasedLockOptions {
  readonly store: LockFileStorePort
  readonly clock: ClockPort
  /** Caller-provided PID — port-injected so tests inject deterministic values
   *  without `process.pid`. */
  readonly pid: number
}

const tryReplaceExisting = async (
  store: LockFileStorePort,
  key: string,
  raw: string,
  payload: FileLockPayload,
  now: number,
): Promise<LockResult> => {
  const parsed = parseLockPayload(raw)
  if (parsed !== null && parsed.expiresAt > now && parsed.holderId !== payload.holderId) {
    return "would-wait"
  }
  const replaced = await store.compareAndSwap(key, raw, JSON.stringify(payload))
  return replaced === "ok" ? "acquired" : "would-wait"
}

export class FileBasedLock implements OAuthRefreshLockPort {
  private readonly store: LockFileStorePort
  private readonly clock: ClockPort
  private readonly pid: number

  constructor(options: FileBasedLockOptions) {
    this.store = options.store
    this.clock = options.clock
    this.pid = options.pid
  }

  async tryAcquire(key: string, holderId: string, ttlMs: number): Promise<LockResult> {
    if (ttlMs <= 0) throw new Error(`FileBasedLock.tryAcquire: ttlMs must be > 0 (got ${ttlMs})`)
    if (holderId.length === 0)
      throw new Error("FileBasedLock.tryAcquire: holderId must be non-empty")
    if (key.length === 0) throw new Error("FileBasedLock.tryAcquire: key must be non-empty")

    const now = this.clock.now()
    const payload: FileLockPayload = { holderId, expiresAt: now + ttlMs, pid: this.pid }

    // Inspect existing file.
    const raw = await this.store.read(key)
    if (raw !== null) {
      return tryReplaceExisting(this.store, key, raw, payload, now)
    }

    // No file at all — try exclusive write. Race window: another process
    // could insert between our read and write. Exclusive mode reports it
    // via `"exists"` and we return would-wait.
    const writeResult = await this.store.writeExclusive(key, JSON.stringify(payload))
    return writeResult === "ok" ? "acquired" : "would-wait"
  }

  async release(key: string, holderId: string): Promise<void> {
    const raw = await this.store.read(key)
    if (raw === null) return // Unknown key — no-op.
    const parsed = parseLockPayload(raw)
    if (parsed === null) return // Corrupt file — leave for next tryAcquire's reap.
    if (parsed.holderId !== holderId) return // Wrong holder — no-op (safety).
    await this.store.compareAndSwap(key, raw, null)
  }
}
