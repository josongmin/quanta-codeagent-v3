import { fileExists, readFile, writeFile } from "@/storage"
import { indexFilePath } from "./paths"
import type { SessionMeta } from "./types"

/**
 * `index.jsonl` is the lightweight directory of sessions — one JSON object per
 * line, one line per session-id. We rewrite the whole file on every upsert
 * (atomic .tmp + rename). The file is small (≤ a few KB even for hundreds of
 * sessions), so the cost is negligible and we avoid append-then-dedupe shenanigans.
 *
 * CONCURRENCY: single CLI process per user session is the design assumption,
 * so simultaneous upserts use **last-writer-wins**. If two processes ever race,
 * one of the two metadata updates is lost — but the per-session JSON file is
 * never affected (each id is its own file). Documented; acceptable for v3.
 */

/** Parse `index.jsonl` to a `Map<id, meta>`. Corrupt / wrong-shape lines are
 * skipped silently — the index is a derived cache; the per-session JSON files
 * are the source of truth. Missing file → empty map. */
const readIndexMap = async (): Promise<Map<string, SessionMeta>> => {
  const path = indexFilePath()
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

/** Atomically rewrite `index.jsonl` from the given map. Order: stable by id
 * ascending so diffs are clean and reviewable. */
const writeIndexMap = async (map: Map<string, SessionMeta>): Promise<void> => {
  const path = indexFilePath()
  const ids = [...map.keys()].sort()
  const lines = ids.map((id) => JSON.stringify(map.get(id))).join("\n")
  const body = lines === "" ? "" : `${lines}\n`
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, body)
    await Bun.write(path, Bun.file(tmp))
    await Bun.file(tmp).delete()
  } catch {
    await writeFile(path, body)
  }
}

export const upsertMeta = async (meta: SessionMeta): Promise<void> => {
  const map = await readIndexMap()
  map.set(meta.id, meta)
  await writeIndexMap(map)
}

export const removeFromIndex = async (id: string): Promise<void> => {
  const map = await readIndexMap()
  if (!map.has(id)) return
  map.delete(id)
  await writeIndexMap(map)
}

export const listSessions = async (opts?: {
  includeArchived?: boolean
}): Promise<SessionMeta[]> => {
  const map = await readIndexMap()
  const includeArchived = opts?.includeArchived === true
  const out: SessionMeta[] = []
  for (const meta of map.values()) {
    if (!includeArchived && meta.archived) continue
    out.push(meta)
  }
  out.sort((a, b) => b.lastTouched - a.lastTouched)
  return out
}
