import { describe, expect, test } from "bun:test"
import {
  DynamicToolRecordSchema,
  decodeSessionLine,
  encodeSessionLine,
  SESSION_ENVELOPE_VERSION,
  type SessionEnvelopeRecord,
  SessionEnvelopeRecordSchema,
  SessionMetaRecordSchema,
  TurnContextRecordSchema,
} from "@/session"

/**
 * §8.1 / §8.2 / §8.3 (jun-08 long-tail) — Codex turn_context + session_meta
 * field absorption + the dynamic_tools session record.
 *
 * Discipline:
 *   - default-OFF BYTE-IDENTITY: a record that sets NONE of the new optional
 *     fields encodes byte-for-byte the same as the pre-ticket wire form (the
 *     canonical encoder drops `undefined` props).
 *   - the new fields round-trip losslessly when present.
 *   - the new `dynamic_tools` record kind decodes through the top-level union.
 */

const isoNow = "2026-05-21T00:00:00.000Z"

const baseMeta = (over: Record<string, unknown> = {}) => ({
  type: "session_meta" as const,
  schema_version: SESSION_ENVELOPE_VERSION,
  session_id: "s-1",
  started_at: isoNow,
  cwd: "/tmp",
  cli_version: "0.1.0",
  model: "gpt-5",
  ...over,
})

const baseTurn = (over: Record<string, unknown> = {}) => ({
  type: "turn_context" as const,
  schema_version: SESSION_ENVELOPE_VERSION,
  turn_id: "t-1",
  cwd: "/tmp",
  current_date: isoNow,
  timezone: "America/Los_Angeles",
  approval_policy: "on-request" as const,
  sandbox_policy: "workspace-write" as const,
  permission_profile: "default" as const,
  model: "gpt-5",
  personality: "default",
  collaboration_mode: "solo" as const,
  realtime_active: false,
  effort: "medium" as const,
  summary: "",
  user_instructions: "",
  truncation_policy: "none" as const,
  parent_thread_id: null,
  thread_role: "root" as const,
  ...over,
})

describe("§8.1 turn_context — 6 absorbed Codex fields", () => {
  test("byte-identity: a turn_context with none of the 6 fields encodes the legacy wire form", () => {
    // The exact wire form a pre-ticket producer would emit (alphabetical keys,
    // no new fields). If adding the 6 optionals changed this, the snapshot
    // below would diverge — that is the byte-identity regression guard.
    const legacy = baseTurn() as SessionEnvelopeRecord
    const encoded = encodeSessionLine(legacy)
    // No new field name leaks into the wire form.
    for (const f of [
      "developer_instructions",
      "base_instructions",
      "dynamic_tools",
      "service_tier",
      "model_provider",
      "approvals_reviewer",
    ]) {
      expect(encoded.includes(`"${f}"`)).toBe(false)
    }
    // And it still decodes back to the identical record.
    const dec = decodeSessionLine(encoded)
    expect(dec.ok).toBe(true)
    if (dec.ok) expect(encodeSessionLine(dec.value)).toBe(encoded)
  })

  test("all 6 fields round-trip losslessly when present", () => {
    const full = baseTurn({
      developer_instructions: "be terse",
      base_instructions: "you are quanta",
      dynamic_tools: ["mcp__db__query", "skill__refactor"],
      service_tier: "priority",
      model_provider: "anthropic",
      approvals_reviewer: "user:944899",
    }) as SessionEnvelopeRecord
    const parsed = TurnContextRecordSchema.safeParse(full)
    expect(parsed.success).toBe(true)
    const enc = encodeSessionLine(full)
    const dec = decodeSessionLine(enc)
    expect(dec.ok).toBe(true)
    if (dec.ok) {
      const r = dec.value as Record<string, unknown>
      expect(r.developer_instructions).toBe("be terse")
      expect(r.base_instructions).toBe("you are quanta")
      expect(r.dynamic_tools).toEqual(["mcp__db__query", "skill__refactor"])
      expect(r.service_tier).toBe("priority")
      expect(r.model_provider).toBe("anthropic")
      expect(r.approvals_reviewer).toBe("user:944899")
    }
  })

  test("red-on-injection: a strict-mode unknown field is still rejected (no schema loosening)", () => {
    const bad = baseTurn({ totally_unknown_field: "x" })
    expect(TurnContextRecordSchema.safeParse(bad).success).toBe(false)
  })

  test("empty-string dynamic tool name is rejected (NonEmptyString discipline)", () => {
    const bad = baseTurn({ dynamic_tools: [""] })
    expect(TurnContextRecordSchema.safeParse(bad).success).toBe(false)
  })
})

describe("§8.2 session_meta — 5 absorbed Codex fields", () => {
  test("byte-identity: a session_meta with none of the 5 fields encodes the legacy wire form", () => {
    const legacy = baseMeta() as SessionEnvelopeRecord
    const encoded = encodeSessionLine(legacy)
    for (const f of [
      "agent_nickname",
      "dynamic_tools",
      "originator",
      "thread_source",
      "model_provider",
    ]) {
      expect(encoded.includes(`"${f}"`)).toBe(false)
    }
    const dec = decodeSessionLine(encoded)
    expect(dec.ok).toBe(true)
    if (dec.ok) expect(encodeSessionLine(dec.value)).toBe(encoded)
  })

  test("all 5 fields round-trip losslessly", () => {
    const full = baseMeta({
      agent_nickname: "Refactor Bot",
      dynamic_tools: ["mcp__fs__write"],
      originator: "cli",
      thread_source: "resumed",
      model_provider: "openai",
    }) as SessionEnvelopeRecord
    expect(SessionMetaRecordSchema.safeParse(full).success).toBe(true)
    const dec = decodeSessionLine(encodeSessionLine(full))
    expect(dec.ok).toBe(true)
    if (dec.ok) {
      const r = dec.value as Record<string, unknown>
      expect(r.agent_nickname).toBe("Refactor Bot")
      expect(r.dynamic_tools).toEqual(["mcp__fs__write"])
      expect(r.originator).toBe("cli")
      expect(r.thread_source).toBe("resumed")
      expect(r.model_provider).toBe("openai")
    }
  })
})

describe("§8.3 dynamic_tools session record", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    type: "dynamic_tools" as const,
    schema_version: SESSION_ENVELOPE_VERSION,
    turn_id: "t-1",
    action: "added" as const,
    tool_name: "mcp__db__query",
    at: isoNow,
    ...over,
  })

  test("a well-formed record decodes through the top-level union", () => {
    const r = rec({ source: "db-mcp" }) as SessionEnvelopeRecord
    expect(DynamicToolRecordSchema.safeParse(r).success).toBe(true)
    expect(SessionEnvelopeRecordSchema.safeParse(r).success).toBe(true)
    const dec = decodeSessionLine(encodeSessionLine(r))
    expect(dec.ok).toBe(true)
    if (dec.ok) {
      const got = dec.value as Record<string, unknown>
      expect(got.type).toBe("dynamic_tools")
      expect(got.action).toBe("added")
      expect(got.tool_name).toBe("mcp__db__query")
      expect(got.source).toBe("db-mcp")
    }
  })

  test("source is optional (absent ⇒ dropped from the wire form)", () => {
    const r = rec() as SessionEnvelopeRecord
    const enc = encodeSessionLine(r)
    expect(enc.includes('"source"')).toBe(false)
    expect(decodeSessionLine(enc).ok).toBe(true)
  })

  test("action must be one of added|removed (closed enum)", () => {
    expect(DynamicToolRecordSchema.safeParse(rec({ action: "mutated" })).success).toBe(false)
  })

  test("an unknown record type does NOT masquerade as dynamic_tools", () => {
    const bad = { ...rec(), type: "not_a_real_kind" }
    expect(SessionEnvelopeRecordSchema.safeParse(bad).success).toBe(false)
  })
})
