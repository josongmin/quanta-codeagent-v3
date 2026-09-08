/**
 * Same-directory temp + fsync + rename. EXDEV is a failure, never a copy
 * success (F-13). Used by JSON merge writers and markdown/memory replace.
 */

import { randomBytes } from "node:crypto"
import { chmod, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { errMessage, logger } from "@/shared"
import type { ConfigWriteSync } from "./persist-sync"

const statModeOrUndefined = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode
  } catch (e) {
    logger.debug(`config-migration: no original mode to preserve (new file?): ${errMessage(e)}`)
    return undefined
  }
}

export const writeBytesAtomic = async (
  path: string,
  content: string,
  sync: ConfigWriteSync,
): Promise<void> => {
  const temp = `${path}.quanta-tmp-${randomBytes(8).toString("hex")}`
  const originalMode = await statModeOrUndefined(path)
  try {
    await writeFile(temp, content, "utf8")
    await sync.syncFile(temp)
    if (originalMode !== undefined) {
      await chmod(temp, originalMode).catch((e) => {
        logger.debug(`config-migration: mode preservation failed: ${errMessage(e)}`)
      })
    }
  } catch (e) {
    await unlink(temp).catch((cleanupErr) => {
      logger.debug(`config-migration: atomic temp cleanup failed: ${errMessage(cleanupErr)}`)
    })
    throw e
  }
  try {
    await rename(temp, path)
  } catch (e) {
    await unlink(temp).catch(() => undefined)
    throw e
  }
  await sync.syncDir(dirname(path))
}

export const writeJsonAtomic = async (
  path: string,
  value: Record<string, unknown>,
  sync: ConfigWriteSync,
): Promise<void> => {
  await writeBytesAtomic(path, `${JSON.stringify(value, null, 2)}\n`, sync)
}
