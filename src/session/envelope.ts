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

/**
 * ADR-0135 — SESSION_ENVELOPE_VERSION bumped from 1 → 2 to admit the layered
 * permission model (struct-shaped `permission_profile` + optional
 * `file_system_sandbox_policy`). Backward compatibility is preserved at the
 * schema level:
 *   - {@link SchemaVersionSchema} is a UNION of {1, 2}, so a v1 record on
 *     disk continues to decode without error.
 *   - `permission_profile` accepts BOTH the legacy enum AND the new struct
 *     shape (see {@link PermissionProfileFieldSchema}).
 *   - Encoder/decoder are pure projections — they NEVER coerce shape on the
 *     wire. A v1 input round-trips to byte-identical v1 output; a v2 input
 *     round-trips to byte-identical v2 output.
 */
export const SESSION_ENVELOPE_VERSION = 2 as const
/** All schema versions the decoder accepts. New versions append; legacy
 *  versions remain decodable so historical sessions still load. */
export const SUPPORTED_SESSION_ENVELOPE_VERSIONS = [1, 2] as const

/* ------------------------------------------------------------------ */
/* shared field schemas                                                */
/* ------------------------------------------------------------------ */

const NonEmptyString = z.string().min(1)
const Iso8601 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
const Iana = z.string().regex(/^[A-Za-z]+(?:[_/][A-Za-z0-9+\-_]+)*$/)

/** Closed `schema_version` union — every record schema references this. The
 *  union (not `z.literal(SESSION_ENVELOPE_VERSION)`) is what makes v1 records
 *  on disk continue to load after the v2 bump. */
const SchemaVersionSchema = z.union([z.literal(1), z.literal(2)])

/* ------------------------------------------------------------------ */
/* 1. session_meta                                                     */
/* ------------------------------------------------------------------ */

export const SessionMetaRecordSchema = z
  .object({
    type: z.literal("session_meta"),
    schema_version: SchemaVersionSchema,
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

/* ------------------------------------------------------------------ */
/* ADR-0135 — struct-shaped permission profile (envelope mirror).      */
/*                                                                     */
/* These schemas mirror the type catalogue in                          */
/* `src/permission/permission-profile.ts` for on-the-wire decode.      */
/* Keep them in sync: the source-of-truth is the `@/permission` types; */
/* the envelope schema is the wire validator. A divergence is caught   */
/* by the `envelope-permission-migration` test which round-trips a     */
/* canonical fixture through both layers.                              */
/* ------------------------------------------------------------------ */

/** 8 special path kinds — exact mirror of {@link SpecialPathKind}. */
export const SpecialPathKindSchema = z.enum([
  "root",
  "project",
  "tmpdir",
  "git",
  "agents",
  "quanta",
  "slash_tmp",
  "tmp",
])

/** Discriminated union — { type: "special", kind } | { type: "path", value }. */
export const FileSystemPathSchema = z.union([
  z.object({ type: z.literal("special"), kind: SpecialPathKindSchema }).strict(),
  z.object({ type: z.literal("path"), value: NonEmptyString }).strict(),
])

export const FileSystemAccessSchema = z.enum(["read", "write"])

export const FileSystemEntrySchema = z
  .object({ path: FileSystemPathSchema, access: FileSystemAccessSchema })
  .strict()

export const FileSystemPolicyTypeSchema = z.enum(["restricted", "managed"])

/** The struct-shape file-system layer — used both inside
 *  `PermissionProfileStructSchema` and as the standalone optional
 *  `file_system_sandbox_policy` field on turn_context (ADR-0135 layer 2). */
export const FileSystemSandboxPolicySchema = z
  .object({
    type: FileSystemPolicyTypeSchema,
    entries: z.array(FileSystemEntrySchema),
  })
  .strict()

export const ApprovalModeSchema = z.enum(["auto", "once", "session", "always"])
export const ApprovalPolicyStructSchema = z
  .object({ mode: ApprovalModeSchema, promptUser: z.boolean() })
  .strict()

export const NetworkModeSchema = z.enum(["deny-all", "allow-list", "allow-all"])
export const NetworkPolicySchema = z
  .object({
    mode: NetworkModeSchema,
    allowHosts: z.array(NonEmptyString).optional(),
    perRequestApproval: z.boolean().optional(),
  })
  .strict()

export const OsSandboxKindSchema = z.enum(["seatbelt", "landlock", "windows-sandbox", "none"])
export const SandboxPolicyStructSchema = z
  .object({
    osSandbox: OsSandboxKindSchema,
    readOnly: z.boolean(),
    workspaceWrite: z.boolean(),
    networkIsolated: z.boolean(),
  })
  .strict()

export const ControlManagedBySchema = z.enum(["user", "team", "admin"])
export const ControlPolicySchema = z
  .object({
    managedBy: ControlManagedBySchema.optional(),
    auditRequired: z.boolean(),
  })
  .strict()

/** The full struct-shaped {@link PermissionProfile} as it lives on the wire. */
export const PermissionProfileStructSchema = z
  .object({
    fileSystem: FileSystemSandboxPolicySchema,
    approval: ApprovalPolicyStructSchema,
    network: NetworkPolicySchema,
    sandbox: SandboxPolicyStructSchema,
    control: ControlPolicySchema,
  })
  .strict()

/** The on-the-wire field — ACCEPTS BOTH:
 *   - legacy enum (v1 sessions; back-compat for new code that chooses to
 *     stay on the enum vocabulary), and
 *   - the new struct (v2+ extended permission model).
 *  The decoder discriminates by JS type (`typeof === "string"`).
 *  The encoder NEVER coerces — whichever form was decoded round-trips
 *  byte-identical on re-encode. */
export const PermissionProfileFieldSchema = z.union([
  PermissionProfileSchema,
  PermissionProfileStructSchema,
])
export type PermissionProfileField = z.infer<typeof PermissionProfileFieldSchema>

export const TurnContextRecordSchema = z
  .object({
    type: z.literal("turn_context"),
    schema_version: SchemaVersionSchema,
    /** 1 */ turn_id: NonEmptyString,
    /** 2 */ cwd: NonEmptyString,
    /** 3 */ current_date: Iso8601,
    /** 4 */ timezone: Iana,
    /** 5 */ approval_policy: ApprovalPolicySchema,
    /** 6 */ sandbox_policy: SandboxPolicySchema,
    /** 7 — ADR-0135: now a union of (legacy enum) ∪ (struct). v1 sessions
     *  encode the enum form; v2+ may encode either. The decoder never
     *  coerces — the wire form decoded is the wire form re-encoded. */
    permission_profile: PermissionProfileFieldSchema,
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
    /** ADR-0135 — OPTIONAL second layer (file_system_sandbox_policy). When
     *  present, the gate AND-conditions it with `permission_profile.fileSystem`
     *  (see `src/permission/access-check.ts`). Absent on every v1 record and
     *  on v2 records whose composition root opts out of the second layer
     *  (callers fall back to the single-layer model). */
    file_system_sandbox_policy: FileSystemSandboxPolicySchema.optional(),
  })
  .strict()
export type TurnContextRecord = z.infer<typeof TurnContextRecordSchema>

/* ------------------------------------------------------------------ */
/* 3. event_msg                                                        */
/* ------------------------------------------------------------------ */

const EventBase = {
  type: z.literal("event_msg"),
  schema_version: SchemaVersionSchema,
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

/* ------------------------------------------------------------------ */
/* Debug/developer-mode (Track A, 2026-05-25): gate-decision event_msg */
/*                                                                     */
/* Wire form of the stream `DecisionEvent` variant. The closed `gate`  */
/* and `outcome` enums mirror `AgentEvent.kind` / `AgentEvent.outcome` */
/* in `src/stream/types.ts` (cross-slice mirror; adding a kind/outcome */
/* there MUST also add it here). `gate` is the schema field name (not  */
/* `kind` — `kind` is reserved by `event_msg` for the discriminator).  */
/* The schema stays `.strict()` so an unknown gate/outcome value is    */
/* rejected at decode time. `metadata` accepts arbitrary record (the   */
/* CALLER scrubs secrets — see DecisionEvent doc).                     */
/* ------------------------------------------------------------------ */

export const DecisionGateSchema = z.enum(["permission", "rule", "hook", "cap", "jail", "budget"])
export const DecisionOutcomeSchema = z.enum(["allow", "deny", "ask"])

export const EventDecisionSchema = z
  .object({
    ...EventBase,
    kind: z.literal("decision"),
    gate: DecisionGateSchema,
    outcome: DecisionOutcomeSchema,
    /** Short human-readable reason; non-empty by convention. */
    decision_reason: NonEmptyString,
    /** Pairs with `tool_call.id`. Absent when the decision predates dispatch. */
    tool_call_id: NonEmptyString.optional(),
    /** Only meaningful for gate="rule". */
    rule_id: NonEmptyString.optional(),
    /** Only meaningful for gate="hook". */
    hook_name: NonEmptyString.optional(),
    /** Kind-specific extra context. Caller-sanitised. */
    metadata: z.record(z.unknown()).optional(),
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
  EventDecisionSchema,
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
    schema_version: SchemaVersionSchema,
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
    schema_version: SchemaVersionSchema,
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
