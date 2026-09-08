/**
 * Production `LockFileStorePort`. Payload files stay 0600. CAS uses a held
 * flock fd (W0.3) so a leftover `.cas` wx file cannot wedge every successor.
 */

import { mkdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { withExclusiveFileLock } from "./file-transaction/exclusive-lock"
import type { LockFileStorePort } from "./lock-file-based"
import { writePrivateFileAtomic } from "./private-file-atomic"

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT"

export const lockFilePathFor = (dir: string, key: string): string => join(dir, `${key}.lock`)

const txLockPathFor = (dir: string, key: string): string => join(dir, `${key}.txlock`)

const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

const applyCompareAndSwap = async (
  path: string,
  expected: string | null,
  next: string | null,
): Promise<"ok" | "changed"> => {
  const current = await readOptional(path)
  if (current !== expected) return "changed"
  if (next === null) {
    try {
      await unlink(path)
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  } else {
    await writePrivateFileAtomic(path, next)
  }
  return "ok"
}

export const createNodeLockFileStore = (dir: string): LockFileStorePort => ({
  read: async (key) => {
    return readOptional(lockFilePathFor(dir, key))
  },
  writeExclusive: async (key, content) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = lockFilePathFor(dir, key)
    const tx = txLockPathFor(dir, key)
    return withExclusiveFileLock(tx, {}, async () => {
      const current = await readOptional(path)
      if (current !== null) return "exists"
      await writePrivateFileAtomic(path, content)
      return "ok"
    })
  },
  compareAndSwap: async (key, expected, next) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = lockFilePathFor(dir, key)
    const tx = txLockPathFor(dir, key)
    return withExclusiveFileLock(tx, {}, () => applyCompareAndSwap(path, expected, next))
  },
})
