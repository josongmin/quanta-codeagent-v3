import { rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Message } from "@/llm"
import { errMessage, logger, reconcileToolPairing } from "@/shared"
import { fileExists, readFile, writeFile } from "@/storage"
import type { SessionEnvelopeRecord } from "./envelope"
import { appendSessionLine, encodeSessionLine } from "./envelope-encoder"
import { listSessions, removeFromIndex, upsertMeta } from "./index-store"
import {
  archivedFilePath,
  archivedFilePathAsync,
  sanitizeId,
  sessionFilePath,
  sessionFilePathAsync,
  sessionsRoot,
  sessionsRootAsync,
} from "./paths"
import type { SessionRootProvider } from "./root-port"
import { type SavedSession, type SavePayload, SESSION_VERSION, type SessionMeta } from "./types"

/** Resolve `<root>/<id>.json` honoring an optional provider. When no
 *  provider is passed, the resolved path is byte-identical to
 *  `sessionFilePath(id)` (legacy sync resolver). */
const resolveSessionFilePath = (
  id: string,
  provider: SessionRootProvider | undefined,
): Promise<string> | string =>
  provider === undefined ? sessionFilePath(id) : sessionFilePathAsync(id, provider)

/** Resolve `<root>/archived/<id>.json` honoring an optional provider. */
const resolveArchivedFilePath = (
  id: string,
  provider: SessionRootProvider | undefined,
): Promise<string> | string =>
  provider === undefined ? archivedFilePath(id) : archivedFilePathAsync(id, provider)

/**
 * B4 follow-up (jun-04) — reconcile dangling `tool_use`↔`tool_result` pairs in
 * a `Message[]` BEFORE it is persisted to disk by `rewindToMessage` (whose
 * truncation can SPLIT a pair) or `forkSession` (which can PROPAGATE a dangling
 * pair from the source tail). Re-sending such a transcript is an Anthropic /
 * OpenAI 400, so repairing it on the WRITE path means the stored file is
 * model-valid the instant it is written (defense in depth — the resume-READ
 * path also cleans on the way out via `@/runner/orchestrate/resume-fsm.ts`).
 *
 * The repair logic is the pure, deterministic `reconcileToolPairing` pass that
 * lives in the `@/shared` leaf (shared by the read-path through the
 * `@/memory/history-sanitization` re-export). The `@/session` slice may not
 * import `@/memory` (biome `noRestrictedImports`), so the shared home is the
 * leaf both slices reach.
 *
 * Returns a mutable `Message[]`: `reconcileToolPairing` returns the SAME array
 * reference when nothing was reconciled (the common case — byte-identical), and
 * that input is already a `Message[]` here, so no extra allocation occurs on
 * the happy path. When a repair happened it returns a fresh `Message[]`. The
 * structural `MsgLike` shape it operates on is satisfied by `Message` (`role` +
 * `content[]` with `tool_use` / `tool_result` blocks); the cast is the same
 * minimal structural cast the resume-fsm wiring uses.
 */
const reconcileMessages = (messages: Message[]): Message[] =>
  reconcileToolPairing(messages) as Message[]

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
// IMPORTANT: these element schemas MUST stay LOSSLESS w.r.t. the `ContentBlock`
// union in `@/llm` (TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock
// | ImageBlock). zod strips unknown keys on `safeParse`, so any optional field
// dropped here is silently LOST on resume — and any block variant omitted makes
// a *valid* session refuse to load. Both are resume-fidelity bugs. Mirror every
// field/variant the producers can persist:
//   - TextBlock.phase           (ADR-0077 phase marker)
//   - ThinkingBlock.signature   (Anthropic carry-back — missing ⇒ 400 on resume)
//   - ThinkingBlock.redacted    (encrypted reasoning preservation)
//   - ImageBlock                (ADR-0083 multimodal input)
//   - DocumentBlock             (ADR-0137 native-PDF document input)
//   - ToolResultBlock.contentBlocks (ADR-0126/0137 structured tool-result
//                                payload: text + ImageBlock + DocumentBlock)
const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  phase: z.enum(["commentary", "final_answer"]).optional(),
})
const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})
const imageBlockSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mediaType: z.string(),
})
const documentBlockSchema = z.object({
  type: z.literal("document"),
  data: z.string(),
  mediaType: z.string(),
})
const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
  // ADR-0126 / ADR-0137 — OPTIONAL structured content mirroring
  // `ToolResultBlock.contentBlocks` (@/llm types.ts). Produced live by
  // dispatch's `composeToolResultContent` as `[{type:"text",text},
  // ...ImageBlock, ...DocumentBlock]` when a tool emits images/documents
  // (read_image, web_fetch). Omitting it here would make zod strip the visual
  // payload on resume/fork/export — a lossy round-trip. Reuse the same
  // image/document element schemas defined above (do NOT invent new shapes).
  contentBlocks: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }),
        imageBlockSchema,
        documentBlockSchema,
      ]),
    )
    .optional(),
  is_error: z.boolean().optional(),
})
const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
  redacted: z.literal(true).optional(),
})
const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  thinkingBlockSchema,
  imageBlockSchema,
  documentBlockSchema,
])
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(contentBlockSchema),
  /**
   * Optional stable id for message-granularity rewind. Absent on legacy
   * sessions → byte-identical default-OFF. Present only on sessions that
   * pass through `assignMessageIds` (new sessions / rewind UX).
   */
  id: z.string().min(1).optional(),
})
const sessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number().finite(),
  lastTouched: z.number().finite(),
  archived: z.boolean(),
  gitSha: z.string().min(1).optional(),
  gitBranch: z.string().min(1).optional(),
  gitOriginUrl: z.string().min(1).optional(),
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
      error: errMessage(e),
    })
    return undefined
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    logger.warn("session: malformed JSON — refusing to load", {
      path,
      error: errMessage(e),
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

/**
 * Commit the derived `index.jsonl` entry AFTER the per-id snapshot JSON has
 * already been written (the snapshot is the source of truth; the index is a
 * derived cache). (L9 M6) If `upsertMeta` throws (e.g. index rename EACCES),
 * the snapshot is ALREADY durable on disk — propagating the throw would make
 * the whole save look failed while the session actually exists, and a
 * listing-driven UI would never list it (so reconcile-on-load never fires to
 * self-heal). Instead we surface the index failure as a typed partial-success
 * warning and DO NOT rethrow: the snapshot stands, and the next
 * `loadSessionById` of this id re-upserts via `reconcileIndexFromMeta`. This
 * is the compensating path for "snapshot ahead of index".
 */
const commitMetaAfterSnapshot = async (
  meta: SessionMeta,
  provider: SessionRootProvider | undefined,
): Promise<void> => {
  try {
    await upsertMeta(meta, provider)
  } catch (e) {
    logger.warn(
      `session ${meta.id}: snapshot committed but index upsert failed (${errMessage(e)}); ` +
        `session is durable on disk and the index self-heals on next load.`,
    )
  }
}

export const saveSessionById = async (
  meta: SessionMeta,
  payload: SavePayload,
  provider?: SessionRootProvider,
): Promise<void> => {
  const touched: SessionMeta = { ...meta, lastTouched: Date.now() }
  const path = touched.archived
    ? await resolveArchivedFilePath(touched.id, provider)
    : await resolveSessionFilePath(touched.id, provider)
  const saved: SavedSession = {
    version: SESSION_VERSION,
    meta: touched,
    reason: payload.reason,
    turns: payload.turns,
    messages: payload.messages,
  }
  await writeSessionFile(path, JSON.stringify(saved))
  await commitMetaAfterSnapshot(touched, provider)
}

/** Reconcile the lightweight index with a session's on-disk meta. The per-id
 *  JSON file is the source of truth (it is written FIRST in every mutator);
 *  `index.jsonl` is a derived cache written SECOND. A crash in that window
 *  leaves the JSON correct but the index stale/absent, so the session goes
 *  missing from `listSessions`. We self-heal here on load: if the index entry
 *  differs from (or is missing relative to) the on-disk meta, re-upsert. This
 *  is bounded (one session, only when divergent) and idempotent — the common
 *  case (index already matches) does NOT write, so steady-state behavior is
 *  byte-identical. */
const reconcileIndexFromMeta = async (
  meta: SessionMeta,
  provider?: SessionRootProvider,
): Promise<void> => {
  const known = (await listSessions({ includeArchived: true }, provider)).find(
    (m) => m.id === meta.id,
  )
  if (
    known !== undefined &&
    known.title === meta.title &&
    known.cwd === meta.cwd &&
    known.createdAt === meta.createdAt &&
    known.lastTouched === meta.lastTouched &&
    known.archived === meta.archived &&
    known.gitSha === meta.gitSha &&
    known.gitBranch === meta.gitBranch &&
    known.gitOriginUrl === meta.gitOriginUrl
  ) {
    return // index already agrees — no write
  }
  await upsertMeta(meta, provider)
}

export const loadSessionById = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<SavedSession | undefined> => {
  const active = await readSavedSession(await resolveSessionFilePath(id, provider))
  if (active !== undefined) {
    await reconcileIndexFromMeta(active.meta, provider)
    return active
  }
  const archived = await readSavedSession(await resolveArchivedFilePath(id, provider))
  if (archived !== undefined) await reconcileIndexFromMeta(archived.meta, provider)
  return archived
}

export const archiveSession = async (id: string, provider?: SessionRootProvider): Promise<void> => {
  const activePath = await resolveSessionFilePath(id, provider)
  const archivedPath = await resolveArchivedFilePath(id, provider)
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
    await commitMetaAfterSnapshot(nextMeta, provider)
    return
  }
  const existing = await readSavedSession(activePath)
  if (existing === undefined) return
  const nextMeta: SessionMeta = { ...existing.meta, archived: true, lastTouched: Date.now() }
  const updated: SavedSession = { ...existing, meta: nextMeta }
  await writeSessionFile(archivedPath, JSON.stringify(updated))
  await removeFileIfExists(activePath)
  await commitMetaAfterSnapshot(nextMeta, provider)
}

export const unarchiveSession = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<void> => {
  const activePath = await resolveSessionFilePath(id, provider)
  const archivedPath = await resolveArchivedFilePath(id, provider)
  const archivedExists = await fileExists(archivedPath)
  if (!archivedExists) {
    // Possibly already active — reconcile the flag if needed.
    const existing = await readSavedSession(activePath)
    if (existing === undefined) return
    if (!existing.meta.archived) return
    const nextMeta: SessionMeta = { ...existing.meta, archived: false, lastTouched: Date.now() }
    const updated: SavedSession = { ...existing, meta: nextMeta }
    await writeSessionFile(activePath, JSON.stringify(updated))
    await commitMetaAfterSnapshot(nextMeta, provider)
    return
  }
  const existing = await readSavedSession(archivedPath)
  if (existing === undefined) return
  const nextMeta: SessionMeta = { ...existing.meta, archived: false, lastTouched: Date.now() }
  const updated: SavedSession = { ...existing, meta: nextMeta }
  await writeSessionFile(activePath, JSON.stringify(updated))
  await removeFileIfExists(archivedPath)
  await commitMetaAfterSnapshot(nextMeta, provider)
}

export const renameSession = async (
  id: string,
  title: string,
  provider?: SessionRootProvider,
): Promise<void> => {
  const existing = await loadSessionById(id, provider)
  if (existing === undefined) return
  const nextMeta: SessionMeta = { ...existing.meta, title, lastTouched: Date.now() }
  const path = nextMeta.archived
    ? await resolveArchivedFilePath(id, provider)
    : await resolveSessionFilePath(id, provider)
  const updated: SavedSession = { ...existing, meta: nextMeta }
  await writeSessionFile(path, JSON.stringify(updated))
  await commitMetaAfterSnapshot(nextMeta, provider)
}

export const forkSession = async (
  id: string,
  opts?: { newId?: string; title?: string; cwd?: string },
  provider?: SessionRootProvider,
): Promise<string> => {
  const source = await loadSessionById(id, provider)
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
  // B4 follow-up (jun-04): a fork propagates whatever dangling pair the source
  // tail already carries (the live-turn closeout never sealed it, or a prior
  // rewind split it). Reconcile the cloned messages before writing so the
  // forked file is model-valid on disk immediately — same defense-in-depth
  // rationale as `rewindToMessage`. Byte-identical when nothing to reconcile.
  const saved: SavedSession = {
    version: SESSION_VERSION,
    meta: newMeta,
    reason: source.reason,
    turns: source.turns,
    messages: reconcileMessages(messagesCopy),
  }
  await writeSessionFile(await resolveSessionFilePath(newId, provider), JSON.stringify(saved))
  await commitMetaAfterSnapshot(newMeta, provider)
  return newId
}

export const deleteSession = async (id: string, provider?: SessionRootProvider): Promise<void> => {
  await removeFileIfExists(await resolveSessionFilePath(id, provider))
  await removeFileIfExists(await resolveArchivedFilePath(id, provider))
  await removeFromIndex(id, provider)
}

/** Path of the per-session JSONL event log (ADR-0034). Lives next to the
 *  snapshot JSON at `<sessionsRoot>/<id>.jsonl`. */
export const sessionEnvelopePath = (id: string): string =>
  join(sessionsRoot(), `${sanitizeId(id)}.jsonl`)

/** Provider-aware twin of {@link sessionEnvelopePath}. Multi-tenant
 *  surfaces resolve through their injected {@link SessionRootProvider};
 *  passing `undefined` is byte-identical to the sync resolver. */
export const sessionEnvelopePathAsync = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<string> => join(await sessionsRootAsync(provider), `${sanitizeId(id)}.jsonl`)

/** Append-only seam for the JSONL envelope log (ADR-0034). Existing
 *  snapshot-based methods (saveSessionById/loadSessionById/…) are NOT
 *  affected — this is an additive rail. */
export const appendEnvelope = async (
  sessionId: string,
  record: SessionEnvelopeRecord,
  provider?: SessionRootProvider,
): Promise<void> => {
  const line = encodeSessionLine(record)
  const path =
    provider === undefined
      ? sessionEnvelopePath(sessionId)
      : await sessionEnvelopePathAsync(sessionId, provider)
  await appendSessionLine(path, line)
}

/**
 * Mint stable ids on any message that lacks one (Claude Desktop 1.7196.3
 * parity — message-granularity rewind requires each message be addressable).
 * Pure function: returns a new array; the input is not mutated. Messages
 * that already carry an `id` are passed through byte-identically.
 *
 * Ids are minted via `crypto.randomUUID()` (matches the existing convention
 * in this slice — see `writeSessionFile` and `forkSession`). Callers can
 * pass an `idFor(index)` override for deterministic tests.
 */
export const assignMessageIds = (
  messages: readonly Message[],
  idFor?: (index: number) => string,
): Message[] => {
  return messages.map((m, i) => {
    if (typeof m.id === "string" && m.id.length > 0) return { ...m }
    return { ...m, id: idFor ? idFor(i) : crypto.randomUUID() }
  })
}

/**
 * Truncate `sessionId`'s transcript so the message with `msgId` is the LAST
 * message — every message AFTER it is removed. The named message itself is
 * preserved (Claude Desktop semantics: you rewind TO a checkpoint, not
 * past it).
 *
 * Returns `{ removed }`. Missing session, empty transcript, and unknown
 * `msgId` are no-ops returning `removed: 0` — never throws.
 *
 * The JSONL envelope log (ADR-0034) is NOT truncated here: it is an
 * append-only event log, and downstream replay can intersect it with the
 * current snapshot. (Phase-A scope; envelope truncation can be layered as
 * a follow-up if a concrete need surfaces.)
 */
export const rewindToMessage = async (
  sessionId: string,
  msgId: string,
  provider?: SessionRootProvider,
): Promise<{ removed: number }> => {
  const existing = await loadSessionById(sessionId, provider)
  if (existing === undefined) return { removed: 0 }
  if (existing.messages.length === 0) return { removed: 0 }
  const idx = existing.messages.findIndex((m) => m.id === msgId)
  if (idx < 0) return { removed: 0 }
  const removed = existing.messages.length - (idx + 1)
  if (removed === 0) return { removed: 0 }
  const truncated = existing.messages.slice(0, idx + 1)
  // B4 follow-up (jun-04): truncating at `idx+1` can SPLIT a `tool_use`↔
  // `tool_result` pair — if the message at `idx` is an assistant turn whose
  // `tool_result` lived in a now-removed later message, the persisted file
  // would carry a dangling `tool_use` → an Anthropic/OpenAI 400 on the next
  // send. Reconcile so the ON-DISK snapshot is already model-valid (defense in
  // depth: the resume-read path cleans on the way out too, but repairing here
  // means the stored file is valid the instant rewind writes it — and the
  // truncation point is EXACTLY where pairs get split). Byte-identical when
  // there is nothing to reconcile (same array reference returned).
  const reconciled = reconcileMessages(truncated)
  const nextMeta: SessionMeta = { ...existing.meta, lastTouched: Date.now() }
  const updated: SavedSession = {
    ...existing,
    meta: nextMeta,
    messages: reconciled,
  }
  const path = nextMeta.archived
    ? await resolveArchivedFilePath(sessionId, provider)
    : await resolveSessionFilePath(sessionId, provider)
  await writeSessionFile(path, JSON.stringify(updated))
  await commitMetaAfterSnapshot(nextMeta, provider)
  return { removed }
}
