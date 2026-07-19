import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseYaml } from "../yaml"
import {
  type AuditRecord,
  AuditRecordSchema,
  type AuditSnapshot,
  AuditSnapshotSchema,
} from "./schema"

const gatherYamlFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await gatherYamlFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(path)
  }
  return out.sort()
}

export const loadAuditSnapshot = async (path: string): Promise<AuditSnapshot> =>
  AuditSnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")))

export const loadAuditRecords = async (dir: string): Promise<AuditRecord[]> => {
  const records: AuditRecord[] = []
  for (const path of await gatherYamlFiles(dir)) {
    const parsed = AuditRecordSchema.safeParse(parseYaml(await readFile(path, "utf8")))
    if (!parsed.success) throw new Error(`invalid audit record ${path}: ${parsed.error.message}`)
    records.push(parsed.data)
  }
  return records
}
