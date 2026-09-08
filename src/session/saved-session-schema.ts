/**
 * SavedSession schema + typed snapshot read (SEP7-D-07).
 *
 * Extracted from store.ts so generation/delete/typed-read edits cannot push
 * that module through the 1000-line god-MODULE gate.
 */
import { z } from "zod"
import { errMessage, logger } from "@/shared"
import { fileExists, readFile } from "@/storage"
import {
  persistedBlockerObservationSchema,
  persistedObjectiveBlockerSchema,
} from "./objective-blocker-schema"
import { persistedVerifierExecutionPostureSchema } from "./objective-posture-schema"
import { rollbackCheckpointRecordSchema, rollbackOperationRecordSchema } from "./rollback-record"
import {
  OBJECTIVE_SNAPSHOT_VERSION,
  OBJECTIVE_SNAPSHOT_VERSION_V1,
  type SavedSession,
  SESSION_VERSION,
} from "./types"
import { workspaceOwnershipSchema } from "./workspace-ownership"

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
  blockerObservations: z.array(persistedBlockerObservationSchema).max(8).optional(),
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

export type SessionSnapshotRead =
  | { readonly kind: "found"; readonly session: SavedSession }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }

/** Typed snapshot file read. Missing is distinct from corrupt/unreadable. */
export const readSessionSnapshot = async (path: string): Promise<SessionSnapshotRead> => {
  if (!(await fileExists(path))) return { kind: "missing" }
  let raw: string
  try {
    raw = await readFile(path)
  } catch (e) {
    const reason = errMessage(e)
    logger.warn("session: read failed", { path, error: reason })
    return { kind: "unreadable", reason }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    const reason = errMessage(e)
    logger.warn("session: malformed JSON — refusing to load", { path, error: reason })
    return { kind: "corrupt", reason }
  }
  const result = savedSessionSchema.safeParse(json)
  if (!result.success) {
    const reason = result.error.issues
      .slice(0, 5)
      .map((i) => i.message)
      .join("; ")
    logger.warn("session: schema mismatch — refusing to load", {
      path,
      issues: result.error.issues.slice(0, 5),
    })
    return { kind: "corrupt", reason }
  }
  return { kind: "found", session: result.data as SavedSession }
}

export const foundSession = (read: SessionSnapshotRead): SavedSession | undefined =>
  read.kind === "found" ? read.session : undefined
