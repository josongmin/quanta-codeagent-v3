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
 * Atomicity caveat: file write is NOT atomic with respect to other writers.
 * The store impl SHOULD use `open(O_CREAT|O_EXCL)` semantics — this port
 * leaves that to the implementer because the tradeoff (tmpfile + rename vs
 * O_EXCL) is platform-dependent and we do not want to bake it into the
 * domain layer.
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
  /** Write the lock file atomically (e.g. tmpfile + rename, or O_EXCL).
   *  When `mode === "exclusive"`, the write MUST fail with `"exists"` if
   *  the file is already present and live (not stale-reaped). */
  write(key: string, content: string, mode: "exclusive" | "overwrite"): Promise<"ok" | "exists">
  /** Delete the lock file. Idempotent — missing file is success. */
  delete(key: string): Promise<void>
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
      const parsed = parseLockPayload(raw)
      // Live lock branch: same holder renews, different holder waits.
      if (parsed !== null && parsed.expiresAt > now) {
        if (parsed.holderId === holderId) {
          await this.store.write(key, JSON.stringify(payload), "overwrite")
          return "acquired"
        }
        return "would-wait"
      }
      // Stale / corrupt: we own the right to overwrite (read already narrowed
      // the race window; last-write-wins is the documented tradeoff).
      await this.store.write(key, JSON.stringify(payload), "overwrite")
      return "acquired"
    }

    // No file at all — try exclusive write. Race window: another process
    // could insert between our read and write. Exclusive mode reports it
    // via `"exists"` and we return would-wait.
    const writeResult = await this.store.write(key, JSON.stringify(payload), "exclusive")
    return writeResult === "ok" ? "acquired" : "would-wait"
  }

  async release(key: string, holderId: string): Promise<void> {
    const raw = await this.store.read(key)
    if (raw === null) return // Unknown key — no-op.
    const parsed = parseLockPayload(raw)
    if (parsed === null) return // Corrupt file — leave for next tryAcquire's reap.
    if (parsed.holderId !== holderId) return // Wrong holder — no-op (safety).
    await this.store.delete(key)
  }
}
