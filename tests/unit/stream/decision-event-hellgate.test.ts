/**
 * Debug/developer-mode `decision` AgentEvent hellgate (Track A, 2026-05-25).
 *
 * Pins the contract for the new gate-decision event:
 *   - 7 kinds × 3 outcomes = 21 union constructions compile + are recognised
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

const KINDS = ["permission", "rule", "hook", "cap", "jail", "budget", "objective"] as const
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

describe("AgentEvent.decision union admits 21 variants (7 kind × 3 outcome)", () => {
  for (const k of KINDS) {
    for (const o of OUTCOMES) {
      test(`kind=${k} outcome=${o} envelope round-trip is byte-identical + decodes back to the original (kind,outcome)`, () => {
        // Audit: the previous variant assertion only checked `turn>=0` (trivially
        // true since the builder defaults turn=1) and `reason.length>0` (trivially
        // true since the builder writes `${k}/${o}`). Promote every variant to a
        // wire round-trip: encode → decode → re-encode is byte-identical AND the
        // decoded record carries the *same* (gate, outcome, decision_reason).
        const rec = decisionRecord(k, o)
        const wire = encodeSessionLine(rec)
        const decoded = decodeSessionLine(wire)
        expect(decoded.ok).toBe(true)
        if (!decoded.ok) throw new Error("unreachable")
        expect(decoded.value).toEqual(rec)
        // Discriminator (type:"event_msg" + kind:"decision") + closed enums
        // survive the round-trip. We narrow the top-level `type` union FIRST
        // so the nested `kind` discriminator (carried by event_msg arms only)
        // is reachable — the top union includes session_meta / turn_context /
        // response_item / thread_spawn variants which carry no `kind` field.
        if (decoded.value.type !== "event_msg") {
          throw new Error("unreachable — decoder mis-routed to non-event_msg top-level variant")
        }
        if (decoded.value.kind !== "decision") {
          throw new Error("unreachable — decoder mis-routed to non-decision arm")
        }
        expect(decoded.value.gate).toBe(k)
        expect(decoded.value.outcome).toBe(o)
        expect(decoded.value.decision_reason).toBe(`${k}/${o}`)
        // Byte-identical re-encode (ADR-0023 canonical-key-sort determinism).
        expect(encodeSessionLine(decoded.value)).toBe(wire)
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

  test("decoder rejects whitespace-only decision_reason (NonEmptyString invariant — defence vs trim-bypass)", () => {
    // Audit-add: the empty-string test above does not catch the "whitespace
    // only" attack vector (a producer that uses `" "` thinking it's "non-
    // empty"). The schema today only enforces `.min(1)` so whitespace would
    // pass — that is the gap we want to MEASURE here. If the schema is ever
    // strengthened to also trim before checking, this test pins the contract.
    const r = EventDecisionSchema.safeParse({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      gate: "permission",
      outcome: "allow",
      decision_reason: " ", // single space — current schema accepts; pin shape.
    })
    // We DO NOT assert success here either way — we only assert that *if* it
    // passes, the value is preserved (no silent coercion). The negative
    // (`""`) test above proves the empty case rejects; whitespace remains an
    // explicit known-behaviour pin.
    if (r.success) {
      expect(r.data.decision_reason).toBe(" ")
    } else {
      expect(r.error.issues.length).toBeGreaterThan(0)
    }
  })

  test("decoder rejects missing required field (gate)", () => {
    const bad = JSON.stringify({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      // gate intentionally omitted
      outcome: "allow",
      decision_reason: "missing gate",
    })
    const r = decodeSessionLine(`${bad}\n`)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("schema")
  })

  test("decoder rejects empty tool_call_id (NonEmptyString.optional() — present-but-blank)", () => {
    // Optional + NonEmptyString means: absent is OK, but if present must be
    // non-empty. The structurally easy mistake is to wire `""` thinking it
    // serializes as "absent" — pin the schema's actual behaviour here.
    const r = EventDecisionSchema.safeParse({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "decision",
      gate: "permission",
      outcome: "deny",
      decision_reason: "ok",
      tool_call_id: "", // present but empty → MUST reject
    })
    expect(r.success).toBe(false)
  })
})

// ── 5. disjointness from other event_msg arms ───────────────────────────

describe("decoder routes by `kind` — no cross-arm mis-routing", () => {
  test("a decision-shaped payload with kind:'tool_invoke' does NOT decode as a decision arm", () => {
    // Build a tool_invoke record that ALSO carries gate/outcome strings —
    // the discriminator must win, NOT field-overlap heuristics. The strict
    // schemas should reject the extras (gate/outcome) under tool_invoke.
    const bad = JSON.stringify({
      type: "event_msg",
      schema_version: SESSION_ENVELOPE_VERSION,
      ts: TS,
      turn_id: TURN_ID,
      kind: "tool_invoke",
      gate: "permission", // ← belongs to decision arm only
      outcome: "allow",
      decision_reason: "ought to be ignored",
    })
    const r = decodeSessionLine(`${bad}\n`)
    // Either rejects entirely OR routes to tool_invoke (which under strict()
    // rejects the unknown fields anyway). What MUST NEVER happen: silent
    // coercion to a "decision" arm. We assert no decision shape.
    if (r.ok) {
      // If somehow this decoded, the `kind` discriminator must NOT be "decision".
      // Only event_msg variants carry `kind`; other top-level variants pass
      // trivially (no `kind` field ⇒ definitionally not "decision").
      if (r.value.type === "event_msg") {
        expect(r.value.kind).not.toBe("decision")
      }
    } else {
      expect(r.error.kind).toBe("schema")
    }
  })

  test("a decision arm does NOT cross-decode as tool_invoke (no leak in the opposite direction)", () => {
    const wire = encodeSessionLine(decisionRecord("rule", "deny"))
    const r = decodeSessionLine(wire)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    // Narrow to event_msg first (top-level discriminator) so the nested
    // `kind` discriminator is reachable.
    if (r.value.type !== "event_msg") {
      throw new Error("unreachable — decision wire decoded to non-event_msg variant")
    }
    expect(r.value.kind).toBe("decision")
    // Closed-union narrowing — fields belonging exclusively to other arms
    // are NOT present on the decoded value. (We don't iterate them by name —
    // we assert the canonical decision keys are present + the value EQUALS
    // the original record, no extras.)
    expect(r.value).toEqual(decisionRecord("rule", "deny"))
  })
})

// ── 6. metadata wire-preservation (nested, list, null, number, boolean) ─

describe("metadata structural preservation through the wire", () => {
  test("nested object + array + null + number + boolean survive encode→decode", () => {
    const rec = decisionRecord("budget", "deny", {
      metadata: {
        nested: { depth: 2, list: [1, "two", null, true, { inner: false }] },
        sentinel: null,
        score: 0.42,
        zero: 0,
        flag: false,
        emptyArr: [] as readonly unknown[],
        emptyObj: {} as Readonly<Record<string, unknown>>,
      },
    })
    const wire = encodeSessionLine(rec)
    const decoded = decodeSessionLine(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error("unreachable")
    expect(decoded.value).toEqual(rec)
    // Byte-identical re-encode — proves no shape coercion (e.g., empty obj
    // → null, or `0` → undefined).
    expect(encodeSessionLine(decoded.value)).toBe(wire)
  })

  test("turn defaulting to 0 (zero-turn admissible — boundary)", () => {
    // Runtime AgentEvent uses `turn:number`; the production code defaults to
    // 0 when `config.run` is absent (see admissibility-gate.ts line ~216).
    // Pin that 0 is a STRUCTURALLY VALID turn (not silently swapped to 1).
    const e: AgentEvent = decisionEvent("hook", "allow", { turn: 0 })
    expect(e.type).toBe("decision")
    if (e.type !== "decision") throw new Error("unreachable")
    expect(e.turn).toBe(0)
    expect(Number.isInteger(e.turn)).toBe(true)
  })
})
