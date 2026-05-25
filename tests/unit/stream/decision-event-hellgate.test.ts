/**
 * Debug/developer-mode `decision` AgentEvent hellgate (Track A, 2026-05-25).
 *
 * Pins the contract for the new gate-decision event:
 *   - 6 kinds × 3 outcomes = 18 union constructions compile + are recognised
 *     at runtime.
 *   - turn ≥ 0 + reason non-empty invariants hold for the canonical fixture
 *     and the optional fields stay optional (absence is legal).
 *   - metadata preserves nested object / null / number shapes byte-identically
 *     through encode→decode (no coercion).
 *   - Envelope round-trip is byte-identical across 4 representative variants.
 *   - Unknown gate/outcome strings on the wire fail zod validation (gracefully —
 *     the decoder returns an `err(...)` instead of throwing).
 *
 * Slice fence: this test lives in `tests/unit/stream/` and ONLY imports the
 * stream + session slices. No agent/loop/permission/cli touch.
 */

import { describe, expect, test } from "bun:test"
import {
  decodeSessionLine,
  EventDecisionSchema,
  type EventMsgRecord,
  encodeSessionLine,
  SESSION_ENVELOPE_VERSION,
} from "@/session"
import type { AgentEvent } from "@/stream"

// ── canonical fixture builders ──────────────────────────────────────────

const TURN_ID = "turn-42"
const TS = "2026-05-25T12:00:00.000Z"

const KINDS = ["permission", "rule", "hook", "cap", "jail", "budget"] as const
const OUTCOMES = ["allow", "deny", "ask"] as const

type GateKind = (typeof KINDS)[number]
type Outcome = (typeof OUTCOMES)[number]

const decisionEvent = (
  kind: GateKind,
  outcome: Outcome,
  overrides: Partial<Extract<AgentEvent, { type: "decision" }>> = {},
): Extract<AgentEvent, { type: "decision" }> => ({
  type: "decision",
  turn: 1,
  kind,
  outcome,
  reason: `${kind}/${outcome}`,
  ...overrides,
})

const decisionRecord = (
  gate: GateKind,
  outcome: Outcome,
  extra: Partial<Extract<EventMsgRecord, { kind: "decision" }>> = {},
): Extract<EventMsgRecord, { kind: "decision" }> => ({
  type: "event_msg",
  schema_version: SESSION_ENVELOPE_VERSION,
  ts: TS,
  turn_id: TURN_ID,
  kind: "decision",
  gate,
  outcome,
  decision_reason: `${gate}/${outcome}`,
  ...extra,
})

// ── 1. union admits all 18 (kind × outcome) variants ────────────────────

describe("AgentEvent.decision union admits 18 variants (6 kind × 3 outcome)", () => {
  for (const k of KINDS) {
    for (const o of OUTCOMES) {
      test(`compiles + recognises kind=${k} outcome=${o}`, () => {
        const e: AgentEvent = decisionEvent(k, o)
        expect(e.type).toBe("decision")
        if (e.type !== "decision") throw new Error("unreachable")
        expect(e.kind).toBe(k)
        expect(e.outcome).toBe(o)
        expect(e.turn).toBeGreaterThanOrEqual(0)
        expect(e.reason.length).toBeGreaterThan(0)
      })
    }
  }
})

// ── 2. invariants on canonical fixture ──────────────────────────────────

describe("DecisionEvent invariants", () => {
  test("turn is a non-negative integer (0 is admissible)", () => {
    const e: AgentEvent = decisionEvent("permission", "allow", { turn: 0 })
    expect(e.type).toBe("decision")
    if (e.type !== "decision") throw new Error("unreachable")
    expect(e.turn).toBe(0)
  })

  test("required-only construction (no optional fields) compiles + runs", () => {
    const e: AgentEvent = {
      type: "decision",
      turn: 7,
      kind: "rule",
      outcome: "deny",
      reason: "matched HARD_DENY_destructive",
    }
    expect(e.type).toBe("decision")
    if (e.type !== "decision") throw new Error("unreachable")
    expect(e.toolCallId).toBeUndefined()
    expect(e.ruleId).toBeUndefined()
    expect(e.hookName).toBeUndefined()
    expect(e.metadata).toBeUndefined()
  })

  test("every optional field can be set independently", () => {
    const e: AgentEvent = {
      type: "decision",
      turn: 2,
      kind: "hook",
      outcome: "ask",
      reason: "user-pretool-hook returned ask",
      toolCallId: "call_123",
      ruleId: "rule.deny.rm-rf",
      hookName: "pre-bash",
      metadata: { exitCode: 0 },
    }
    expect(e.type).toBe("decision")
    if (e.type !== "decision") throw new Error("unreachable")
    expect(e.toolCallId).toBe("call_123")
    expect(e.ruleId).toBe("rule.deny.rm-rf")
    expect(e.hookName).toBe("pre-bash")
    expect(e.metadata).toEqual({ exitCode: 0 })
  })

  test("metadata preserves nested object / null / number shapes", () => {
    const meta: Readonly<Record<string, unknown>> = {
      nested: { depth: 2, list: [1, 2, 3] },
      sentinel: null,
      score: 0.42,
      flag: false,
    }
    const e: AgentEvent = decisionEvent("budget", "deny", { metadata: meta })
    if (e.type !== "decision") throw new Error("unreachable")
    expect(e.metadata).toEqual(meta)
    // Reference is preserved (readonly is structural — same reference round-trips).
    expect(e.metadata).toBe(meta)
  })
})

// ── 3. envelope round-trip (encode → decode → byte-identical re-encode) ─

describe("envelope round-trip for decision event_msg", () => {
  const variants: Array<{ name: string; rec: Extract<EventMsgRecord, { kind: "decision" }> }> = [
    {
      name: "minimum required fields",
      rec: decisionRecord("permission", "allow"),
    },
    {
      name: "all optionals (toolCallId+ruleId+hookName+metadata)",
      rec: decisionRecord("rule", "deny", {
        tool_call_id: "call_abc",
        rule_id: "rule.shell.deny-rm-rf",
        hook_name: "pre_tool_use",
        metadata: { policy: "HARD_DENY", path: "/" },
      }),
    },
    {
      name: "ask outcome from hook gate (nested metadata)",
      rec: decisionRecord("hook", "ask", {
        hook_name: "approval-prompt",
        metadata: { reason: "destructive", suggested: ["abort", "proceed"] },
      }),
    },
    {
      name: "budget cap with numeric metadata",
      rec: decisionRecord("cap", "deny", {
        metadata: { tokensUsed: 12345, ceiling: 10000 },
      }),
    },
  ]

  for (const { name, rec } of variants) {
    test(name, () => {
      const wire = encodeSessionLine(rec)
      const decoded = decodeSessionLine(wire)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) throw new Error("unreachable")
      expect(decoded.value).toEqual(rec)
      // Byte-identical re-encode (canonical-key-sort determinism, ADR-0023).
      const reWire = encodeSessionLine(decoded.value)
      expect(reWire).toBe(wire)
    })
  }
})

// ── 4. unknown gate/outcome — zod rejects (graceful err, not throw) ─────

describe("zod rejects unknown gate / outcome values", () => {
  test("decoder returns err(...) for unknown gate", () => {
    const bad = JSON.stringify({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      gate: "telepathy", // ← not in DecisionGateSchema
      outcome: "allow",
      decision_reason: "anything",
    })
    const r = decodeSessionLine(`${bad}\n`)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema")
  })

  test("decoder returns err(...) for unknown outcome", () => {
    const bad = JSON.stringify({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      gate: "permission",
      outcome: "perhaps", // ← not in DecisionOutcomeSchema
      decision_reason: "anything",
    })
    const r = decodeSessionLine(`${bad}\n`)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema")
  })

  test("decoder returns err(...) for empty decision_reason (non-empty invariant)", () => {
    const bad = JSON.stringify({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      gate: "permission",
      outcome: "allow",
      decision_reason: "", // ← NonEmptyString invariant
    })
    const r = decodeSessionLine(`${bad}\n`)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema")
  })

  test("EventDecisionSchema.safeParse alone rejects extra strict fields", () => {
    const r = EventDecisionSchema.safeParse({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      gate: "permission",
      outcome: "allow",
      decision_reason: "ok",
      unknown_extra: "x", // ← strict() must reject
    })
    expect(r.success).toBe(false)
  })
})
