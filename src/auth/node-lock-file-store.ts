/**
 * Production `LockFileStorePort` using exclusive `wx` creates and 0600 files.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { LockFileStorePort } from "./lock-file-based"
import { writePrivateFileAtomic } from "./private-file-atomic"

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT"

const isEexist = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "EEXIST"

const ignoreCleanupError = (error: unknown): void => {
  void error
}

export const lockFilePathFor = (dir: string, key: string): string => join(dir, `${key}.lock`)

const casFilePathFor = (dir: string, key: string): string => join(dir, `${key}.cas`)

const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

const acquireCasClaim = async (
  claimPath: string,
): Promise<Awaited<ReturnType<typeof open>> | null> => {
  try {
    const claim = await open(claimPath, "wx", 0o600)
    await claim.writeFile(`${process.pid}\n`, "utf8")
    return claim
  } catch (e) {
    if (isEexist(e)) return null
    throw e
  }
}

export const createNodeLockFileStore = (dir: string): LockFileStorePort => ({
  read: async (key) => {
    return readOptional(lockFilePathFor(dir, key))
  },
  writeExclusive: async (key, content) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = lockFilePathFor(dir, key)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, "wx", 0o600)
      await handle.writeFile(content, "utf8")
      await handle.sync()
      return "ok"
    } catch (e) {
      if (isEexist(e)) return "exists"
      throw e
    } finally {
      if (handle !== undefined) {
        await handle.close().catch((closeErr: unknown) => {
          void closeErr
        })
      }
    }
  },
  compareAndSwap: async (key, expected, next) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const claimPath = casFilePathFor(dir, key)
    const claim = await acquireCasClaim(claimPath)
    if (claim === null) return "changed"
    try {
      const path = lockFilePathFor(dir, key)
      const current = await readOptional(path)
      if (current !== expected) return "changed"
      if (next === null) await unlink(path)
      else await writePrivateFileAtomic(path, next)
      return "ok"
    } finally {
      await claim.close().catch(ignoreCleanupError)
      await unlink(claimPath).catch(ignoreCleanupError)
    }
  },
})
