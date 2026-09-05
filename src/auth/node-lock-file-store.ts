/**
 * Production `LockFileStorePort` using exclusive `wx` creates and 0600 files.
 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { LockFileStorePort } from "./lock-file-based"

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT"

const isEexist = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "EEXIST"

export const lockFilePathFor = (dir: string, key: string): string => join(dir, `${key}.lock`)

export const createNodeLockFileStore = (dir: string): LockFileStorePort => ({
  read: async (key) => {
    try {
      return await readFile(lockFilePathFor(dir, key), "utf8")
    } catch (e) {
      if (isEnoent(e)) return null
      throw e
    }
  },
  write: async (key, content, mode) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = lockFilePathFor(dir, key)
    if (mode === "exclusive") {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(path, "wx", 0o600)
        await handle.writeFile(content, "utf8")
        return "ok"
      } catch (e) {
        if (isEexist(e)) return "exists"
        throw e
      } finally {
        if (handle !== undefined) await handle.close().catch(() => undefined)
      }
    }
    const tmp = `${path}.${process.pid}.tmp`
    const handle = await open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    return "ok"
  },
  delete: async (key) => {
    try {
      await unlink(lockFilePathFor(dir, key))
    } catch (e) {
      if (isEnoent(e)) return
      throw e
    }
  },
})
