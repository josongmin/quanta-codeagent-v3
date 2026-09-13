/**
 * `~/.quanta/trust.json` persistence for TrustStore (F-12). Kept out of
 * `index.ts` so owner-local tests can drive commit without loading the
 * agent entry side effects.
 */

import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { withExclusiveFileLock } from "@/auth/file-transaction/exclusive-lock"
import type { TrustPersistencePort, TrustRecord } from "@/config"
import { writeFileAtomic } from "@/storage"

export const makeTrustPersistence = (trustFilePath: string): TrustPersistencePort => ({
  load: async () => {
    let text: string
    try {
      text = await readFile(trustFilePath, "utf8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return undefined
      throw err
    }
    try {
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, TrustRecord>)
        : undefined
    } catch {
      return undefined
    }
  },
  commit: async (mutations) => {
    await mkdir(dirname(trustFilePath), { recursive: true })
    await withExclusiveFileLock(`${trustFilePath}.lock`, {}, async () => {
      let current: Record<string, TrustRecord> = {}
      try {
        const text = await readFile(trustFilePath, "utf8")
        const parsed = JSON.parse(text) as unknown
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(`trust file is not a JSON object: ${trustFilePath}`)
        }
        current = parsed as Record<string, TrustRecord>
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err
      }
      await writeFileAtomic(trustFilePath, JSON.stringify({ ...current, ...mutations }))
    })
  },
})
