/**
 * RFC-06 F1 — the JSON fs adapter behind {@link DisabledStorePort} + a
 * process-local in-memory store (for the live session default / tests).
 *
 * The `@/skill` slice may NOT import `@/storage`, so this adapter reaches
 * node:fs through an injected {@link DisabledStoreFs} callback pair (default
 * `nodeDisabledStoreFs`), mirroring `admin-policy-loader-fs`'s reader port. The
 * write is atomic (temp file + rename) and PERSIST-OBSERVING: it THROWS when the
 * bytes do not reach disk, so the authority's persist-before-publish barrier can
 * refuse to publish.
 *
 * Decode is fail-closed via {@link decodeDisabledSet}: corrupt / wrong-version /
 * unreadable bytes ⇒ the empty set (never trusted).
 */

import { errMessage } from "@/shared"
import {
  DISABLED_SET_SCHEMA_VERSION,
  type DisabledStorePort,
  decodeDisabledSet,
  emptyDisabledSet,
  type PersistedDisabledSet,
} from "../disabled-store-port"
import { createFileLock, type DisabledStoreLock, disabledSetLockPath } from "./disabled-store-lock"

/** The single fs side-effect seam. `readText` returns `null` on ENOENT (absent
 *  ⇒ empty set); `writeText` performs a durable write and THROWS on failure. */
export interface DisabledStoreFs {
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
}

/** Default node:fs adapter. Reads utf8 (null on ENOENT); writes atomically via a
 *  sibling temp file + rename, ensuring the parent dir exists. Non-ENOENT read
 *  errors PROPAGATE (EACCES/EIO must not silently degrade). A write that cannot
 *  reach disk throws — the authority converts it to a `persist_failed` rejection. */
export const nodeDisabledStoreFs: DisabledStoreFs = {
  readText: async (path) => {
    const { readFile } = await import("node:fs/promises")
    try {
      return await readFile(path, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  },
  writeText: async (path, text) => {
    const { mkdir, rename, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, "utf8")
    await rename(tmp, path)
  },
}

/** Serialize `next` to a durable disabled-set record, sorting `names` for a
 *  deterministic on-disk shape at a given `revision`. */
const recordAt = (names: ReadonlySet<string>, revision: number): PersistedDisabledSet => ({
  schemaVersion: DISABLED_SET_SCHEMA_VERSION,
  revision,
  names: [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
})

/**
 * Build a durable JSON-backed {@link DisabledStorePort} at `path`. `read` decodes
 * fail-closed; `write` serializes the record to pretty JSON and persists it
 * atomically (throws on a non-durable write).
 *
 * `mutate` runs read→transform→write as a CROSS-PROCESS critical section under an
 * O_EXCL lockfile (`<path>.lock` by default, override via `lock` for tests /
 * red-on-injection): a concurrent writer blocks (bounded retry) or reclaims a
 * crashed holder's stale lock, then this call re-reads the FRESH on-disk state,
 * re-applies the transform, and bumps the revision from that fresh value — so two
 * processes sharing `path` can never lost-update each other.
 */
export const createJsonDisabledStore = (opts: {
  readonly path: string
  readonly fs?: DisabledStoreFs
  /** Cross-process guard for `mutate`. Defaults to an O_EXCL lockfile at
   *  `<path>.lock`. Inject a pass-through lock to prove the guard is
   *  load-bearing (red-on-injection) or a tuned lock for fast tests. */
  readonly lock?: DisabledStoreLock
}): DisabledStorePort => {
  const fs = opts.fs ?? nodeDisabledStoreFs
  const lock = opts.lock ?? createFileLock(disabledSetLockPath(opts.path))
  const read = async (): Promise<PersistedDisabledSet> => {
    let raw: string | null
    try {
      raw = await fs.readText(opts.path)
    } catch (_e) {
      // A read failure (EACCES/corrupt handle) fails CLOSED to the empty set
      // rather than crashing session construction — the user-disabled overlay
      // is best-effort at load; admin bans still apply via the policy arm.
      return emptyDisabledSet()
    }
    if (raw === null) return emptyDisabledSet()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (_e) {
      return emptyDisabledSet()
    }
    return decodeDisabledSet(parsed)
  }
  const write = async (next: PersistedDisabledSet): Promise<void> => {
    // Persist-observing: any fs throw propagates so the authority refuses to
    // publish an unpersisted disable.
    try {
      await fs.writeText(opts.path, `${JSON.stringify(next, null, 2)}\n`)
    } catch (e) {
      throw new Error(`disabled-set write failed: ${errMessage(e)}`)
    }
  }
  return {
    read,
    write,
    mutate: (basedOnRevision, transform) =>
      // The lock is mutual exclusion; the revision is the optimistic check
      // layered on top. `withLock` ALWAYS releases (finally) — a persist throw
      // never leaks the lock — and an acquire failure propagates so the
      // authority refuses to publish rather than clobber a concurrent writer.
      lock.withLock(async () => {
        const disk = await read()
        const next = transform(new Set(disk.names))
        const record = recordAt(next, disk.revision + 1)
        await write(record)
        return { record, resynced: disk.revision !== basedOnRevision }
      }),
  }
}

/**
 * A process-local, non-durable disabled-set store (a single cell). Used where no
 * durable file is keyed yet (the live session default) and by unit tests to
 * observe the authority's persist/publish behavior. `write` is async to honor the
 * persist-before-publish contract.
 */
export const createInMemoryDisabledStore = (seed?: PersistedDisabledSet): DisabledStorePort => {
  let cell: PersistedDisabledSet = seed ?? emptyDisabledSet()
  return {
    read: async () => cell,
    write: async (next) => {
      cell = next
    },
    // Single-process: the cell IS the truth, so no cross-process lock is needed.
    // Still re-reads the cell + re-applies the transform + bumps from the cell's
    // revision, mirroring the JSON store's contract so the authority is
    // adapter-agnostic.
    mutate: async (basedOnRevision, transform) => {
      const next = transform(new Set(cell.names))
      const record = recordAt(next, cell.revision + 1)
      const resynced = cell.revision !== basedOnRevision
      cell = record
      return { record, resynced }
    },
  }
}
