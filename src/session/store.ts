import { rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { Message } from "@/llm"
import { errMessage, logger, reconcileToolPairing } from "@/shared"
import { fileExists, readFile, writeFile } from "@/storage"
import type { SessionEnvelopeRecord } from "./envelope"
import { appendSessionLine, encodeSessionLine } from "./envelope-encoder"
import { cloneObjectiveForFork } from "./fork-objective"
import { admitSessionSave, markSessionDeleted, sessionGenerationOf } from "./generation"
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
import { withSessionSaveLock } from "./save-lock"
import type { SaveSessionOptions } from "./save-options"
import { foundSession, readSessionSnapshot, type SessionSnapshotRead } from "./saved-session-schema"
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
 * Convenience reads (`loadSessionById`) return `undefined` for missing AND
 * for corrupt/unreadable. Durable resume uses {@link readSessionByIdTyped}.
 * Writes throw only on programmer errors (we don't catch — let it bubble).
 */

export { StaleSessionGenerationError } from "./generation"
export type { SaveSessionOptions } from "./save-options"
export {
  firstInvalidMessageElement,
  type InvalidMessageElement,
  type SessionSnapshotRead,
} from "./saved-session-schema"

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

/** Convenience collapse of {@link readSessionSnapshot} for existing callers. */
const readSavedSession = async (path: string): Promise<SavedSession | undefined> =>
  foundSession(await readSessionSnapshot(path))

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

/** RFC-01 A2 — read the durable rollback ledger ALREADY on disk so a save whose
 *  payload OMITS the fields PRESERVES them instead of wiping them. Fail-soft: a
 *  missing / corrupt / legacy file ⇒ nothing to preserve (⇒ byte-identical). */
const readExistingDurable = async (
  path: string,
): Promise<
  Pick<SavedSession, "rollbackCheckpoints" | "rollbackOperations" | "objective" | "usageAccounting">
> => {
  if (!(await fileExists(path))) return {}
  try {
    const parsed = JSON.parse(await readFile(path)) as Partial<SavedSession>
    const out: Pick<
      SavedSession,
      "rollbackCheckpoints" | "rollbackOperations" | "objective" | "usageAccounting"
    > = {}
    // A6 — preserve the durable accounting state across an omitting save, the
    // same discipline as the ledger/objective rows below.
    if (typeof parsed.usageAccounting === "string") out.usageAccounting = parsed.usageAccounting
    if (Array.isArray(parsed.rollbackCheckpoints))
      out.rollbackCheckpoints = parsed.rollbackCheckpoints
    if (Array.isArray(parsed.rollbackOperations)) out.rollbackOperations = parsed.rollbackOperations
    // RFC-03 C2 — preserve the durable objective snapshot across an omitting save
    // (per-turn auto-save / crash-resume markers carry no objective) so a plain
    // transcript save never wipes it. The coordinator's explicit fold still wins.
    if (parsed.objective !== undefined && typeof parsed.objective === "object")
      out.objective = parsed.objective
    return out
  } catch (e) {
    // Corrupt/unreadable existing file ⇒ nothing to preserve. Attributed (not a
    // silent swallow): the same save then OVERWRITES it, so the ledger is not
    // strandable here — but a corrupt session file is worth surfacing.
    logger.warn("session: durable-state-preserve read failed", { path, error: errMessage(e) })
    return {}
  }
}

// RFC-01 A2 — per-session save serialization lives in `save-lock.ts`. Delete
// uses the same queue (SEP7-D-05) so a terminal delete cannot race a write.

export const saveSessionById = (
  meta: SessionMeta,
  payload: SavePayload,
  provider?: SessionRootProvider,
  opts?: SaveSessionOptions,
): Promise<void> => {
  const captured = sessionGenerationOf(meta.id)
  const create = opts?.create === true
  return withSessionSaveLock(meta.id, async () => {
    admitSessionSave(meta.id, captured, create)
    // R6 (final adversarial audit) — the caller's `meta.archived` can be STALE:
    // another surface may have archived (or unarchived) this session mid-turn, and
    // the per-turn auto-save reuses a long-lived `idMeta` snapshot that is never
    // re-synced from disk. Select the write path from DISK REALITY, not the
    // possibly-stale meta: write where the file actually is, and reconcile
    // `meta.archived` to match. This stops an omitting save from (a) RESURRECTING an
    // archived session onto the active path and (b) reading the now-empty active
    // file for the rollback-preserve below (silently dropping the ledger). NOTE:
    // within one process this composes with the save lock; ACROSS processes (two
    // `quanta` procs on one QUANTA_SESSIONS_DIR) it narrows but cannot fully close
    // the check→write window — a pre-existing store limitation that needs OS
    // file-locking, out of scope here.
    const activePath = await resolveSessionFilePath(meta.id, provider)
    const archivedPath = await resolveArchivedFilePath(meta.id, provider)
    const path = (await fileExists(activePath))
      ? activePath
      : (await fileExists(archivedPath))
        ? archivedPath
        : meta.archived
          ? archivedPath
          : activePath
    const touched: SessionMeta = {
      ...meta,
      archived: path === archivedPath,
      lastTouched: Date.now(),
    }
    // RFC-01 A2 + RFC-03 C2 — the durable side-records (rollback ledger + objective
    // snapshot) are PERSISTED ACROSS SAVES: a plain transcript save omits them, so
    // preserve the on-disk value; the explicit fold still wins. Only defined keys
    // are returned, so the spread is BYTE-IDENTICAL for a legacy/empty session.
    const durable = await resolveDurableRecords(payload, path)
    const saved: SavedSession = {
      version: SESSION_VERSION,
      meta: touched,
      reason: payload.reason,
      turns: payload.turns,
      messages: payload.messages,
      ...durable,
    }
    await writeSessionFile(path, JSON.stringify(saved))
    await commitMetaAfterSnapshot(touched, provider)
  })
}

/** RFC-01 A2 + RFC-03 C2 — resolve the durable side-records for a save: the
 *  payload's value wins; an OMITTED field is PRESERVED from disk (a plain
 *  transcript save never wipes the rollback ledger or objective snapshot). Only
 *  reads the existing file when at least one field is omitted. Returns ONLY the
 *  defined keys so the caller's spread serializes byte-identically for a
 *  legacy/empty session. Extracted to keep `saveSessionById` under the
 *  cognitive-complexity cap. */
const resolveDurableRecords = async (
  payload: SavePayload,
  path: string,
): Promise<
  Pick<SavedSession, "rollbackCheckpoints" | "rollbackOperations" | "objective" | "usageAccounting">
> => {
  const needPreserve =
    payload.rollbackCheckpoints === undefined ||
    payload.rollbackOperations === undefined ||
    payload.objective === undefined ||
    payload.usageAccounting === undefined
  const preserved = needPreserve ? await readExistingDurable(path) : {}
  const out: Pick<
    SavedSession,
    "rollbackCheckpoints" | "rollbackOperations" | "objective" | "usageAccounting"
  > = {}
  const rollbackCheckpoints = payload.rollbackCheckpoints ?? preserved.rollbackCheckpoints
  const rollbackOperations = payload.rollbackOperations ?? preserved.rollbackOperations
  const objective = payload.objective ?? preserved.objective
  const usageAccounting = payload.usageAccounting ?? preserved.usageAccounting
  if (rollbackCheckpoints !== undefined) out.rollbackCheckpoints = rollbackCheckpoints
  if (rollbackOperations !== undefined) out.rollbackOperations = rollbackOperations
  if (objective !== undefined) out.objective = objective
  if (usageAccounting !== undefined) out.usageAccounting = usageAccounting
  return out
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

export const readSessionByIdTyped = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<SessionSnapshotRead> => {
  const active = await readSessionSnapshot(await resolveSessionFilePath(id, provider))
  if (active.kind !== "missing") return active
  return readSessionSnapshot(await resolveArchivedFilePath(id, provider))
}

export const loadSessionById = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<SavedSession | undefined> => {
  const read = await readSessionByIdTyped(id, provider)
  if (read.kind !== "found") return undefined
  await reconcileIndexFromMeta(read.session.meta, provider)
  return read.session
}

/** RFC-01 A2 (R4) — ATOMIC read-modify-write of a session under the per-session
 *  save lock. `mutate` receives the FRESHLY-loaded snapshot (re-read INSIDE the
 *  lock, so it observes any concurrent rename/fold that already committed) and
 *  returns the next snapshot; the write happens under the same lock hold. This is
 *  how independent field-mutators avoid clobbering EACH OTHER's field: the
 *  `@/agent` rollback coordinator advances `rollbackOperations` HERE, while
 *  `renameSession` (meta.title, reached by the detached auto-titler) and
 *  `rewindToMessage` (messages) take the SAME `withSessionSaveLock` — whoever runs
 *  second re-reads the first's committed write and carries it forward via the
 *  full-snapshot spread. Returns false when the
 *  session is absent. Do NOT call `saveSessionById` from inside `mutate` — the
 *  lock is not re-entrant. */
export const updateSessionAtomic = (
  id: string,
  mutate: (s: SavedSession) => SavedSession,
  provider?: SessionRootProvider,
): Promise<boolean> =>
  withSessionSaveLock(id, async () => {
    const existing = await loadSessionById(id, provider)
    if (existing === undefined) return false
    const next = mutate(existing)
    const touchedMeta: SessionMeta = { ...next.meta, lastTouched: Date.now() }
    const path = touchedMeta.archived
      ? await resolveArchivedFilePath(id, provider)
      : await resolveSessionFilePath(id, provider)
    await writeSessionFile(path, JSON.stringify({ ...next, meta: touchedMeta }))
    await commitMetaAfterSnapshot(touchedMeta, provider)
    return true
  })

export const archiveSession = (id: string, provider?: SessionRootProvider): Promise<void> =>
  // Under the per-session save lock (R4): this load→modify→write must not
  // interleave with a coordinator rollback fold (saveSessionById), or the
  // full-snapshot rewrite would clobber a record folded in the load→write gap.
  withSessionSaveLock(id, async () => {
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
  })

export const unarchiveSession = (id: string, provider?: SessionRootProvider): Promise<void> =>
  withSessionSaveLock(id, async () => {
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
  })

export const renameSession = (
  id: string,
  title: string,
  provider?: SessionRootProvider,
): Promise<void> =>
  withSessionSaveLock(id, async () => {
    const existing = await loadSessionById(id, provider)
    if (existing === undefined) return
    const nextMeta: SessionMeta = { ...existing.meta, title, lastTouched: Date.now() }
    const path = nextMeta.archived
      ? await resolveArchivedFilePath(id, provider)
      : await resolveSessionFilePath(id, provider)
    const updated: SavedSession = { ...existing, meta: nextMeta }
    await writeSessionFile(path, JSON.stringify(updated))
    await commitMetaAfterSnapshot(nextMeta, provider)
  })

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
    // Fork lineage (jun-06): `id` is the source session id (this function's first
    // param), in scope right here — previously discarded, now persisted so the
    // `/fork` chain survives rename/reload. Each link records only its immediate
    // parent (a chain, not a flattened root).
    forkedFromId: id,
  }
  // Deep-copy messages via structuredClone — defensive against later mutation
  // by the caller, and keeps the source untouched (fork MUST NOT mutate source).
  // Bun supports structuredClone natively and it's faster + safer than the old
  // JSON.parse(JSON.stringify(...)) round-trip (no Date/Map loss surprises).
  const messagesCopy = structuredClone(source.messages)
  const forkedObjective = cloneObjectiveForFork(source.objective, id, newId, now)
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
    // A fork is a new objective generation: preserve the declaration but never
    // copy completion/progress/blockers or autonomous execution state.
    ...(forkedObjective !== undefined ? { objective: forkedObjective } : {}),
  }
  await writeSessionFile(await resolveSessionFilePath(newId, provider), JSON.stringify(saved))
  await commitMetaAfterSnapshot(newMeta, provider)
  return newId
}

export const deleteSession = async (id: string, provider?: SessionRootProvider): Promise<void> =>
  withSessionSaveLock(id, async () => {
    await removeFileIfExists(await resolveSessionFilePath(id, provider))
    await removeFileIfExists(await resolveArchivedFilePath(id, provider))
    await removeFromIndex(id, provider)
    markSessionDeleted(id)
  })

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
export const rewindToMessage = (
  sessionId: string,
  msgId: string,
  provider?: SessionRootProvider,
): Promise<{ removed: number }> =>
  // Per-session save lock (R4): serialize this load→modify→write with the
  // coordinator's rollback fold so a concurrent fold is not clobbered.
  withSessionSaveLock(sessionId, async () => {
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
  })
