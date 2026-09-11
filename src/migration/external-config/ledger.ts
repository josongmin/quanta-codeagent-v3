/**
 * External-config migration THROTTLE LEDGER (H13).
 *
 * Lock is a held flock fd (F-03). Entries are validated element-wise (F-11).
 * A malformed file never throws at startup; valid subset is used and the
 * original bytes are not rewritten on load. An unreadable/unparseable file
 * is not replaced by a fresh ledger on recordDisposition.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ExclusiveLockTimeoutError } from "@/shared"
import { withMigrationFileLock } from "./exclusive-lock"
import type {
  DetectedConfigItem,
  MigrationDisposition,
  MigrationItemType,
  MigrationLedger,
  MigrationLedgerEntry,
  MigrationScope,
} from "./types"
import { ALL_MIGRATION_ITEM_TYPES } from "./types"

export const migrationLedgerPath = (homeDir: string): string =>
  join(homeDir, ".quanta", "external_config_migration.json")

const lockPath = (homeDir: string): string => `${migrationLedgerPath(homeDir)}.lock`

const DISPOSITIONS: readonly MigrationDisposition[] = ["offered", "imported", "declined"]

export type LedgerLoadDiagnostic = {
  readonly dropped: number
  /** File exists but JSON/version/shape cannot be used. Load must not rewrite
   *  those bytes; writers must not replace them with a fresh empty ledger. */
  readonly unreadable: boolean
}

export const parseLedgerEntry = (raw: unknown): MigrationLedgerEntry | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.sourceKey !== "string" || o.sourceKey.length === 0) return null
  if (!DISPOSITIONS.includes(o.disposition as MigrationDisposition)) return null
  if (typeof o.timestamp !== "string" || o.timestamp.length === 0) return null
  if (!Array.isArray(o.itemTypes)) return null
  const itemTypes: MigrationItemType[] = []
  for (const t of o.itemTypes) {
    if (typeof t === "string" && (ALL_MIGRATION_ITEM_TYPES as readonly string[]).includes(t)) {
      itemTypes.push(t as MigrationItemType)
    }
  }
  return {
    sourceKey: o.sourceKey,
    disposition: o.disposition as MigrationDisposition,
    timestamp: o.timestamp,
    itemTypes,
  }
}

export const sourceKeyOf = (
  scope: MigrationScope,
  items: readonly Pick<DetectedConfigItem, "path">[],
): string => {
  const paths = [...items.map((i) => i.path)].sort()
  const h = createHash("sha256")
  h.update(scope)
  h.update("\x00")
  h.update(paths.join("\x00"))
  return `${scope}:${h.digest("hex").slice(0, 24)}`
}

const emptyLedger = (): MigrationLedger => ({ version: 1, entries: [] })

export const loadMigrationLedger = async (homeDir: string): Promise<MigrationLedger> => {
  const loaded = await loadMigrationLedgerDetailed(homeDir)
  return loaded.ledger
}

export const loadMigrationLedgerDetailed = async (
  homeDir: string,
): Promise<{ readonly ledger: MigrationLedger; readonly diagnostic: LedgerLoadDiagnostic }> => {
  const path = migrationLedgerPath(homeDir)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ledger: emptyLedger(), diagnostic: { dropped: 0, unreadable: false } }
    }
    return { ledger: emptyLedger(), diagnostic: { dropped: 0, unreadable: true } }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return { ledger: emptyLedger(), diagnostic: { dropped: 0, unreadable: true } }
    }
    const entries: MigrationLedgerEntry[] = []
    let dropped = 0
    for (const item of (parsed as { entries: unknown[] }).entries) {
      const entry = parseLedgerEntry(item)
      if (entry === null) {
        dropped += 1
        continue
      }
      entries.push(entry)
    }
    return { ledger: { version: 1, entries }, diagnostic: { dropped, unreadable: false } }
  } catch {
    return { ledger: emptyLedger(), diagnostic: { dropped: 0, unreadable: true } }
  }
}

export const isThrottled = (ledger: MigrationLedger, sourceKey: string): boolean =>
  ledger.entries.some((e) => e.sourceKey === sourceKey)

export const recordDisposition = async (
  homeDir: string,
  sourceKey: string,
  disposition: MigrationDisposition,
  itemTypes: readonly MigrationItemType[],
): Promise<boolean> => {
  const path = migrationLedgerPath(homeDir)
  await mkdir(dirname(path), { recursive: true })
  try {
    return await withMigrationFileLock(lockPath(homeDir), async () => {
      const loaded = await loadMigrationLedgerDetailed(homeDir)
      if (loaded.diagnostic.unreadable) return false
      const entry: MigrationLedgerEntry = {
        sourceKey,
        disposition,
        timestamp: new Date().toISOString(),
        itemTypes: [...itemTypes],
      }
      const next: MigrationLedger = { version: 1, entries: [...loaded.ledger.entries, entry] }
      const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`
      try {
        await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
        await rename(tmp, path)
      } catch (e) {
        await rm(tmp, { force: true })
        throw e
      }
      return true
    })
  } catch (err) {
    // Contention is an expected outcome here, not a failure: another writer
    // holds the ledger and this caller reports "not written". Branching on the
    // structured error means rewording the message cannot silently turn that
    // back into a crash.
    if (err instanceof ExclusiveLockTimeoutError) return false
    throw err
  }
}
