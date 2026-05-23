/**
 * Session JSONL envelope (ADR-0034).
 *
 * One file per session lives at `<sessionsRoot>/<id>.jsonl` (NEW rail next to
 * the existing `<id>.json` snapshot — the snapshot stays as the V2 schema
 * source-of-truth for resume; the JSONL is the append-only event log for
 * deterministic replay and subagent thread linkage).
 *
 * Five top-level record kinds:
 *   1. session_meta   — written exactly once at session open.
 *   2. turn_context   — written at the START of every turn; carries the 17
 *                       Codex fields + 2 v3-specific subagent linkage fields.
 *   3. event_msg      — observability events emitted during a turn.
 *   4. response_item  — model output items captured for replay.
 *   5. thread_spawn   — v3 subagent linkage record (see [[subagent-sota-hardening]]).
 *
 * Strict zod everywhere — `.strict()` on every object; the `custom` escape
 * hatch in `event_msg` requires an explicit `kind: string` so a typo cannot
 * silently slip in.
 */
import { z } from "zod"

export const SESSION_ENVELOPE_VERSION = 1 as const

/* ------------------------------------------------------------------ */
/* shared field schemas                                                */
/* ------------------------------------------------------------------ */

const NonEmptyString = z.string().min(1)
const Iso8601 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
const Iana = z.string().regex(/^[A-Za-z]+(?:[_/][A-Za-z0-9+\-_]+)*$/)

/* ------------------------------------------------------------------ */
/* 1. session_meta                                                     */
/* ------------------------------------------------------------------ */

export const SessionMetaRecordSchema = z
  .object({
    type: z.literal("session_meta"),
    schema_version: z.literal(SESSION_ENVELOPE_VERSION),
    session_id: NonEmptyString,
    started_at: Iso8601,
    cwd: NonEmptyString,
    cli_version: NonEmptyString,
    model: NonEmptyString,
    // ADR-0106 git fingerprint (Codex §18.9). Each field is optional —
    // a detached HEAD has SHA but no branch, a local-only repo has branch
    // but no origin URL, a non-git cwd has none. Replay / debugging /
    // reproducibility surfaces consume these when present.
    git_sha: NonEmptyString.optional(),
    git_branch: NonEmptyString.optional(),
    git_origin_url: NonEmptyString.optional(),
  })
  .strict()
export type SessionMetaRecord = z.infer<typeof SessionMetaRecordSchema>

/* ------------------------------------------------------------------ */
/* 2. turn_context  — 17 Codex fields + 2 v3-extension fields          */
/* ------------------------------------------------------------------ */

export const ApprovalPolicySchema = z.enum(["never", "on-request", "on-failure", "untrusted"])
export const SandboxPolicySchema = z.enum([
  "danger-full-access",
  "read-only",
  "workspace-write",
  "isolated",
])
export const PermissionProfileSchema = z.enum(["default", "trusted", "restricted", "custom"])
export const CollaborationModeSchema = z.enum(["solo", "pair", "review", "supervised"])
export const EffortSchema = z.enum(["low", "medium", "high", "max"])
export const TruncationPolicySchema = z.enum(["head", "tail", "middle", "summarize", "none"])
export const ThreadRoleSchema = z.enum(["root", "subagent"])

export const TurnContextRecordSchema = z
  .object({
    type: z.literal("turn_context"),
    schema_version: z.literal(SESSION_ENVELOPE_VERSION),
    /** 1 */ turn_id: NonEmptyString,
    /** 2 */ cwd: NonEmptyString,
    /** 3 */ current_date: Iso8601,
    /** 4 */ timezone: Iana,
    /** 5 */ approval_policy: ApprovalPolicySchema,
    /** 6 */ sandbox_policy: SandboxPolicySchema,
    /** 7 */ permission_profile: PermissionProfileSchema,
    /** 8 */ model: NonEmptyString,
    /** 9 */ personality: NonEmptyString,
    /** 10 */ collaboration_mode: CollaborationModeSchema,
    /** 11 */ realtime_active: z.boolean(),
    /** 12 */ effort: EffortSchema,
    /** 13 */ summary: z.string(),
    /** 14 */ user_instructions: z.string(),
    /** 15 */ truncation_policy: TruncationPolicySchema,
    // v3 extensions — see ADR-0034 §결정 part B.
    /** v3-1 (parent for subagent threads, null for root) */
    parent_thread_id: NonEmptyString.nullable(),
    /** v3-2 (root or subagent — drives prompt + admissibility) */
    thread_role: ThreadRoleSchema,
  })
  .strict()
export type TurnContextRecord = z.infer<typeof TurnContextRecordSchema>

/* ------------------------------------------------------------------ */
/* 3. event_msg                                                        */
/* ------------------------------------------------------------------ */

const EventBase = {
  type: z.literal("event_msg"),
  schema_version: z.literal(SESSION_ENVELOPE_VERSION),
  ts: Iso8601,
  turn_id: NonEmptyString,
}

export const EventTaskStartedSchema = z
  .object({
    ...EventBase,
    kind: z.literal("task_started"),
    task: NonEmptyString,
  })
  .strict()

export const EventUserMessageSchema = z
  .object({
    ...EventBase,
    kind: z.literal("user_message"),
    content: z.string(),
  })
  .strict()

export const EventTokenCountSchema = z
  .object({
    ...EventBase,
    kind: z.literal("token_count"),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict()

export const EventTurnAbortedSchema = z
  .object({
    ...EventBase,
    kind: z.literal("turn_aborted"),
    reason: NonEmptyString,
  })
  .strict()

export const EventToolInvokeSchema = z
  .object({
    ...EventBase,
    kind: z.literal("tool_invoke"),
    tool: NonEmptyString,
    input: z.record(z.unknown()),
  })
  .strict()

export const EventToolResultSchema = z
  .object({
    ...EventBase,
    kind: z.literal("tool_result"),
    tool: NonEmptyString,
    ok: z.boolean(),
    output: z.string(),
  })
  .strict()

/** Escape hatch for v3-specific events — `kind` is REQUIRED and must be a
 *  non-empty string so that an unknown event still self-identifies. Any
 *  additional structured payload goes under `data` (free-form, but the field
 *  itself is required for shape consistency). */
export const EventCustomSchema = z
  .object({
    ...EventBase,
    kind: z.literal("custom"),
    custom_kind: NonEmptyString,
    data: z.record(z.unknown()),
  })
  .strict()

export const EventMsgRecordSchema = z.discriminatedUnion("kind", [
  EventTaskStartedSchema,
  EventUserMessageSchema,
  EventTokenCountSchema,
  EventTurnAbortedSchema,
  EventToolInvokeSchema,
  EventToolResultSchema,
  EventCustomSchema,
])
export type EventMsgRecord = z.infer<typeof EventMsgRecordSchema>

/* ------------------------------------------------------------------ */
/* 4. response_item                                                    */
/* ------------------------------------------------------------------ */

export const ResponseItemKindSchema = z.enum([
  "assistant_text",
  "assistant_tool_use",
  "assistant_reasoning",
])

export const ResponseItemRecordSchema = z
  .object({
    type: z.literal("response_item"),
    schema_version: z.literal(SESSION_ENVELOPE_VERSION),
    turn_id: NonEmptyString,
    item_kind: ResponseItemKindSchema,
    index: z.number().int().nonnegative(),
    content: z.string(),
  })
  .strict()
export type ResponseItemRecord = z.infer<typeof ResponseItemRecordSchema>

/* ------------------------------------------------------------------ */
/* 5. thread_spawn (subagent linkage — v3-specific)                    */
/* ------------------------------------------------------------------ */

export const ThreadSpawnRecordSchema = z
  .object({
    type: z.literal("thread_spawn"),
    schema_version: z.literal(SESSION_ENVELOPE_VERSION),
    parent_session_id: NonEmptyString,
    parent_turn_id: NonEmptyString,
    child_session_id: NonEmptyString,
    child_task_kind: NonEmptyString,
    spawned_at: Iso8601,
  })
  .strict()
export type ThreadSpawnRecord = z.infer<typeof ThreadSpawnRecordSchema>

/* ------------------------------------------------------------------ */
/* top-level union                                                     */
/* ------------------------------------------------------------------ */

/** Top-level union. We use `z.union` (not `z.discriminatedUnion`) because
 *  one of the variants (`EventMsgRecordSchema`) is itself a discriminated
 *  union on a nested `kind` field, which zod's discriminator scanner can't
 *  introspect through. `z.union` does sequential `safeParse` with each
 *  variant — slightly slower than discriminator dispatch but semantically
 *  equivalent (and our error reporting in the codec layer reads from the
 *  innermost issue list either way). */
export const SessionEnvelopeRecordSchema = z.union([
  SessionMetaRecordSchema,
  TurnContextRecordSchema,
  EventMsgRecordSchema,
  ResponseItemRecordSchema,
  ThreadSpawnRecordSchema,
])
export type SessionEnvelopeRecord = z.infer<typeof SessionEnvelopeRecordSchema>
