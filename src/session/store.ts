import { rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { logger } from "@/shared"
import { fileExists, readFile, writeFile } from "@/storage"
import type { SessionEnvelopeRecord } from "./envelope"
import { appendSessionLine, encodeSessionLine } from "./envelope-encoder"
import { removeFromIndex, upsertMeta } from "./index-store"
import { archivedFilePath, sessionFilePath, sessionsRoot } from "./paths"
import { type SavedSession, type SavePayload, SESSION_VERSION, type SessionMeta } from "./types"

/**
 * Id-addressable session store — the per-file half. Each id maps to exactly
 * one JSON file: either `<root>/<id>.json` (active) or
 * `<root>/archived/<id>.json` (archived). Writes are real-atomic: full body
 * is staged in `<target>.tmp` then `rename()`-d into place. POSIX guarantees
 * rename atomicity within the same filesystem, so a crash mid-write leaves
 * the existing target untouched (no partial / torn JSON).
 *
 * Reads NEVER throw on missing/corrupt — they return `undefined`. Writes throw
 * only on programmer errors (we don't catch — let it bubble). The CLI is the
 * caller and decides how to surface failures.
 */

/** Real-atomic write of one session-JSON file: full body is written to a
 *  per-writer `.tmp.<pid>.<rand>` then `rename()`-d to the target. The unique
 *  tmp suffix prevents two concurrent writers from stomping on each other's
 *  staging file — under the prior shared-`<path>.tmp` scheme the SECOND
 *  rename would throw ENOENT because the first rename had already consumed
 *  the source. With per-writer tmps, both renames target the same final path
 *  and POSIX `rename(2)` makes the LAST one win atomically. `writeFile` (from
 *  the storage slice) auto-creates parents; `rename` requires both paths to
 *  be on the same filesystem (always true here — both live under
 *  `sessionsRoot()`). */
const writeSessionFile = async (path: string, body: string): Promise<void> => {
  const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
  await writeFile(tmp, body)
  try {
    await rename(tmp, path)
  } catch (e) {
    // Rename failed (e.g. EACCES on a read-only dir). Clean up our staging
    // file so it doesn't masquerade as a stale leftover on the next run.
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

/**
 * S19: zod-validated SavedSession schema. Every Message — including nested
 * ContentBlock — must shape-check before the file is accepted.
 *
 * Why this matters: the prior validator only checked the envelope, then
 * `parsed as SavedSession` cast the messages straight through. A corrupt or
 * forged session file could plant arbitrary objects into the working-memory
 * buffer that the agent loop would later happily feed to the LLM (or worse,
 * to a tool that duck-reads the content shape). Reject the whole file on
 * element-level mismatch — better to refuse a poisoned resume than to
 * silently load it.
 */
const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})
const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})
const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
})
const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
})
const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  thinkingBlockSchema,
])
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(contentBlockSchema),
})
const sessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number().finite(),
  lastTouched: z.number().finite(),
  archived: z.boolean(),
})
const savedSessionSchema = z.object({
  version: z.literal(SESSION_VERSION),
  meta: sessionMetaSchema,
  reason: z.string(),
  turns: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
})

/** Strict read+parse of a `SavedSession` JSON. Returns `undefined` on
 *  missing/parse-error AND on shape mismatch — the latter is LOGGED with the
 *  zod error so an operator with a corrupt or forged session sees why the
 *  file was refused, instead of just an empty result. */
const readSavedSession = async (path: string): Promise<SavedSession | undefined> => {
  if (!(await fileExists(path))) return undefined
  let raw: string
  try {
    raw = await readFile(path)
  } catch (e) {
    logger.warn("session: read failed", {
      path,
      error: e instanceof Error ? e.message : String(e),
    })
    return undefined
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    logger.warn("session: malformed JSON — refusing to load", {
      path,
      error: e instanceof Error ? e.message : String(e),
    })
    return undefined
  }
  const result = savedSessionSchema.safeParse(json)
  if (!result.success) {
    logger.warn("session: schema mismatch — refusing to load", {
      path,
      issues: result.error.issues.slice(0, 5),
    })
    return undefined
  }
  return result.data as SavedSession
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
  // Deep-copy messages via structuredClone — defensive against later mutation
  // by the caller, and keeps the source untouched (fork MUST NOT mutate source).
  // Bun supports structuredClone natively and it's faster + safer than the old
  // JSON.parse(JSON.stringify(...)) round-trip (no Date/Map loss surprises).
  const messagesCopy = structuredClone(source.messages)
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

/** Path of the per-session JSONL event log (ADR-0034). Lives next to the
 *  snapshot JSON at `<sessionsRoot>/<id>.jsonl`. */
export const sessionEnvelopePath = (id: string): string => join(sessionsRoot(), `${id}.jsonl`)

/** Append-only seam for the JSONL envelope log (ADR-0034). Existing
 *  snapshot-based methods (saveSessionById/loadSessionById/…) are NOT
 *  affected — this is an additive rail. */
export const appendEnvelope = async (
  sessionId: string,
  record: SessionEnvelopeRecord,
): Promise<void> => {
  const line = encodeSessionLine(record)
  await appendSessionLine(sessionEnvelopePath(sessionId), line)
}
