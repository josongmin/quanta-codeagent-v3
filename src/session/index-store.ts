import { rename, unlink } from "node:fs/promises"
import { fileExists, readFile, writeFile } from "@/storage"
import { indexFilePath, indexFilePathAsync } from "./paths"
import type { SessionRootProvider } from "./root-port"
import type { SessionMeta } from "./types"

/**
 * `index.jsonl` is the lightweight directory of sessions — one JSON object per
 * line, one line per session-id. We rewrite the whole file on every upsert
 * (atomic per-writer-tmp + rename). The file is small (≤ a few KB even for
 * hundreds of sessions), so the cost is negligible and we avoid
 * append-then-dedupe shenanigans.
 *
 * CONCURRENCY (in-process): `upsertMeta` and `removeFromIndex` serialize on
 * an internal promise-chain mutex so the read-modify-write window is atomic
 * within ONE process — every concurrent caller's update lands in the final
 * map (no lost updates within a single CLI run). The atomic write itself
 * uses a per-writer `<index>.tmp.<pid>.<rand>` so concurrent writers (e.g.
 * cross-process) don't ENOENT each other on rename.
 *
 * CONCURRENCY (cross-process): if two separate CLI processes ever race, the
 * mutex is per-process so they can still last-writer-wins each other —
 * documented and acceptable for v3 (each id has its own JSON file, which
 * never loses data). The previous shared-tmp scheme threw ENOENT on the
 * second rename; per-writer tmps make all concurrent renames succeed cleanly.
 */

/** Parse `index.jsonl` to a `Map<id, meta>`. Corrupt / wrong-shape lines are
 * skipped silently — the index is a derived cache; the per-session JSON files
 * are the source of truth. Missing file → empty map. */
const readIndexMap = async (path: string): Promise<Map<string, SessionMeta>> => {
  const out = new Map<string, SessionMeta>()
  try {
    if (!(await fileExists(path))) return out
    const raw = await readFile(path)
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      try {
        const parsed = JSON.parse(line) as Partial<SessionMeta>
        if (
          typeof parsed.id === "string" &&
          typeof parsed.title === "string" &&
          typeof parsed.cwd === "string" &&
          typeof parsed.createdAt === "number" &&
          typeof parsed.lastTouched === "number" &&
          typeof parsed.archived === "boolean"
        ) {
          out.set(parsed.id, parsed as SessionMeta)
        }
      } catch {
        // Corrupt line — skip. The whole-file rewrite on next upsert heals it.
      }
    }
  } catch {
    // Read failures (permission, etc) yield an empty map — never throw.
  }
  return out
}

/** Real-atomically rewrite `index.jsonl` from the given map. Order: stable by
 *  id ascending so diffs are clean and reviewable. Full body is staged in a
 *  per-writer `.tmp.<pid>.<rand>` then `rename()`-d to the target —
 *  POSIX-atomic so a crash mid-write never leaves a partial / torn
 *  `index.jsonl`, and concurrent writers don't ENOENT each other (each owns
 *  its own staging file). */
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

/** In-process serialization for read-modify-write index updates. Each root's
 *  `index.jsonl` gets its own promise-chain mutex so two awaiters of
 *  `upsertMeta`/`removeFromIndex` targeting the SAME file never interleave
 *  their read+write windows, while different tenant roots do not block each
 *  other. The queue drains naturally when the last holder releases. */
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

export const upsertMeta = async (
  meta: SessionMeta,
  provider?: SessionRootProvider,
): Promise<void> => {
  const path = await resolveIndexPath(provider)
  return withIndexMutex(path, async () => {
    const map = await readIndexMap(path)
    map.set(meta.id, meta)
    await writeIndexMap(path, map)
  })
}

export const removeFromIndex = async (id: string, provider?: SessionRootProvider): Promise<void> => {
  const path = await resolveIndexPath(provider)
  return withIndexMutex(path, async () => {
    const map = await readIndexMap(path)
    if (!map.has(id)) return
    map.delete(id)
    await writeIndexMap(path, map)
  })
}

export const listSessions = async (opts?: {
  includeArchived?: boolean
}, provider?: SessionRootProvider): Promise<SessionMeta[]> => {
  const map = await readIndexMap(await resolveIndexPath(provider))
  const includeArchived = opts?.includeArchived === true
  const out: SessionMeta[] = []
  for (const meta of map.values()) {
    if (!includeArchived && meta.archived) continue
    out.push(meta)
  }
  out.sort((a, b) => b.lastTouched - a.lastTouched)
  return out
}
