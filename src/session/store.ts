import { fileExists, readFile, writeFile } from "@/storage"
import { removeFromIndex, upsertMeta } from "./index-store"
import { archivedFilePath, sessionFilePath } from "./paths"
import { type SavedSession, type SavePayload, SESSION_VERSION, type SessionMeta } from "./types"

/**
 * Id-addressable session store — the per-file half. Each id maps to exactly
 * one JSON file: either `<root>/<id>.json` (active) or
 * `<root>/archived/<id>.json` (archived). Writes go through `Bun.write` + tmp
 * rename for atomicity, same idiom as `src/agent/state.ts:46-50`.
 *
 * Reads NEVER throw on missing/corrupt — they return `undefined`. Writes throw
 * only on programmer errors (we don't catch — let it bubble). The CLI is the
 * caller and decides how to surface failures.
 */

/** Atomic write of one session-JSON file. Bun.write auto-creates parents. */
const writeSessionFile = async (path: string, body: string): Promise<void> => {
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, body)
    await Bun.write(path, Bun.file(tmp))
    await Bun.file(tmp).delete()
  } catch {
    await writeFile(path, body)
  }
}

/** Best-effort read+parse of a `SavedSession` JSON. Returns undefined on any
 * failure (missing, parse error, wrong shape). */
const readSavedSession = async (path: string): Promise<SavedSession | undefined> => {
  try {
    if (!(await fileExists(path))) return undefined
    const raw = await readFile(path)
    const parsed = JSON.parse(raw) as Partial<SavedSession>
    if (
      parsed.version !== SESSION_VERSION ||
      typeof parsed.reason !== "string" ||
      typeof parsed.turns !== "number" ||
      !Array.isArray(parsed.messages) ||
      typeof parsed.meta !== "object" ||
      parsed.meta === null
    ) {
      return undefined
    }
    const m = parsed.meta as Partial<SessionMeta>
    if (
      typeof m.id !== "string" ||
      typeof m.title !== "string" ||
      typeof m.cwd !== "string" ||
      typeof m.createdAt !== "number" ||
      typeof m.lastTouched !== "number" ||
      typeof m.archived !== "boolean"
    ) {
      return undefined
    }
    return parsed as SavedSession
  } catch {
    return undefined
  }
}

/** Delete a file if it exists; swallow ENOENT-style failures. */
const removeFileIfExists = async (path: string): Promise<void> => {
  try {
    if (await fileExists(path)) await Bun.file(path).delete()
  } catch {
    // Best-effort — caller already treats absence as success.
  }
}

export const saveSessionById = async (meta: SessionMeta, payload: SavePayload): Promise<void> => {
  const touched: SessionMeta = { ...meta, lastTouched: Date.now() }
  const path = touched.archived ? archivedFilePath(touched.id) : sessionFilePath(touched.id)
  const saved: SavedSession = {
    version: SESSION_VERSION,
    meta: touched,
    reason: payload.reason,
    turns: payload.turns,
    messages: payload.messages,
  }
  await writeSessionFile(path, JSON.stringify(saved))
  await upsertMeta(touched)
}

export const loadSessionById = async (id: string): Promise<SavedSession | undefined> => {
  const active = await readSavedSession(sessionFilePath(id))
  if (active !== undefined) return active
  return readSavedSession(archivedFilePath(id))
}

export const archiveSession = async (id: string): Promise<void> => {
  const activePath = sessionFilePath(id)
  const archivedPath = archivedFilePath(id)
  // Idempotency: if it's already archived (active file gone, archived present
  // — or simply already-marked), do nothing.
  const activeExists = await fileExists(activePath)
  if (!activeExists) {
    // Could be already-archived: ensure the meta reflects archived=true.
    const existing = await readSavedSession(archivedPath)
    if (existing === undefined) return // truly missing — no-op
    if (existing.meta.archived) return
    const nextMeta: SessionMeta = { ...existing.meta, archived: true, lastTouched: Date.now() }
    const updated: SavedSession = { ...existing, meta: nextMeta }
    await writeSessionFile(archivedPath, JSON.stringify(updated))
    await upsertMeta(nextMeta)
    return
  }
  const existing = await readSavedSession(activePath)
  if (existing === undefined) return
  const nextMeta: SessionMeta = { ...existing.meta, archived: true, lastTouched: Date.now() }
  const updated: SavedSession = { ...existing, meta: nextMeta }
  await writeSessionFile(archivedPath, JSON.stringify(updated))
  await removeFileIfExists(activePath)
  await upsertMeta(nextMeta)
}

export const unarchiveSession = async (id: string): Promise<void> => {
  const activePath = sessionFilePath(id)
  const archivedPath = archivedFilePath(id)
  const archivedExists = await fileExists(archivedPath)
  if (!archivedExists) {
    // Possibly already active — reconcile the flag if needed.
    const existing = await readSavedSession(activePath)
    if (existing === undefined) return
    if (!existing.meta.archived) return
    const nextMeta: SessionMeta = { ...existing.meta, archived: false, lastTouched: Date.now() }
    const updated: SavedSession = { ...existing, meta: nextMeta }
    await writeSessionFile(activePath, JSON.stringify(updated))
    await upsertMeta(nextMeta)
    return
  }
  const existing = await readSavedSession(archivedPath)
  if (existing === undefined) return
  const nextMeta: SessionMeta = { ...existing.meta, archived: false, lastTouched: Date.now() }
  const updated: SavedSession = { ...existing, meta: nextMeta }
  await writeSessionFile(activePath, JSON.stringify(updated))
  await removeFileIfExists(archivedPath)
  await upsertMeta(nextMeta)
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  const existing = await loadSessionById(id)
  if (existing === undefined) return
  const nextMeta: SessionMeta = { ...existing.meta, title, lastTouched: Date.now() }
  const path = nextMeta.archived ? archivedFilePath(id) : sessionFilePath(id)
  const updated: SavedSession = { ...existing, meta: nextMeta }
  await writeSessionFile(path, JSON.stringify(updated))
  await upsertMeta(nextMeta)
}

export const forkSession = async (
  id: string,
  opts?: { newId?: string; title?: string; cwd?: string },
): Promise<string> => {
  const source = await loadSessionById(id)
  if (source === undefined) {
    throw new Error(`forkSession: source session not found: ${id}`)
  }
  const newId = opts?.newId ?? crypto.randomUUID()
  const now = Date.now()
  const newMeta: SessionMeta = {
    id: newId,
    title: opts?.title ?? `${source.meta.title} (fork)`,
    cwd: opts?.cwd ?? source.meta.cwd,
    createdAt: now,
    lastTouched: now,
    archived: false,
  }
  // Deep-copy messages by re-parsing — defensive against any later mutation by
  // the caller, and keeps the source untouched (fork MUST NOT mutate source).
  const messagesCopy = JSON.parse(JSON.stringify(source.messages)) as typeof source.messages
  const saved: SavedSession = {
    version: SESSION_VERSION,
    meta: newMeta,
    reason: source.reason,
    turns: source.turns,
    messages: messagesCopy,
  }
  await writeSessionFile(sessionFilePath(newId), JSON.stringify(saved))
  await upsertMeta(newMeta)
  return newId
}

export const deleteSession = async (id: string): Promise<void> => {
  await removeFileIfExists(sessionFilePath(id))
  await removeFileIfExists(archivedFilePath(id))
  await removeFromIndex(id)
}
