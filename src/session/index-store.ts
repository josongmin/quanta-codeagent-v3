/**
 * `index.jsonl` is a derived projection of per-session snapshot JSON files.
 * Snapshot files are the source of truth. Invalid rows are diagnosed and
 * recovered from valid snapshots; they are not silently dropped on rewrite
 * (SEP7-D-06).
 *
 * CONCURRENCY (in-process): upsert/remove/recover serialize on a per-root
 * promise-chain mutex. Cross-process last-writer-wins is not claimed.
 */
import { readdir, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { errMessage, logger } from "@/shared"
import { fileExists, readFile, writeFile } from "@/storage"
import { indexFilePath, indexFilePathAsync } from "./paths"
import type { SessionRootProvider } from "./root-port"
import { readSessionSnapshot } from "./saved-session-schema"
import type { SessionMeta } from "./types"

export class IndexUnreadableError extends Error {
  readonly path: string
  constructor(path: string, cause: string) {
    super(`session index unreadable at ${path}: ${cause}`)
    this.name = "IndexUnreadableError"
    this.path = path
  }
}

const isSessionMeta = (value: unknown): value is SessionMeta => {
  if (typeof value !== "object" || value === null) return false
  const parsed = value as Partial<SessionMeta>
  return (
    typeof parsed.id === "string" &&
    typeof parsed.title === "string" &&
    typeof parsed.cwd === "string" &&
    typeof parsed.createdAt === "number" &&
    typeof parsed.lastTouched === "number" &&
    typeof parsed.archived === "boolean"
  )
}

interface IndexDocument {
  readonly map: Map<string, SessionMeta>
  readonly invalid: readonly { readonly raw: string; readonly id?: string }[]
}

const readIndexDocument = async (path: string): Promise<IndexDocument> => {
  const map = new Map<string, SessionMeta>()
  const invalid: { raw: string; id?: string }[] = []
  try {
    if (!(await fileExists(path))) return { map, invalid }
    const raw = await readFile(path)
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isSessionMeta(parsed)) {
          map.set(parsed.id, parsed)
          continue
        }
        const id =
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { id?: unknown }).id === "string"
            ? (parsed as { id: string }).id
            : undefined
        invalid.push(id !== undefined ? { raw: line, id } : { raw: line })
      } catch {
        invalid.push({ raw: line })
      }
    }
  } catch (e) {
    throw new IndexUnreadableError(path, errMessage(e))
  }
  return { map, invalid }
}

const writeIndexMap = async (path: string, map: Map<string, SessionMeta>): Promise<void> => {
  const ids = [...map.keys()].sort()
  const lines = ids.map((id) => JSON.stringify(map.get(id))).join("\n")
  const body = lines === "" ? "" : `${lines}\n`
  const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
  await writeFile(tmp, body)
  try {
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

const writeInvalidSidecar = async (
  path: string,
  invalid: readonly { readonly raw: string }[],
): Promise<void> => {
  if (invalid.length === 0) return
  const sidecar = `${path}.invalid`
  const body = `${invalid.map((row) => row.raw).join("\n")}\n`
  try {
    await writeFile(sidecar, body)
  } catch (e) {
    logger.warn("session index: failed to preserve invalid rows", {
      path: sidecar,
      error: errMessage(e),
    })
  }
}

const recoverMetaFromSnapshot = async (
  root: string,
  id: string,
): Promise<SessionMeta | undefined> => {
  const active = await readSessionSnapshot(join(root, `${id}.json`))
  if (active.kind === "found") return active.session.meta
  const archived = await readSessionSnapshot(join(root, "archived", `${id}.json`))
  if (archived.kind === "found") return archived.session.meta
  if (active.kind === "corrupt" || archived.kind === "corrupt") {
    logger.warn("session index: snapshot unreadable during recovery", {
      id,
      active: active.kind,
      archived: archived.kind,
    })
  }
  return undefined
}

const recoverFromSnapshots = async (
  indexPath: string,
  doc: IndexDocument,
): Promise<Map<string, SessionMeta>> => {
  const root = dirname(indexPath)
  const map = new Map(doc.map)
  const leftover: { raw: string; id?: string }[] = []
  for (const row of doc.invalid) {
    if (row.id === undefined) {
      leftover.push(row)
      continue
    }
    const recovered = await recoverMetaFromSnapshot(root, row.id)
    if (recovered !== undefined) map.set(recovered.id, recovered)
    else leftover.push(row)
  }
  try {
    const files = await readdir(root)
    for (const name of files) {
      if (!name.endsWith(".json") || name.startsWith("index.")) continue
      const id = name.slice(0, -".json".length)
      if (map.has(id)) continue
      const recovered = await recoverMetaFromSnapshot(root, id)
      if (recovered !== undefined) map.set(recovered.id, recovered)
    }
  } catch {
    // Directory listing is best-effort; do not turn a list/upsert into empty.
  }
  await writeInvalidSidecar(indexPath, leftover)
  return map
}

const indexMutexes = new Map<string, Promise<unknown>>()
const withIndexMutex = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
  const prev = indexMutexes.get(path) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  indexMutexes.set(path, next)
  try {
    await prev
  } catch {
    // A previous holder rejecting must not poison the queue.
  }
  try {
    return await fn()
  } finally {
    release()
    if (indexMutexes.get(path) === next) indexMutexes.delete(path)
  }
}

const resolveIndexPath = async (provider?: SessionRootProvider): Promise<string> =>
  provider === undefined ? indexFilePath() : await indexFilePathAsync(provider)

const loadMapForWrite = async (path: string): Promise<Map<string, SessionMeta>> => {
  const doc = await readIndexDocument(path)
  return recoverFromSnapshots(path, doc)
}

export const upsertMeta = async (
  meta: SessionMeta,
  provider?: SessionRootProvider,
): Promise<void> => {
  const path = await resolveIndexPath(provider)
  return withIndexMutex(path, async () => {
    const map = await loadMapForWrite(path)
    map.set(meta.id, meta)
    await writeIndexMap(path, map)
  })
}

export const removeFromIndex = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<void> => {
  const path = await resolveIndexPath(provider)
  return withIndexMutex(path, async () => {
    const map = await loadMapForWrite(path)
    if (!map.has(id)) return
    map.delete(id)
    await writeIndexMap(path, map)
  })
}

export const listSessions = async (
  opts?: {
    includeArchived?: boolean
  },
  provider?: SessionRootProvider,
): Promise<SessionMeta[]> => {
  const path = await resolveIndexPath(provider)
  const doc = await readIndexDocument(path)
  const map =
    doc.invalid.length > 0
      ? await withIndexMutex(path, async () => {
          const recovered = await recoverFromSnapshots(path, doc)
          await writeIndexMap(path, recovered)
          return recovered
        })
      : doc.map
  const includeArchived = opts?.includeArchived === true
  const out: SessionMeta[] = []
  for (const meta of map.values()) {
    if (!includeArchived && meta.archived) continue
    out.push(meta)
  }
  out.sort((a, b) => b.lastTouched - a.lastTouched)
  return out
}
