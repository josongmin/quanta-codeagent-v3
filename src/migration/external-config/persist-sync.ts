/**
 * Durability barrier types for migration persist. Split from persist.ts so
 * atomic writers can import without the rest of the persist god-module.
 */

import { open } from "node:fs/promises"
import { errMessage, logger } from "@/shared"

export interface ConfigWriteSync {
  readonly syncFile: (path: string) => Promise<void>
  readonly syncDir: (dir: string) => Promise<void>
}

export const defaultConfigWriteSync: ConfigWriteSync = {
  syncFile: async (path) => {
    const handle = await open(path, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  syncDir: async (dir) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(dir, "r")
      await handle.sync()
    } catch (e) {
      logger.debug(`config-migration: parent-dir fsync skipped: ${errMessage(e)}`)
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined)
    }
  },
}
