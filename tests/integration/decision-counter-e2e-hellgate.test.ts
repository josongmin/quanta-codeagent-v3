/**
 * Cross-slice integration hellgate — gate-decision emit → TeeStream →
 * createDecisionCounterSink → MetricsRegistry counter.
 *
 * Slices stitched (read-only — no source mutation):
 *   - `@/agent/admissibility-gate`          (real gate)
 *   - `@/stream` (DecisionEmitter + TeeStream)
 *   - `@/observability/metrics`              (createDecisionCounterSink +
 *                                              real in-memory MetricsRegistry)
 *
 * Story: a real call to `runAdmissibilityGate` produces real `decision`
 * events. These flow through a real `TeeStream` whose downstream is the
 * production `createDecisionCounterSink`, backed by a real
 * `defaultMetricsRegistry`. Every assertion targets the registry's actual
 * counter snapshot — not the mock return value.
 *
 * Cardinality invariant (HARD) — `kind` and `outcome` are the ONLY label
 * keys. Verified by inspecting `MetricsRegistry.snapshot()` rows directly.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import {
  createDecisionCounterSink,
  defaultMetricsRegistry,
  type MetricsRegistry,
  type MetricSnapshot,
} from "@/observability/metrics/index"
import type { PermissionContext } from "@/permission"
import { RulesStore } from "@/rules"
import {
  type AgentEvent,
  decisionEmitterFromStream,
  type DecisionEvent,
  type StreamPort,
  TeeStream,
} from "@/stream"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// ─── fixtures ─────────────────────────────────────────────────────────────

const makeTool = (
  name: string,
  opts: { readOnly?: boolean; schema?: z.ZodTypeAny } = {},
): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
  isReadOnly: () => opts.readOnly ?? false,
  isConcurrencySafe: () => opts.readOnly ?? false,
  execute: () =>
    (async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    })(),
})

const bashSchema = z.object({ command: z.string() })

const callOf = (name: string, input: unknown = {}, id = "tc_dc"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfgOf = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

const actionOf = (tool: Tool, input: unknown = {}): AdmissibilityAction => ({
  tool: tool.name,
  input,
  isReadOnly: tool.isReadOnly(),
})

/** Sink + registry pair — same shape a composition root wires. */
const wireGateToCounter = (
  prefix?: string,
): {
  metrics: MetricsRegistry
  emitter: AgentConfig["decisionEmitter"]
  tee: TeeStream
} => {
  const metrics = defaultMetricsRegistry()
  const sink = prefix !== undefined
    ? createDecisionCounterSink({ metrics, prefix })
    : createDecisionCounterSink({ metrics })
  // The counter sink is `StreamLike`; TeeStream demands `StreamPort`. Adapt
  // by re-emitting through the structural shim (same trick the composition
  // root uses — the production wire is identical).
  const adapter: StreamPort = { emit: (e: AgentEvent) => sink.emit(e) }
  const tee = new TeeStream([adapter])
  return {
    metrics,
    emitter: decisionEmitterFromStream(tee),
    tee,
  }
}

const snapshotOf = (m: MetricsRegistry, name: string): MetricSnapshot[] =>
  m.snapshot().filter((row) => row.name === name)

const counterTotal = (m: MetricsRegistry, name: string): number => {
  // For the in-memory adapter, counter snapshot exposes `.value` on each row.
  // We sum across all label permutations of the same name (in practice only
  // one — see cardinality invariant in `decision-counter-sink.ts`).
  let total = 0
  for (const row of snapshotOf(m, name)) total += row.value
  return total
}

// ─── Test 2 — 10 cases ────────────────────────────────────────────────────

describe("integration e2e — decision emit → tee → counter sink → registry", () => {
  test("case-01: permission allow ⇒ quanta.gate.permission.allow.total += 1", async () => {
    const read = makeTool("read", { readOnly: true })
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([read]), decisionEmitter: emitter })
    const res = await runAdmissibilityGate(callOf("read", {}, "tc1"), cfg, cfg.permission, actionOf(read))
    expect(res).toBe(null)
    expect(counterTotal(metrics, "quanta.gate.permission.allow.total")).toBe(1)
  })

  test("case-02: rule deny ⇒ quanta.gate.rule.deny.total += 1, permission counter ZERO", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([bash]), decisionEmitter: emitter })
    await runAdmissibilityGate(
      callOf("bash", { command: "ls" }, "tc2"),
      cfg,
      cfg.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(counterTotal(metrics, "quanta.gate.rule.deny.total")).toBe(1)
    // The deny short-circuited BEFORE the permission gate — verify no
    // permission counter was incremented as a side effect.
    expect(counterTotal(metrics, "quanta.gate.permission.allow.total")).toBe(0)
  })

  test("case-03: rule allow ⇒ quanta.gate.rule.allow.total += 1 (rule path)", async () => {
    const read = makeTool("read", { readOnly: true })
    const rules = new RulesStore()
    rules.loadLayer("project", "allow read", "/tmp/.quanta/rules")
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([read]), decisionEmitter: emitter })
    await runAdmissibilityGate(
      callOf("read", {}, "tc3"),
      cfg,
      cfg.permission,
      actionOf(read),
      undefined,
      { rulesStore: rules },
    )
    expect(counterTotal(metrics, "quanta.gate.rule.allow.total")).toBe(1)
  })

  test("case-04: hook deny ⇒ quanta.gate.hook.deny.total += 1", async () => {
    const read = makeTool("read", { readOnly: true })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked" }))
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      hooks,
      decisionEmitter: emitter,
    })
    await runAdmissibilityGate(callOf("read", {}, "tc4"), cfg, cfg.permission, actionOf(read))
    expect(counterTotal(metrics, "quanta.gate.hook.deny.total")).toBe(1)
  })

  test("case-05: hook allow ⇒ quanta.gate.hook.allow.total += 1", async () => {
    const read = makeTool("read", { readOnly: true })
    const hooks = new HookBus() // no handlers — pass-through admit
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      hooks,
      decisionEmitter: emitter,
    })
    await runAdmissibilityGate(callOf("read", {}, "tc5"), cfg, cfg.permission, actionOf(read))
    expect(counterTotal(metrics, "quanta.gate.hook.allow.total")).toBe(1)
  })

  test("case-06: permission ask (no onConfirm) ⇒ quanta.gate.permission.ask.total += 1", async () => {
    const write = makeTool("write")
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({
      registry: new ToolRegistry([write]),
      permission: { mode: "default" } as PermissionContext,
      decisionEmitter: emitter,
    })
    await runAdmissibilityGate(callOf("write", {}, "tc6"), cfg, cfg.permission, actionOf(write))
    expect(counterTotal(metrics, "quanta.gate.permission.ask.total")).toBe(1)
  })

  test("case-07: rule ask (no reviewer wired) ⇒ quanta.gate.rule.ask.total += 1", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "ask bash", "/tmp/.quanta/rules")
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([bash]), decisionEmitter: emitter })
    await runAdmissibilityGate(
      callOf("bash", { command: "ls" }, "tc7"),
      cfg,
      cfg.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(counterTotal(metrics, "quanta.gate.rule.ask.total")).toBe(1)
  })

  test("case-08: 20 identical allow gate runs ⇒ counter = 20 (label-stable)", async () => {
    const read = makeTool("read", { readOnly: true })
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([read]), decisionEmitter: emitter })
    for (let i = 0; i < 20; i++) {
      await runAdmissibilityGate(callOf("read", {}, `tc_loop_${i}`), cfg, cfg.permission, actionOf(read))
    }
    expect(counterTotal(metrics, "quanta.gate.permission.allow.total")).toBe(20)
    // Cardinality stays bounded — exactly ONE series row per (kind, outcome).
    const rows = snapshotOf(metrics, "quanta.gate.permission.allow.total")
    expect(rows.length).toBe(1)
  })

  test("case-09: non-decision AgentEvents are ignored — counter unchanged", async () => {
    const { metrics, tee } = wireGateToCounter()
    // Flood 10 unrelated AgentEvent variants through the tee. None should
    // touch the counter. We construct them with the minimum required fields
    // per the AgentEvent union; `tee.emit` accepts the full union.
    const nonDecisionEvents: AgentEvent[] = [
      { type: "tool_call", id: "x", name: "read", input: {} },
      { type: "tool_result", id: "x", name: "read", ok: true, preview: "x", durationMs: 1 },
      { type: "turn_start", turn: 1 },
      { type: "llm_request", model: "stub", provider: "anthropic" },
      { type: "usage", inputTokens: 1, outputTokens: 2, model: "stub" },
      { type: "recovery", reason: "compact", detail: "x" },
      { type: "done", reason: "ok", turns: 1 },
      { type: "assistant_text", delta: "hi" },
      { type: "in_progress", timestamp: 1, message: "thinking" },
      { type: "tool_progress", id: "x", name: "read", message: "step" },
    ]
    for (const ev of nonDecisionEvents) tee.emit(ev)
    // Every quanta.gate.* counter must be ZERO — no decision events landed.
    const all = metrics.snapshot()
    const gateRows = all.filter((row) => row.name.startsWith("quanta.gate."))
    expect(gateRows.length).toBe(0)
  })

  test("case-10: cardinality invariant — labels set is EXACTLY {kind, outcome}, no leakage", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([bash]), decisionEmitter: emitter })
    await runAdmissibilityGate(
      callOf("bash", { command: "ls" }, "tc_card_unique"),
      cfg,
      cfg.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    const rows = snapshotOf(metrics, "quanta.gate.rule.deny.total")
    expect(rows.length).toBe(1)
    const labels = rows[0]?.labels ?? {}
    const keys = Object.keys(labels).sort()
    // Cardinality invariant: ONLY kind + outcome.
    expect(keys).toEqual(["kind", "outcome"])
    expect(labels.kind).toBe("rule")
    expect(labels.outcome).toBe("deny")
    // Forbidden label keys MUST NOT be present.
    for (const forbidden of ["toolCallId", "ruleId", "hookName", "reason", "metadata", "tool"]) {
      expect(keys.includes(forbidden)).toBe(false)
    }
  })

  test("case-11: throwing registry ⇒ tee not poisoned; other consumers still see events", async () => {
    const read = makeTool("read", { readOnly: true })
    const poisonMetrics: MetricsRegistry = {
      increment: () => {
        throw new Error("boom")
      },
      observe: () => {},
      gauge: () => {},
      snapshot: () => [],
      reset: () => {},
      async flush() {
        return
      },
    }
    const sink = createDecisionCounterSink({ metrics: poisonMetrics })
    const otherSeen: AgentEvent[] = []
    const tee = new TeeStream([
      { emit: (e: AgentEvent) => sink.emit(e) },
      { emit: (e: AgentEvent) => otherSeen.push(e) },
    ])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const res = await runAdmissibilityGate(callOf("read", {}, "tc_poison"), cfg, cfg.permission, actionOf(read))
    // Gate result unaffected.
    expect(res).toBe(null)
    // Tee not degraded — the SINK swallowed its own throw per defense-in-depth.
    expect(tee.degraded().length).toBe(0)
    // Other consumer still received the decision.
    expect(otherSeen.find((e) => e.type === "decision")).toBeDefined()
  })

  test("case-12: 1000 emit load → counter exactly 1000, snapshot O(1) series", async () => {
    const read = makeTool("read", { readOnly: true })
    const { metrics, emitter } = wireGateToCounter()
    const cfg = cfgOf({ registry: new ToolRegistry([read]), decisionEmitter: emitter })
    // Run 1000 admit-path gates. Each emits exactly one permission.allow
    // event (no hooks ⇒ no hook line).
    for (let i = 0; i < 1000; i++) {
      await runAdmissibilityGate(callOf("read", {}, `tc_load_${i}`), cfg, cfg.permission, actionOf(read))
    }
    expect(counterTotal(metrics, "quanta.gate.permission.allow.total")).toBe(1000)
    // Cardinality stays at exactly 1 series row.
    expect(snapshotOf(metrics, "quanta.gate.permission.allow.total").length).toBe(1)
  })

  test("case-13: custom prefix ⇒ counter name '<prefix>.<kind>.<outcome>.total'", async () => {
    const read = makeTool("read", { readOnly: true })
    const { metrics, emitter } = wireGateToCounter("sub.agent")
    const cfg = cfgOf({ registry: new ToolRegistry([read]), decisionEmitter: emitter })
    await runAdmissibilityGate(callOf("read", {}, "tc_prefix"), cfg, cfg.permission, actionOf(read))
    expect(counterTotal(metrics, "sub.agent.permission.allow.total")).toBe(1)
    // Default-prefix name must NOT be present.
    expect(counterTotal(metrics, "quanta.gate.permission.allow.total")).toBe(0)
  })

  test("case-14: synthetic decision events for closed-taxonomy kinds (cap/jail/budget)", async () => {
    // These kinds are part of the closed taxonomy but the gate doesn't emit
    // them today (different subsystems will). We synthesise direct
    // `decision` events into the tee — same path the gate uses.
    const { metrics, tee } = wireGateToCounter()
    const synth = (kind: DecisionEvent["kind"], outcome: DecisionEvent["outcome"]): DecisionEvent => ({
      type: "decision",
      turn: 0,
      kind,
      outcome,
      reason: "synthetic",
    })
    tee.emit(synth("cap", "deny"))
    tee.emit(synth("jail", "deny"))
    tee.emit(synth("budget", "allow"))
    expect(counterTotal(metrics, "quanta.gate.cap.deny.total")).toBe(1)
    expect(counterTotal(metrics, "quanta.gate.jail.deny.total")).toBe(1)
    expect(counterTotal(metrics, "quanta.gate.budget.allow.total")).toBe(1)
  })
})
