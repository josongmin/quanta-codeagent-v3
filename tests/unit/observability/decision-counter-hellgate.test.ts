/**
 * ADR-0269 — hellgate for the decision → MetricsRegistry counter sink.
 *
 * Seals 16 adversarial invariants:
 *
 *   HELL-DC-01..09: the 3×3 (kind × outcome) sample of the
 *                   (permission|rule|hook) × (allow|deny|ask) matrix each
 *                   produces exactly one increment with labels {kind,outcome}
 *                   and the canonical counter name
 *                   `quanta.gate.<kind>.<outcome>.total`.
 *   HELL-DC-10: same (kind, outcome) emitted twice ⇒ counter = +2.
 *   HELL-DC-11: every non-`decision` AgentEvent is ignored — counter
 *               registrations unchanged after a flood of unrelated events.
 *   HELL-DC-12: a registry whose `.increment` throws never poisons the sink
 *               (the emit returns without throwing — no-throw policy).
 *   HELL-DC-13: custom `prefix` honored (`test.permission.allow.total`).
 *   HELL-DC-14: cardinality invariant — `toolCallId`, `ruleId`, `hookName`,
 *               `reason`, `metadata` are NEVER passed as counter labels. The
 *               recorded label set is exactly `{kind, outcome}` — no extras.
 *   HELL-DC-15: `cap` / `jail` / `budget` kinds (the other half of the closed
 *               taxonomy) also produce well-formed counter names — every
 *               kind in the closed union is supported, none routed to a
 *               fallback bucket.
 *   HELL-DC-16: an empty / whitespace-only prefix falls back to the default
 *               `quanta.gate` (defensive — a poisoned env value cannot
 *               degrade the counter namespace to an empty one).
 */

import { describe, expect, test } from "bun:test"
import {
  createDecisionCounterSink,
  defaultMetricsRegistry,
  type MetricsRegistry,
} from "@/observability/metrics/index"
import type { AgentEvent } from "@/stream"

// ────────────────────────────────────────────────────────────────────────────
// Test helpers — build a `decision` event without unsafe casts so the closed
// `AgentEvent` union compiles cleanly. We accept only kinds/outcomes that
// belong to the published taxonomy.
// ────────────────────────────────────────────────────────────────────────────

type DecisionKind = "permission" | "rule" | "hook" | "cap" | "jail" | "budget"
type DecisionOutcome = "allow" | "deny" | "ask"

const decisionEvent = (
  kind: DecisionKind,
  outcome: DecisionOutcome,
  extras?: {
    toolCallId?: string
    ruleId?: string
    hookName?: string
    metadata?: Readonly<Record<string, unknown>>
  },
): AgentEvent => ({
  type: "decision",
  turn: 1,
  kind,
  outcome,
  reason: "test",
  ...(extras?.toolCallId !== undefined ? { toolCallId: extras.toolCallId } : {}),
  ...(extras?.ruleId !== undefined ? { ruleId: extras.ruleId } : {}),
  ...(extras?.hookName !== undefined ? { hookName: extras.hookName } : {}),
  ...(extras?.metadata !== undefined ? { metadata: extras.metadata } : {}),
})

interface IncrementCall {
  readonly name: string
  readonly delta: number | undefined
  readonly labels: Readonly<Record<string, string>> | undefined
}

const spyRegistry = (): {
  registry: MetricsRegistry
  calls: IncrementCall[]
} => {
  const calls: IncrementCall[] = []
  const registry: MetricsRegistry = {
    increment(name, delta, labels) {
      calls.push({
        name,
        delta,
        labels: labels === undefined ? undefined : { ...labels },
      })
    },
    observe() {
      throw new Error("observe should not be called by the decision-counter sink")
    },
    gauge() {
      throw new Error("gauge should not be called by the decision-counter sink")
    },
    snapshot() {
      return []
    },
    reset() {
      calls.length = 0
    },
    async flush() {
      return
    },
  }
  return { registry, calls }
}

// ────────────────────────────────────────────────────────────────────────────
// HELL-DC-01..09 — 3×3 matrix sample.
// ────────────────────────────────────────────────────────────────────────────

const MATRIX_3X3: ReadonlyArray<readonly [DecisionKind, DecisionOutcome]> = [
  ["permission", "allow"],
  ["permission", "deny"],
  ["permission", "ask"],
  ["rule", "allow"],
  ["rule", "deny"],
  ["rule", "ask"],
  ["hook", "allow"],
  ["hook", "deny"],
  ["hook", "ask"],
]

describe("decision-counter-sink (ADR-0269)", () => {
  for (const [kind, outcome] of MATRIX_3X3) {
    test(`HELL-DC: ${kind}/${outcome} → quanta.gate.${kind}.${outcome}.total +1`, () => {
      const { registry, calls } = spyRegistry()
      const sink = createDecisionCounterSink({ metrics: registry })
      sink.emit(decisionEvent(kind, outcome))
      expect(calls).toHaveLength(1)
      const call = calls[0]
      if (call === undefined) throw new Error("expected one call")
      expect(call.name).toBe(`quanta.gate.${kind}.${outcome}.total`)
      expect(call.delta).toBe(1)
      expect(call.labels).toEqual({ kind, outcome })
    })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-10 — repeated emit accumulates correctly.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-10: same (kind,outcome) emitted twice accumulates to +2", () => {
    const registry = defaultMetricsRegistry()
    const sink = createDecisionCounterSink({ metrics: registry })
    sink.emit(decisionEvent("permission", "allow"))
    sink.emit(decisionEvent("permission", "allow"))
    const snapshot = registry.snapshot()
    expect(snapshot).toHaveLength(1)
    const row = snapshot[0]
    if (row === undefined) throw new Error("expected one row")
    expect(row.name).toBe("quanta.gate.permission.allow.total")
    expect(row.kind).toBe("counter")
    expect(row.value).toBe(2)
    expect(row.labels).toEqual({ kind: "permission", outcome: "allow" })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-11 — non-decision events are ignored entirely.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-11: non-decision AgentEvents leave the counter set empty", () => {
    const { registry, calls } = spyRegistry()
    const sink = createDecisionCounterSink({ metrics: registry })
    const noise: AgentEvent[] = [
      { type: "session_start" },
      { type: "turn_start", turn: 1 },
      { type: "llm_request", model: "gpt-5" },
      { type: "assistant_text", delta: "hi" },
      { type: "tool_call", id: "t1", name: "shell", input: {} },
      {
        type: "tool_result",
        id: "t1",
        name: "shell",
        ok: true,
        preview: "",
      },
      { type: "recovery", reason: "compact" },
      { type: "error", message: "boom" },
      {
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
        model: "gpt-5",
      },
      { type: "done", reason: "ok", turns: 1 },
    ]
    for (const ev of noise) sink.emit(ev)
    expect(calls).toHaveLength(0)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-12 — registry throw never poisons the sink.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-12: throwing registry → emit no-throws (try/catch swallows)", () => {
    const throwing: MetricsRegistry = {
      increment() {
        throw new Error("registry boom")
      },
      observe() {},
      gauge() {},
      snapshot() {
        return []
      },
      reset() {},
      async flush() {},
    }
    const sink = createDecisionCounterSink({ metrics: throwing })
    expect(() => sink.emit(decisionEvent("rule", "deny"))).not.toThrow()
    // Sequential emits all swallow — no cumulative state poisoning.
    for (let i = 0; i < 5; i += 1) {
      expect(() => sink.emit(decisionEvent("hook", "ask"))).not.toThrow()
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-13 — custom prefix.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-13: custom prefix honored — `test.permission.allow.total`", () => {
    const { registry, calls } = spyRegistry()
    const sink = createDecisionCounterSink({ metrics: registry, prefix: "test" })
    sink.emit(decisionEvent("permission", "allow"))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe("test.permission.allow.total")
  })

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-14 — cardinality invariant: ONLY {kind, outcome} make it to the
  // counter labels. toolCallId / ruleId / hookName / metadata are never
  // forwarded as label keys.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-14: cardinality invariant — only {kind,outcome} reach labels", () => {
    const { registry, calls } = spyRegistry()
    const sink = createDecisionCounterSink({ metrics: registry })
    sink.emit(
      decisionEvent("rule", "deny", {
        toolCallId: "call-42",
        ruleId: "rule-xyz",
        hookName: "before_shell",
        metadata: { secret: "never-leak", tokens: 9000 },
      }),
    )
    expect(calls).toHaveLength(1)
    const labels = calls[0]?.labels ?? {}
    expect(Object.keys(labels).sort()).toEqual(["kind", "outcome"])
    expect(labels).toEqual({ kind: "rule", outcome: "deny" })
    // Specific high-cardinality fields MUST be absent — assert positively.
    expect("toolCallId" in labels).toBe(false)
    expect("ruleId" in labels).toBe(false)
    expect("hookName" in labels).toBe(false)
    expect("reason" in labels).toBe(false)
    expect("metadata" in labels).toBe(false)
    expect("secret" in labels).toBe(false)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-15 — every member of the closed `kind` union is supported.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-15: cap/jail/budget kinds also produce canonical counter names", () => {
    const registry = defaultMetricsRegistry()
    const sink = createDecisionCounterSink({ metrics: registry })
    sink.emit(decisionEvent("cap", "deny"))
    sink.emit(decisionEvent("jail", "deny"))
    sink.emit(decisionEvent("budget", "allow"))
    const names = registry
      .snapshot()
      .map((r) => r.name)
      .sort()
    expect(names).toEqual([
      "quanta.gate.budget.allow.total",
      "quanta.gate.cap.deny.total",
      "quanta.gate.jail.deny.total",
    ])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // HELL-DC-16 — empty/whitespace prefix falls back to default.
  // ──────────────────────────────────────────────────────────────────────────
  test("HELL-DC-16: empty/whitespace prefix falls back to `quanta.gate`", () => {
    const { registry, calls } = spyRegistry()
    const sinkEmpty = createDecisionCounterSink({ metrics: registry, prefix: "" })
    sinkEmpty.emit(decisionEvent("permission", "allow"))
    expect(calls[0]?.name).toBe("quanta.gate.permission.allow.total")

    calls.length = 0
    const sinkWs = createDecisionCounterSink({ metrics: registry, prefix: "   " })
    sinkWs.emit(decisionEvent("hook", "ask"))
    expect(calls[0]?.name).toBe("quanta.gate.hook.ask.total")
  })
})
