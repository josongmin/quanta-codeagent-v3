import { rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Message } from "@/llm"
import { errMessage, logger, reconcileToolPairing } from "@/shared"
import { fileExists, readFile, writeFile } from "@/storage"
import type { SessionEnvelopeRecord } from "./envelope"
import { appendSessionLine, encodeSessionLine } from "./envelope-encoder"
import { cloneObjectiveForFork } from "./fork-objective"
import { listSessions, removeFromIndex, upsertMeta } from "./index-store"
import { persistedVerifierExecutionPostureSchema } from "./objective-posture-schema"
import {
  archivedFilePath,
  archivedFilePathAsync,
  sanitizeId,
  sessionFilePath,
  sessionFilePathAsync,
  sessionsRoot,
  sessionsRootAsync,
} from "./paths"
import { rollbackCheckpointRecordSchema, rollbackOperationRecordSchema } from "./rollback-record"
import type { SessionRootProvider } from "./root-port"
import {
  OBJECTIVE_SNAPSHOT_VERSION,
  OBJECTIVE_SNAPSHOT_VERSION_V1,
  type SavedSession,
  type SavePayload,
  SESSION_VERSION,
  type SessionMeta,
} from "./types"
import { workspaceOwnershipSchema } from "./workspace-ownership"

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
  // Fork lineage (jun-06): the source session id, set by `forkSession`. Optional
  // + `.min(1)` mirrors the git-fingerprint optionals' NonEmptyString discipline.
  // Non-strict schema ⇒ absent on legacy/non-fork files is valid (no migration).
  forkedFromId: z.string().min(1).optional(),
  // §8.2 (jun-08): Codex session-meta provenance. Optional + `.min(1)` mirrors
  // the discipline above. IMPORTANT: these MUST be mirrored here — zod strips
  // unknown keys on safeParse, so omitting them would silently LOSE the field on
  // every load (a resume-fidelity bug; see the LOSSLESS note above messageSchema).
  agentNickname: z.string().min(1).optional(),
  dynamicTools: z.array(z.string().min(1)).optional(),
  originator: z.string().min(1).optional(),
  threadSource: z.string().min(1).optional(),
  modelProvider: z.string().min(1).optional(),
  // §13.2 (jun-08): persisted interrupted-turn marker (crash resume). Same
  // mirror discipline — omitting it would strip the marker on load and the
  // restart-resume detection would never fire. `userText`/`partialAssistantText`
  // may legitimately be EMPTY (a crash before any assistant text), so NO `.min`.
  interruptedTurn: z
    .object({
      userText: z.string(),
      partialAssistantText: z.string(),
      reason: z.string().min(1),
      interruptedAt: z.number().finite(),
    })
    .optional(),
  // RFC-06 §RFC06-0 (aug-02): persisted WorkspaceOwnership. OPTIONAL — absent
  // on legacy/non-worktree sessions ⇒ the non-strict schema validates and
  // serialization is byte-identical. `recordVersion` is a literal and `state`
  // is a closed enum, so an UNKNOWN version/state fail-closes the WHOLE load
  // (never partially applied) — same fail-closed migration contract as the
  // rollback records below. MUST be mirrored here: zod strips unknown keys on
  // safeParse, so omitting it would silently LOSE the ownership record on every
  // load (a restart-durability bug; see the LOSSLESS note above messageSchema).
  workspaceOwnership: workspaceOwnershipSchema.optional(),
})
// RFC-03 C2 — the strict objective-snapshot decoder. LOSSLESS mirror of
// `PersistedObjectiveThread` (@/session/types) — the session slice never imports
// @/objective, so this schema is the pure JSON validator. zod strips unknown
// keys, so any field omitted here would be silently LOST on reopen (a resume-
// fidelity bug — same discipline as `messageSchema`). `version` is a literal, so
// an UNKNOWN objective-snapshot version fail-closes the WHOLE session load (never
// partially applied) — the fail-closed migration contract of RFC-03 C2.
// RFC-03 C4 — the persisted immutable check spec + completion evidence. zod
// strips unknown keys, so these MUST be modeled here or provenance would be
// silently LOST on reopen (the exact resume-fidelity bug this packet closes).
// The fields are OPTIONAL/ADDITIVE: a legacy criterion (no `kind`) validates and
// decodes as manual-with-no-provenance (schema migration; version does NOT bump).
const persistedObjectiveCheckSpecSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("command"),
  argv: z.array(z.string()),
  cwdPolicy: z.literal("thread"),
  timeoutMs: z.number().finite(),
  successExitCodes: z.array(z.number().finite()),
})
const persistedObjectiveCompletionSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("manual"),
    objectiveId: z.string().min(1).optional(),
    actor: z.string().min(1),
    objectiveRevision: z.number().finite(),
    verifiedAt: z.number().finite(),
  }),
  z.object({
    source: z.literal("verifier"),
    objectiveId: z.string().min(1).optional(),
    checkId: z.string().min(1),
    objectiveRevision: z.number().finite(),
    sourceDigest: z.string().min(1),
    executionPosture: persistedVerifierExecutionPostureSchema.optional(),
    verifierResult: z.object({ exitCode: z.number().finite(), passed: z.boolean() }),
    verifiedAt: z.number().finite(),
  }),
])
const persistedObjectiveCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  met: z.boolean(),
  kind: z.enum(["manual", "checked"]).optional(),
  check: persistedObjectiveCheckSpecSchema.optional(),
  completion: persistedObjectiveCompletionSchema.optional(),
})
const persistedObjectiveBlockerSchema = z.object({
  id: z.string(),
  reason: z.string(),
  waitingOn: z.string(),
  since: z.number().finite(),
})
const persistedBlockerObservationSchema = z.object({
  observationId: z.string().min(1),
  dependencyRef: z.string().min(1).max(2_100),
  waitingOn: z.enum(["user", "tool", "network", "child_agent"]),
  distinctAttemptIds: z.array(z.string().min(1).max(512)).min(1).max(2),
  lastObservedAt: z.number().finite().nonnegative(),
})
const persistedObjectiveBudgetSchema = z.object({
  maxTokens: z.number().finite().optional(),
  tokensUsed: z.number().finite(),
  maxTurns: z.number().finite().optional(),
  turnsUsed: z.number().finite(),
})
// Mirrors the objective-domain receipt bounds without importing that sibling
// slice across the session fence. Decode fails closed before a hostile session
// can inflate the in-memory objective authority.
const MAX_PERSISTED_PROGRESS_RECEIPTS = 16
const MAX_PERSISTED_PROGRESS_REFS = 32
const MAX_PERSISTED_PROGRESS_REF_LENGTH = 512
const progressRefSchema = z.string().min(1).max(MAX_PERSISTED_PROGRESS_REF_LENGTH)
const persistedProgressReceiptSchema = z.object({
  objectiveId: progressRefSchema.optional(),
  attemptKey: progressRefSchema,
  objectiveRevisionBefore: z.number().int().nonnegative(),
  objectiveRevisionAfter: z.number().int().nonnegative(),
  turnOutcome: z.enum([
    "completed",
    "max_turns",
    "aborted",
    "error",
    "budget_exhausted",
    "refusal",
    "awaiting_approval",
    "backgrounded",
  ]),
  criterionTransitions: z.array(progressRefSchema).max(MAX_PERSISTED_PROGRESS_REFS),
  verifierReceiptRefs: z.array(progressRefSchema).max(MAX_PERSISTED_PROGRESS_REFS),
  sourceDigest: progressRefSchema.optional(),
  remainingCriterionIds: z.array(progressRefSchema).max(MAX_PERSISTED_PROGRESS_REFS),
  recordedAt: z.number().finite().nonnegative(),
})
const persistedObjectiveThreadSchema = z.object({
  threadId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  goal: z.string(),
  successCriteria: z.array(persistedObjectiveCriterionSchema),
  status: z.string(),
  explicitStatus: z.enum(["active", "paused", "completed"]),
  usageLimitedUntil: z.number().finite().optional(),
  budget: persistedObjectiveBudgetSchema,
  blockers: z.array(persistedObjectiveBlockerSchema),
  blockerObservations: z.array(persistedBlockerObservationSchema).max(8).optional(),
  nextActions: z.array(z.string()),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  progressReceipts: z
    .array(persistedProgressReceiptSchema)
    .max(MAX_PERSISTED_PROGRESS_RECEIPTS)
    .optional(),
})
// GOAL-01 — the v2 thread envelope: generation identity + provenance in the
// body, `objective: null` as a cleared-thread TOMBSTONE that keeps its revision.
const persistedObjectiveBodyV2Schema = z.object({
  objectiveId: z.string().min(1).max(256),
  createdBy: z.string().min(1),
  migrationSource: z.literal("legacy-v1").optional(),
  goal: z.string(),
  successCriteria: z.array(persistedObjectiveCriterionSchema),
  status: z.string(),
  explicitStatus: z.enum(["active", "paused"]),
  usageLimitedUntil: z.number().finite().optional(),
  budget: persistedObjectiveBudgetSchema,
  blockers: z.array(persistedObjectiveBlockerSchema),
  nextActions: z.array(z.string()),
  attempts: z
    .object({
      autonomousTurnsStarted: z.number().int().nonnegative(),
      started: z
        .object({
          attemptId: z.string().min(1),
          provenance: z.string().min(1),
          executionMode: z.enum(["foreground", "background"]),
          startedRevision: z.number().int().nonnegative(),
          startedAt: z.number().finite(),
        })
        .optional(),
    })
    .optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  progressReceipts: z
    .array(persistedProgressReceiptSchema)
    .max(MAX_PERSISTED_PROGRESS_RECEIPTS)
    .optional(),
})
const persistedObjectiveThreadV2Schema = z.object({
  threadId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  objective: persistedObjectiveBodyV2Schema.nullable(),
})
// Both versions are LOADABLE (the raw version is preserved; the runner/assemble
// adapter migrates v1 -> v2 once). Any OTHER version fail-closes the whole load.
const objectiveSnapshotSchema = z.discriminatedUnion("version", [
  z.object({
    version: z.literal(OBJECTIVE_SNAPSHOT_VERSION_V1),
    threads: z.array(persistedObjectiveThreadSchema),
  }),
  z.object({
    version: z.literal(OBJECTIVE_SNAPSHOT_VERSION),
    threads: z.array(persistedObjectiveThreadV2Schema),
  }),
])
const savedSessionSchema = z.object({
  version: z.literal(SESSION_VERSION),
  meta: sessionMetaSchema,
  reason: z.string(),
  turns: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
  // RFC-03 C2 (aug-22) — durable objective snapshot. OPTIONAL: a legacy snapshot
  // (minted before this field) validates and reads back ABSENT (legacy/no
  // objective, never an inferred default). The `version` literal fail-closes the
  // WHOLE load on an unknown version.
  objective: objectiveSnapshotSchema.optional(),
  // A6 — durable usage-accounting state. OPAQUE by design: the authority owns
  // its codec (corrupt content is ITS hydrate's problem, surfaced as
  // continuity-lost), so the session schema only asserts "a string".
  usageAccounting: z.string().optional(),
  // RFC-01 A2 (aug-02) — durable rollback records. BOTH optional: a legacy
  // snapshot (minted before these fields) validates and the loader defaults
  // the absent collection to `[]` (see `readSavedSession`). The element
  // schemas pin `recordVersion` to a literal and the operation `state` to a
  // closed enum, so an UNKNOWN version/state fail-closes the WHOLE load (the
  // file is refused, never partially applied) — the fail-closed migration
  // contract in rfc-01-persistence-resume.md §RFC01-0.
  rollbackCheckpoints: z.array(rollbackCheckpointRecordSchema).optional(),
  rollbackOperations: z.array(rollbackOperationRecordSchema).optional(),
})

/** First message element that fails the S19 schema: its array index plus a
 *  compact rendering of the first zod issue (for the caller's error message). */
export interface InvalidMessageElement {
  readonly index: number
  readonly issue: string
}

/**
 * S19 element-level Message validator — exported for REUSE by the V1
 * path-mode loader (`src/agent/state.ts`, jun-10 silent-failure audit #14) so
 * both rails validate messages against the SAME lossless schema above (single
 * SSOT; no drift between V1 and V2 of what a persisted Message may contain).
 *
 * Pure CHECK, not a parse-replace: returns the index + first zod issue of the
 * first element that fails the Message shape, or `undefined` when every
 * element validates. Unlike `safeParse`-and-keep-`data`, callers keep their
 * ORIGINAL elements — zod's unknown-key stripping never rewrites the payload.
 */
export const firstInvalidMessageElement = (
  elements: readonly unknown[],
): InvalidMessageElement | undefined => {
  for (let i = 0; i < elements.length; i++) {
    const result = messageSchema.safeParse(elements[i])
    if (!result.success) {
      const first = result.error.issues[0]
      const at = first === undefined || first.path.length === 0 ? "" : ` at ${first.path.join(".")}`
      return { index: i, issue: `${first?.message ?? "invalid"}${at}` }
    }
  }
  return undefined
}

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

// RFC-01 A2 — per-session save serialization. `saveSessionById` is now a
// read-modify-write (rollback-ledger preserve), so two concurrent savers for the
// SAME session (e.g. the `@/agent` coordinator folding a rollback record while a
// crash-resume `markSessionInterrupted` fire-and-forgets an omitting save on a
// tool boundary) could interleave read→write and clobber the just-folded ledger
// (R3-A TOCTOU). Serialize the whole read→write per id so it is atomic. Different
// sessions still run in parallel; the chain drops when it drains (no per-id leak).
const saveSessionQueues = new Map<string, Promise<void>>()
const withSessionSaveLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const prev = saveSessionQueues.get(id) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined, // the chain must survive a rejected save (caller sees the reject)
  )
  saveSessionQueues.set(id, tail)
  void tail.then(() => {
    if (saveSessionQueues.get(id) === tail) saveSessionQueues.delete(id)
  })
  return run
}

export const saveSessionById = (
  meta: SessionMeta,
  payload: SavePayload,
  provider?: SessionRootProvider,
): Promise<void> =>
  withSessionSaveLock(meta.id, async () => {
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
