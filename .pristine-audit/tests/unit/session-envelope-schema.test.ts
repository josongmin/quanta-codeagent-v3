import { describe, expect, test } from "bun:test"
import {
  SESSION_ENVELOPE_VERSION,
  SessionEnvelopeRecordSchema,
  SessionMetaRecordSchema,
  TurnContextRecordSchema,
} from "@/session"

const isoNow = "2026-05-21T00:00:00.000Z"

const validSessionMeta = (over: Record<string, unknown> = {}) => ({
  type: "session_meta",
  schema_version: SESSION_ENVELOPE_VERSION,
  session_id: "s-1",
  started_at: isoNow,
  cwd: "/tmp",
  cli_version: "0.1.0",
  model: "gpt-5",
  ...over,
})

const validTurnContext = (over: Record<string, unknown> = {}) => ({
  type: "turn_context",
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: "t-1",
  cwd: "/tmp",
  current_date: isoNow,
  timezone: "America/Los_Angeles",
  approval_policy: "on-request",
  sandbox_policy: "workspace-write",
  permission_profile: "default",
  model: "gpt-5",
  personality: "default",
  collaboration_mode: "solo",
  realtime_active: false,
  effort: "medium",
  summary: "",
  user_instructions: "",
  truncation_policy: "none",
  parent_thread_id: null,
  thread_role: "root",
  ...over,
})

/** Build an event record. The default kind is `task_started` (which requires
 *  `task`). When a test overrides `kind`, the `task` field is dropped so the
 *  caller can supply the fields the new kind needs without a stale strict-mode
 *  rejection from a leftover `task` key. */
const validEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    type: "event_msg",
    schema_version: SESSION_ENVELOPE_VERSION,
    ts: isoNow,
    turn_id: "t-1",
    kind: "task_started",
    task: "hello",
  }
  const merged = { ...base, ...over }
  if (over.kind !== undefined && over.kind !== "task_started") {
    delete merged.task
  }
  return merged
}

const validResponseItem = (over: Record<string, unknown> = {}) => ({
  type: "response_item",
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: "t-1",
  item_kind: "assistant_text",
  index: 0,
  content: "ok",
  ...over,
})

const validThreadSpawn = (over: Record<string, unknown> = {}) => ({
  type: "thread_spawn",
  schema_version: SESSION_ENVELOPE_VERSION,
  parent_session_id: "s-1",
  parent_turn_id: "t-1",
  child_session_id: "s-2",
  child_task_kind: "explore",
  spawned_at: isoNow,
  ...over,
})

describe("session_meta", () => {
  test("accepts the canonical shape", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validSessionMeta()).success).toBe(true)
  })
  test("rejects unknown extra key (strict)", () => {
    expect(SessionEnvelopeRecordSchema.safeParse({ ...validSessionMeta(), extra: 1 }).success).toBe(
      false,
    )
  })
  test("rejects wrong schema_version", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse({ ...validSessionMeta(), schema_version: 999 }).success,
    ).toBe(false)
  })
  test("rejects empty session_id", () => {
    expect(
      SessionMetaRecordSchema.safeParse({ ...validSessionMeta(), session_id: "" }).success,
    ).toBe(false)
  })
  test("rejects bad ISO timestamp", () => {
    expect(
      SessionMetaRecordSchema.safeParse({ ...validSessionMeta(), started_at: "not-a-date" })
        .success,
    ).toBe(false)
  })
  test("rejects wrong type discriminant", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse({ ...validSessionMeta(), type: "nope" }).success,
    ).toBe(false)
  })
})

describe("turn_context (17 + 2 fields)", () => {
  test("accepts the canonical shape", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validTurnContext()).success).toBe(true)
  })
  test("accepts subagent role with parent_thread_id", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validTurnContext({ thread_role: "subagent", parent_thread_id: "t-parent" }),
      ).success,
    ).toBe(true)
  })
  test("rejects missing parent_thread_id key", () => {
    const { parent_thread_id: _omit, ...rest } = validTurnContext()
    expect(TurnContextRecordSchema.safeParse(rest).success).toBe(false)
  })
  test("rejects unknown approval_policy", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ approval_policy: "yolo" })).success,
    ).toBe(false)
  })
  test("rejects unknown sandbox_policy", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ sandbox_policy: "open" })).success,
    ).toBe(false)
  })
  test("rejects unknown thread_role", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ thread_role: "manager" })).success,
    ).toBe(false)
  })
  test("rejects extra key", () => {
    expect(TurnContextRecordSchema.safeParse(validTurnContext({ stray: 1 })).success).toBe(false)
  })
  test("rejects non-boolean realtime_active", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ realtime_active: "yes" })).success,
    ).toBe(false)
  })
  test("rejects bad timezone format", () => {
    expect(TurnContextRecordSchema.safeParse(validTurnContext({ timezone: "10" })).success).toBe(
      false,
    )
  })
  test("rejects non-iso current_date", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ current_date: "2026-05-21" })).success,
    ).toBe(false)
  })
  test("rejects bad effort value", () => {
    expect(TurnContextRecordSchema.safeParse(validTurnContext({ effort: "ultra" })).success).toBe(
      false,
    )
  })
  test("rejects bad truncation_policy value", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ truncation_policy: "weird" })).success,
    ).toBe(false)
  })
  test("rejects bad collaboration_mode value", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ collaboration_mode: "bossy" })).success,
    ).toBe(false)
  })
  test("rejects bad permission_profile value", () => {
    expect(
      TurnContextRecordSchema.safeParse(validTurnContext({ permission_profile: "guest" })).success,
    ).toBe(false)
  })
})

describe("event_msg sub-types", () => {
  test("accepts task_started", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validEvent()).success).toBe(true)
  })
  test("accepts user_message", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validEvent({ kind: "user_message", content: "hi" }))
        .success,
    ).toBe(true)
  })
  test("accepts token_count", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validEvent({ kind: "token_count", input_tokens: 1, output_tokens: 2 }),
      ).success,
    ).toBe(true)
  })
  test("accepts turn_aborted", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validEvent({ kind: "turn_aborted", reason: "user" }))
        .success,
    ).toBe(true)
  })
  test("accepts tool_invoke", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validEvent({ kind: "tool_invoke", tool: "read", input: { path: "x" } }),
      ).success,
    ).toBe(true)
  })
  test("accepts tool_result", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validEvent({ kind: "tool_result", tool: "read", ok: true, output: "x" }),
      ).success,
    ).toBe(true)
  })
  test("accepts custom event with non-empty custom_kind", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validEvent({ kind: "custom", custom_kind: "v3.hint", data: { foo: 1 } }),
      ).success,
    ).toBe(true)
  })
  test("rejects custom event with empty custom_kind", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validEvent({ kind: "custom", custom_kind: "", data: {} }),
      ).success,
    ).toBe(false)
  })
  test("rejects unknown kind", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validEvent({ kind: "weird" })).success).toBe(false)
  })
  test("rejects task_started without `task`", () => {
    const { task: _omit, ...rest } = validEvent()
    expect(SessionEnvelopeRecordSchema.safeParse(rest).success).toBe(false)
  })
  test("rejects negative token counts", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(
        validEvent({ kind: "token_count", input_tokens: -1, output_tokens: 0 }),
      ).success,
    ).toBe(false)
  })
  test("rejects extra key on event", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validEvent({ stray: 1 })).success).toBe(false)
  })
})

describe("response_item", () => {
  test("accepts canonical text", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validResponseItem()).success).toBe(true)
  })
  test("accepts tool_use", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validResponseItem({ item_kind: "assistant_tool_use" }))
        .success,
    ).toBe(true)
  })
  test("accepts reasoning", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validResponseItem({ item_kind: "assistant_reasoning" }))
        .success,
    ).toBe(true)
  })
  test("rejects bad item_kind", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validResponseItem({ item_kind: "system" })).success,
    ).toBe(false)
  })
  test("rejects negative index", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validResponseItem({ index: -1 })).success).toBe(
      false,
    )
  })
  test("rejects float index", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validResponseItem({ index: 1.5 })).success).toBe(
      false,
    )
  })
})

describe("thread_spawn", () => {
  test("accepts canonical shape", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validThreadSpawn()).success).toBe(true)
  })
  test("rejects empty child_task_kind", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validThreadSpawn({ child_task_kind: "" })).success,
    ).toBe(false)
  })
  test("rejects extra key", () => {
    expect(SessionEnvelopeRecordSchema.safeParse(validThreadSpawn({ extra: 1 })).success).toBe(
      false,
    )
  })
  test("rejects bad spawned_at", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse(validThreadSpawn({ spawned_at: "yesterday" })).success,
    ).toBe(false)
  })
})

describe("top-level union", () => {
  test("rejects record without type", () => {
    expect(SessionEnvelopeRecordSchema.safeParse({ session_id: "x" }).success).toBe(false)
  })
  test("rejects record with unknown type", () => {
    expect(
      SessionEnvelopeRecordSchema.safeParse({ type: "made_up", schema_version: 1 }).success,
    ).toBe(false)
  })
})
