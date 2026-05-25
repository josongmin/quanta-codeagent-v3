/**
 * Stop-reason hellgate (ADR-0242).
 *
 * Seals 15 invariants on the {@link StopReasonPolicy} port + the default
 * Cursor 3.2.16 8-arm routing table + the `runTurn` wire seam in `loop.ts`:
 *
 *   HELL-SR-01  end_turn              → continue (legacy fallthrough)
 *   HELL-SR-02  tool_use              → continue (legacy fallthrough)
 *   HELL-SR-03  max_tokens            → surface
 *   HELL-SR-04  refusal               → surface
 *   HELL-SR-05  pause_turn            → surface
 *   HELL-SR-06  content_filtered      → abort
 *   HELL-SR-07  guardrail_intervened  → hitl
 *   HELL-SR-08  error                 → surface
 *   HELL-SR-09  unknown reason         → fallthrough (`continue`)
 *   HELL-SR-10  config.stopReasonPolicy ABSENT ⇒ byte-identical legacy path
 *               (decideFromStopPolicy returns null without invoking anything)
 *   HELL-SR-11  surface action ⇒ RecoveryAction { do: "error", reason }
 *   HELL-SR-12  abort action   ⇒ RecoveryAction tagged "[stop-abort]"
 *   HELL-SR-13  hitl action    ⇒ RecoveryAction tagged "[stop-hitl]"
 *   HELL-SR-14  continue action ⇒ null (fall through to decideOnAssembled)
 *   HELL-SR-15  refusal under policy ⇒ recorder sees the wire-routed reason
 *               (policy takes precedence over legacy refusal detection)
 *
 *   + invariants:
 *      - policy.handle is pure (deterministic across N invocations).
 *      - all 8 closed-vocabulary reasons route to a non-null action.
 *      - no-op policy returns `{kind:"continue"}` for EVERY input
 *        (including the closed vocabulary).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { decideFromStopPolicy } from "@/agent/recovery"
import {
  ALL_STOP_REASON_KINDS,
  DEFAULT_STOP_REASON_ROUTING,
  defaultStopReasonPolicy,
  noOpStopReasonPolicy,
  type StopAction,
  type StopReasonKind,
  type StopReasonPolicy,
} from "@/agent/stop-reason"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── Tiny harness mirrored from tests/unit/recovery-hellgate.test.ts ─────────

type Step = { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new Error("script exhausted")
    for (const ev of step.events) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const textWithStop = (t: string, stop: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]
const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-SR-01..08 — every closed-vocabulary reason routes per Cursor table.
// ─────────────────────────────────────────────────────────────────────────────

describe("HELL-SR-01..08 — Cursor 8-arm routing table verbatim", () => {
  const policy = defaultStopReasonPolicy()

  const cases: ReadonlyArray<{
    id: string
    reason: StopReasonKind
    expectedKind: StopAction["kind"]
  }> = [
    { id: "01", reason: "end_turn", expectedKind: "continue" },
    { id: "02", reason: "tool_use", expectedKind: "continue" },
    { id: "03", reason: "max_tokens", expectedKind: "surface" },
    { id: "04", reason: "refusal", expectedKind: "surface" },
    { id: "05", reason: "pause_turn", expectedKind: "surface" },
    { id: "06", reason: "content_filtered", expectedKind: "abort" },
    { id: "07", reason: "guardrail_intervened", expectedKind: "hitl" },
    { id: "08", reason: "error", expectedKind: "surface" },
  ]

  for (const c of cases) {
    test(`HELL-SR-${c.id} — ${c.reason} → ${c.expectedKind}`, () => {
      const action = policy.handle(c.reason)
      expect(action.kind).toBe(c.expectedKind)
      // The routing map must agree with the policy (single source of truth).
      expect(DEFAULT_STOP_REASON_ROUTING[c.reason].kind).toBe(c.expectedKind)
    })
  }

  test("exhaustiveness — all 8 closed kinds are in the canonical tuple", () => {
    expect(ALL_STOP_REASON_KINDS.length).toBe(8)
    // No duplicates.
    expect(new Set(ALL_STOP_REASON_KINDS).size).toBe(8)
    // Every kind in the map maps to a non-null action.
    for (const k of ALL_STOP_REASON_KINDS) {
      expect(DEFAULT_STOP_REASON_ROUTING[k]).toBeDefined()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-SR-09 — unknown vocabulary falls through to `continue`.
// ─────────────────────────────────────────────────────────────────────────────

describe("HELL-SR-09 — unknown reasons collapse to continue (legacy wins)", () => {
  const policy = defaultStopReasonPolicy()

  const unknowns = [
    "",
    "unknown",
    "MAX_TOKENS", // case-sensitive — closed vocabulary is lowercase
    "stop_sequence", // legacy OpenAI string not in Cursor table
    "tool_calls", // legacy OpenAI string not in Cursor table
    "function_call",
    " end_turn", // leading space → not the literal
    "end_turn ", // trailing space
    "🛑",
  ]

  for (const u of unknowns) {
    test(`unknown ${JSON.stringify(u)} → continue`, () => {
      const action = policy.handle(u)
      expect(action.kind).toBe("continue")
    })
  }

  test("decideFromStopPolicy returns null on unknown (fall through)", () => {
    const result = decideFromStopPolicy(policy, "totally-not-a-real-stop-reason")
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-SR-10 — undefined policy ⇒ helper returns null (zero allocation).
// ─────────────────────────────────────────────────────────────────────────────

describe("HELL-SR-10 — config.stopReasonPolicy ABSENT ⇒ byte-identical legacy", () => {
  test("decideFromStopPolicy(undefined, ...) === null for EVERY closed reason", () => {
    for (const k of ALL_STOP_REASON_KINDS) {
      expect(decideFromStopPolicy(undefined, k)).toBeNull()
    }
  })

  test("decideFromStopPolicy(undefined, 'whatever') === null for any string", () => {
    expect(decideFromStopPolicy(undefined, "")).toBeNull()
    expect(decideFromStopPolicy(undefined, "anything")).toBeNull()
  })

  test("integrated runAgent — policy absent ⇒ end_turn still completes legacy path", async () => {
    const llm = new ScriptedLLM([ev(textWithStop("done", "end_turn"))])
    const stream = new RecordingStream()
    const out = await runAgent(cfg({ llm, stream }))
    // Legacy: end_turn + non-empty text → proceed (no tools) → completed.
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-SR-11..14 — each StopAction kind maps to the expected RecoveryAction.
// ─────────────────────────────────────────────────────────────────────────────

describe("HELL-SR-11..14 — StopAction → RecoveryAction translation", () => {
  // Build narrow synthetic policies that emit exactly one action kind.
  const fixed = (action: StopAction): StopReasonPolicy => ({
    handle: () => action,
  })

  test("HELL-SR-11 — surface ⇒ { do: 'error', reason } (untagged, legacy-shaped)", () => {
    const policy = fixed({ kind: "surface", reason: "bang" })
    const r = decideFromStopPolicy(policy, "end_turn")
    expect(r).toEqual({ do: "error", reason: "bang" })
  })

  test("HELL-SR-12 — abort ⇒ { do: 'error', reason: '[stop-abort] ...' }", () => {
    const policy = fixed({ kind: "abort", reason: "filtered" })
    const r = decideFromStopPolicy(policy, "content_filtered")
    expect(r).toEqual({ do: "error", reason: "[stop-abort] filtered" })
  })

  test("HELL-SR-13 — hitl ⇒ { do: 'error', reason: '[stop-hitl] ...' }", () => {
    const policy = fixed({ kind: "hitl", reason: "guardrail" })
    const r = decideFromStopPolicy(policy, "guardrail_intervened")
    expect(r).toEqual({ do: "error", reason: "[stop-hitl] guardrail" })
  })

  test("HELL-SR-14 — continue ⇒ null (fall through)", () => {
    const policy = fixed({ kind: "continue" })
    const r = decideFromStopPolicy(policy, "end_turn")
    expect(r).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-SR-15 — refusal under policy ⇒ terminal surface routes through the
// loop's existing error path (the legacy refusal-FSM is bypassed).
// ─────────────────────────────────────────────────────────────────────────────

describe("HELL-SR-15 — refusal under policy goes through error path", () => {
  test("integrated runAgent — refusal stop_reason + policy ⇒ error outcome (not refusal)", async () => {
    const llm = new ScriptedLLM([ev(textWithStop("I decline.", "refusal"))])
    const stream = new RecordingStream()
    const out = await runAgent(
      cfg({
        llm,
        stream,
        stopReasonPolicy: defaultStopReasonPolicy(),
      }),
    )
    // The policy classifies refusal as "surface" → translated to a terminal
    // `{do:"error", reason}` RecoveryAction. The loop surfaces this as an
    // error outcome carrying the policy's reason text.
    expect(out.reason).toBe("error")
    // The reason text is emitted on the stream as an `error` event whose
    // message carries the Cursor-style provider attribution.
    const errorEvents = stream.events.filter(
      (e): e is AgentEvent & { message: string } => e.type === "error",
    )
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    const reasons = errorEvents.map((e) => e.message).join(" | ")
    expect(reasons).toContain("refusal")
    // No retries thrashed — exactly one LLM call.
    expect(llm.calls).toBe(1)
    // The stream emitted a `done {reason:"error"}` event (no `refusal` event).
    const doneEvents = stream.events.filter((e) => e.type === "done")
    expect(doneEvents.length).toBeGreaterThan(0)
  })

  test("policy ABSENT — refusal stop_reason ⇒ legacy refusal outcome (regression fence)", async () => {
    const llm = new ScriptedLLM([ev(textWithStop("I decline.", "refusal"))])
    const stream = new RecordingStream()
    const out = await runAgent(cfg({ llm, stream }))
    // Without the policy wired, the legacy `decideOnAssembled` refusal arm
    // fires — outcome is the typed `refusal`, NOT a generic `error`.
    expect(out.reason).toBe("refusal")
    expect(llm.calls).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Purity + no-op invariants.
// ─────────────────────────────────────────────────────────────────────────────

describe("HELL-SR — purity + no-op invariants", () => {
  test("default policy is pure — 100 invocations on same input return identical action", () => {
    const policy = defaultStopReasonPolicy()
    for (const k of ALL_STOP_REASON_KINDS) {
      const first = policy.handle(k)
      for (let i = 0; i < 100; i++) {
        const next = policy.handle(k)
        expect(next).toEqual(first)
        // Frozen literal reuse: same reference across calls (zero alloc).
        expect(next).toBe(first)
      }
    }
  })

  test("no-op policy returns continue for EVERY closed-vocabulary input", () => {
    for (const k of ALL_STOP_REASON_KINDS) {
      const a = noOpStopReasonPolicy.handle(k)
      expect(a.kind).toBe("continue")
    }
  })

  test("no-op policy returns continue for unknowns too (total function)", () => {
    expect(noOpStopReasonPolicy.handle("").kind).toBe("continue")
    expect(noOpStopReasonPolicy.handle("xyz").kind).toBe("continue")
  })

  test("decideFromStopPolicy never throws on any closed reason", () => {
    const policy = defaultStopReasonPolicy()
    for (const k of ALL_STOP_REASON_KINDS) {
      expect(() => decideFromStopPolicy(policy, k)).not.toThrow()
    }
  })

  test("frozen routing map is immutable — assignment throws in strict mode", () => {
    const map = DEFAULT_STOP_REASON_ROUTING as unknown as Record<string, unknown>
    expect(Object.isFrozen(DEFAULT_STOP_REASON_ROUTING)).toBe(true)
    // Frozen reaction: silent in sloppy, throws in strict (we're strict).
    expect(() => {
      map.end_turn = { kind: "abort", reason: "evil" }
    }).toThrow()
  })
})
