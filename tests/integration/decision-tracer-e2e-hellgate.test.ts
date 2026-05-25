/** biome-ignore-all lint/style/noRestrictedImports: cross-slice e2e hellgate — `debug-tracer` is the production surface adapter under audit; `@/apps/cli/*` has no public alias (intentional); verbatim source path is the documented escape-hatch for surface-integration test tier. */
/**
 * Cross-slice integration hellgate — decision-emit → TeeStream → debug-tracer → stderr.
 *
 * Slices stitched (read-only — no source mutation):
 *   - `@/agent/admissibility-gate`   (real gate, emits `decision` events)
 *   - `@/stream` (DecisionEmitter port + `decisionEmitterFromStream` + TeeStream)
 *   - `@/apps/cli/debug-tracer`      (real `createDebugTracer` → captured sink)
 *   - `@/session/envelope`           (round-trip via EventDecisionSchema)
 *
 * Story: a real call to `runAdmissibilityGate` produces a real `DecisionEvent`.
 * The event flows through a `StreamPort` tee (production composition root
 * pattern) which fans out to (1) the real debug-tracer (writing to a captured
 * stderr sink) and (2) optionally a second consumer that exercises the
 * isolation invariants. Every assertion targets observable BEHAVIOR — stderr
 * line substrings, sink call counts, category filtering, error-isolation —
 * not return values of mocks.
 *
 * Default-OFF byte identity is verified at the gate level: emitter absent ⇒
 * gate decision still null/non-null in the same shape.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import type { HITLTier, PermissionContext } from "@/permission"
import { RulesStore } from "@/rules"
import { EventDecisionSchema } from "@/session/envelope"
import {
  type AgentEvent,
  type DecisionEvent,
  decisionEmitterFromStream,
  type StreamPort,
  TeeStream,
} from "@/stream"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import {
  createDebugTracer,
  type DebugCategory,
  type DebugTracer,
} from "../../src/apps/cli/debug-tracer"

// ─── fixtures ─────────────────────────────────────────────────────────────

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    hitlTier?: (input: unknown) => HITLTier
    run?: () => AsyncIterable<ToolEvent>
  } = {},
): Tool => {
  const t: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () =>
      opts.run
        ? opts.run()
        : (async function* () {
            yield { type: "result", result: { ok: true, output: "ran" } }
          })(),
  }
  if (opts.hitlTier) {
    ;(t as Tool & { hitlTier: (input: unknown) => HITLTier }).hitlTier = opts.hitlTier
  }
  return t
}

const bashSchema = z.object({ command: z.string() })

const callOf = (name: string, input: unknown = {}, id = "tc_e2e"): ToolUseBlock => ({
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

/** Capture sink for the debug-tracer. Splits on "\n" and collects non-empty
 *  lines so each emitted line is one array entry — exactly what the user
 *  would scroll past on stderr. */
const captureStderr = (): { lines: string[]; write: (chunk: string) => void } => {
  const lines: string[] = []
  return {
    lines,
    write: (chunk: string): void => {
      for (const piece of chunk.split("\n")) if (piece.length > 0) lines.push(piece)
    },
  }
}

/** A `StreamPort` adapter that records every received `AgentEvent` into a
 *  visible array — used to prove tee fan-out. */
const recordingStream = (): { port: StreamPort; events: AgentEvent[] } => {
  const events: AgentEvent[] = []
  const port: StreamPort = {
    emit(event: AgentEvent): void {
      events.push(event)
    },
  }
  return { port, events }
}

/** Build a tracer-as-StreamPort: same shape the composition root uses to wire
 *  the tracer behind the existing tee. */
const tracerAsStream = (tracer: DebugTracer): StreamPort => ({
  emit(event: AgentEvent): void {
    tracer(event)
  },
})

// ─── Test 1.1 — permission allow path ─────────────────────────────────────

describe("integration e2e — decision emit → tee → debug-tracer → stderr", () => {
  test("case-01: permission allow path → stderr line contains permission=allow", async () => {
    const read = makeTool("read", { readOnly: true })
    const { lines, write } = captureStderr()
    const tracer = createDebugTracer({ write, color: false, now: () => 1717000000000 })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_perm_allow")
    const res = await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    expect(res).toBe(null)
    // Exactly one decision line landed on stderr (no hooks ⇒ no hook line).
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("decision")
    expect(ln).toContain("permission=allow")
    expect(ln).toContain("tc_perm_allow")
  })

  test("case-02: permission ask path → exactly 1 stderr line; permission=ask outcome pinned", async () => {
    const write = makeTool("write")
    const cap = captureStderr()
    const tracer = createDebugTracer({ write: cap.write, color: false, now: () => 1717000000000 })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([write]),
      permission: { mode: "default" } as PermissionContext,
      // no onConfirm wired ⇒ ask path → default deny
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("write", {}, "tc_perm_ask")
    const res = await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(write))
    expect(res).not.toBe(null)
    // EXACT count: the mode-policy emit site is the only one that fires on
    // the ask-no-onConfirm path. A future regression that double-emits
    // (e.g. emitting both `ask` AND a synthesized `deny` for the same call)
    // would surface as a count-2 here and trip this assertion.
    expect(cap.lines).toHaveLength(1)
    const ln = cap.lines[0] ?? ""
    expect(ln).toContain("decision")
    expect(ln).toContain("permission=ask")
    expect(ln).toContain("tc_perm_ask")
    // ORTHOGONAL outcome — no `allow`/`deny` segment on the SAME line.
    expect(ln).not.toContain("permission=allow")
    expect(ln).not.toContain("permission=deny")
  })

  test("case-03: rule deny path → ruleId appears in stderr line", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const cap = captureStderr()
    const tracer = createDebugTracer({ write: cap.write, color: false, now: () => 1717000000000 })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([bash]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("bash", { command: "ls" }, "tc_rule_deny")
    const res = await runAdmissibilityGate(
      u,
      cfg,
      cfg.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(res).not.toBe(null)
    expect(cap.lines).toHaveLength(1)
    const ln = cap.lines[0] ?? ""
    expect(ln).toContain("rule=deny")
    // ruleId is "<layer>:<sourceFile>:<sourceLine>" — at minimum the layer
    // prefix must surface so a developer can locate the source.
    expect(ln).toContain("project:")
    expect(ln).toContain("tc_rule_deny")
  })

  test("case-04: hook deny path → EXACTLY 2 stderr lines in correct order (permission allow → hook deny)", async () => {
    const read = makeTool("read", { readOnly: true })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked by hook" }))
    const cap = captureStderr()
    const tracer = createDebugTracer({ write: cap.write, color: false, now: () => 1717000000000 })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      hooks,
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_hook_deny")
    const res = await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    expect(res).not.toBe(null)
    // EXACT count + ORDER — permission allow emits FIRST, then hook deny.
    // The gate runs permission → rules → hooks; permission allows the
    // read (read-only default-allow), then the hook denies.
    expect(cap.lines).toHaveLength(2)
    expect(cap.lines[0]).toContain("permission=allow")
    expect(cap.lines[0]).toContain("tc_hook_deny")
    expect(cap.lines[1]).toContain("hook=deny")
    expect(cap.lines[1]).toContain("hook=pre_tool_use")
    expect(cap.lines[1]).toContain("blocked by hook")
    expect(cap.lines[1]).toContain("tc_hook_deny")
    // CROSS — no `hook=` segment on the permission line, no `permission=` on
    // the hook line (verifies the formatter doesn't accidentally fan
    // metadata across decision rows).
    expect(cap.lines[0]).not.toContain("hook=deny")
    expect(cap.lines[1]).not.toContain("permission=allow")
  })

  // ── Category-filter cases ──────────────────────────────────────────────

  test("case-05: tracer filter={decisions} ⇒ decision lines pass through", async () => {
    const read = makeTool("read", { readOnly: true })
    const cap = captureStderr()
    const cats: ReadonlySet<DebugCategory> = new Set<DebugCategory>(["decisions"])
    const tracer = createDebugTracer({
      write: cap.write,
      color: false,
      now: () => 1717000000000,
      categories: cats,
    })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    // Push an unrelated AgentEvent through the tee too — the tracer should
    // drop it.
    tee.emit({ type: "tool_call", id: "tc_other", name: "read", input: {}, turn: 0 } as AgentEvent)
    const u = callOf("read", {}, "tc_dec_only")
    await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    expect(cap.lines).toHaveLength(1)
    expect(cap.lines[0]).toContain("decision")
    expect(cap.lines[0]).not.toContain("tool_call")
  })

  test("case-06: tracer filter={tools} ⇒ decision events suppressed", async () => {
    const read = makeTool("read", { readOnly: true })
    const cap = captureStderr()
    const cats: ReadonlySet<DebugCategory> = new Set<DebugCategory>(["tools"])
    const tracer = createDebugTracer({
      write: cap.write,
      color: false,
      now: () => 1717000000000,
      categories: cats,
    })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_tools_only")
    await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    // Decisions filtered out at the tracer; tee got the event but the tracer
    // didn't write a line for it.
    expect(cap.lines).toHaveLength(0)
  })

  // ── Sanitisation case ───────────────────────────────────────────────────

  test("case-07: metadata is truncated AND a verbatim secret-shape value cannot leak verbatim", async () => {
    // Build a recording StreamPort that DOES route through the tee → tracer,
    // but feed a synthetic `decision` AgentEvent carrying a large metadata
    // bag (simulating a poorly-sanitised emit site). The tracer must
    // truncate the rendered `md=...` segment.
    const cap = captureStderr()
    const tracer = createDebugTracer({ write: cap.write, color: false, now: () => 1717000000000 })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const huge = "X".repeat(500)
    // SECRET-SHAPE VALUE — must NOT appear verbatim in stderr (would surface
    // a key leak under live `QUANTA_DEBUG=1`). We don't expect the tracer to
    // recognise this string as a secret (sanitisation is the emit site's
    // job), but we DO expect truncation to bound how much leaks.
    const secret = "sk-test-VERYSECRET-PAYLOAD-MUST-NOT-LEAK-IN-DEBUG-CHANNEL"
    const ev: DecisionEvent = {
      type: "decision",
      kind: "permission",
      outcome: "allow",
      turn: 0,
      reason: "mode='default' allow",
      toolCallId: "tc_md_trunc",
      metadata: { tool: "read", big: huge, password: secret },
    }
    tee.emit(ev)
    expect(cap.lines).toHaveLength(1)
    const ln = cap.lines[0] ?? ""
    // Look for "md=" segment and assert the rendered metadata body is bounded.
    const mdIdx = ln.indexOf("md=")
    expect(mdIdx).toBeGreaterThan(-1)
    const mdBody = ln.slice(mdIdx + 3)
    // The tracer truncates with a hard 100-char cap (TRUNC constant). Allow
    // a little slack for the trailing "…" marker.
    expect(mdBody.length).toBeLessThanOrEqual(102)
    // Truncation marker must be present (Unicode … sentinel) — proves
    // truncation actually fired, not that the string happened to be short.
    expect(mdBody.endsWith("…")).toBe(true)
    // The full 500-X payload MUST NOT be present.
    expect(ln).not.toContain("X".repeat(120))
    // BYTE-LEVEL secret invariant — the verbatim secret value must NOT
    // appear in any tracer line (the secret is past the 100-char cap, so
    // truncation alone is enough; this asserts the property explicitly).
    expect(ln).not.toContain(secret)
  })

  // ── Isolation cases ─────────────────────────────────────────────────────

  test("case-08: throwing decisionEmitter does NOT poison the gate result", async () => {
    const read = makeTool("read", { readOnly: true })
    // Build a tee with one POISON consumer in front. `safeEmitDecision`
    // already wraps the gate-side emit; the tee's strict=false mode is the
    // belt-and-braces (see `TeeStream`).
    const tee = new TeeStream([
      {
        emit: () => {
          throw new Error("simulated tracer crash")
        },
      },
    ])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_iso")
    const res = await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    // Throw was swallowed — gate still returns admit (null).
    expect(res).toBe(null)
    // TeeStream tracked the degradation.
    expect(tee.degraded().length).toBeGreaterThanOrEqual(1)
  })

  test("case-09: poison tracer does NOT starve a second sink in same tee", async () => {
    const read = makeTool("read", { readOnly: true })
    const rec = recordingStream()
    const poisonPort: StreamPort = {
      emit: () => {
        throw new Error("simulated tracer crash")
      },
    }
    const tee = new TeeStream([poisonPort, rec.port])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_starve")
    await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    // The recording sink received the event despite the poison consumer
    // throwing.
    const decisions = rec.events.filter((e) => e.type === "decision")
    expect(decisions.length).toBeGreaterThanOrEqual(1)
    expect(decisions[0]).toMatchObject({
      type: "decision",
      kind: "permission",
      outcome: "allow",
      toolCallId: "tc_starve",
    })
  })

  test("case-10: 10 concurrent gate runs → exactly 10 stderr lines; every id appears exactly once", async () => {
    const read = makeTool("read", { readOnly: true })
    const cap = captureStderr()
    // Use a MONOTONIC clock so the wall-clock column is deterministic — each
    // line carries a distinct timestamp. This lets us assert the tracer is
    // emitting in CALL-AWAITED order (not silently dropping or deduping).
    let tick = 1717000000000
    const tracer = createDebugTracer({
      write: cap.write,
      color: false,
      now: () => {
        tick += 1
        return tick
      },
    })
    const tee = new TeeStream([tracerAsStream(tracer)])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const ids = Array.from({ length: 10 }, (_, i) => `tc_conc_${i}`)
    await Promise.all(
      ids.map((id) =>
        runAdmissibilityGate(callOf("read", {}, id), cfg, cfg.permission, actionOf(read)),
      ),
    )
    expect(cap.lines).toHaveLength(10)
    // Every id appears EXACTLY once — no duplicate emits across concurrency.
    for (const id of ids) {
      const hits = cap.lines.filter((l) => l.includes(id))
      expect(hits.length).toBe(1)
    }
    // Every line starts with the wall-clock column the tracer emits — proves
    // the formatter ran ten times, no fall-through to the empty-line
    // catch-arm.
    for (const ln of cap.lines) expect(ln).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}\s/)
    // CARDINALITY — outcomes are uniform (`permission=allow`). A regression
    // that fans extra `permission=ask` lines would surface here as >10.
    expect(cap.lines.filter((l) => l.includes("permission=allow")).length).toBe(10)
  })

  // ── Non-TTY tracer still lets other consumers run ───────────────────────

  test("case-11: EPIPE-throwing peer in tee ⇒ second sink still receives + tee degraded count rises", async () => {
    const read = makeTool("read", { readOnly: true })
    // Build a tracer-shaped sink whose `emit` throws (simulating EPIPE / closed
    // pipe). The tee's strict=false mode swallows the throw and accumulates
    // a degraded-counter entry. The second sink still receives the event.
    const rec = recordingStream()
    const drop: StreamPort = {
      emit: () => {
        throw new Error("EPIPE")
      },
    }
    const tee = new TeeStream([drop, rec.port])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_nontty")
    const res = await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    // Gate result is unaffected — the peer throw is swallowed.
    expect(res).toBe(null)
    // Second consumer received the event.
    const dec = rec.events.find((e) => e.type === "decision") as DecisionEvent | undefined
    expect(dec).toBeDefined()
    expect(dec?.toolCallId).toBe("tc_nontty")
    // Tee tracks the degradation — observable post-condition.
    expect(tee.degraded().length).toBeGreaterThanOrEqual(1)
  })

  // ── Categories no-op + non-TTY default propagation ──────────────────────

  test("case-12: tracer category filter excluding 'decisions' ⇒ zero stderr lines; other consumers still see decision", async () => {
    // INVARIANT: when the tracer's `categories` set DOES NOT include
    // "decisions", a real decision event must produce ZERO tracer output AND
    // the same tee's second consumer still receives the event. This is the
    // "non-TTY tracer no-op" equivalent expressed via the tracer's actual
    // category-filter knob — the env-boot parser (`parseDebugEnv`) sets the
    // exact same set, so this case proves the production wiring path.
    const read = makeTool("read", { readOnly: true })
    const cap = captureStderr()
    const rec = recordingStream()
    const cats: ReadonlySet<DebugCategory> = new Set<DebugCategory>(["tools"]) // decisions excluded
    const tracer = createDebugTracer({
      write: cap.write,
      color: false,
      now: () => 1717000000000,
      categories: cats,
    })
    const tee = new TeeStream([tracerAsStream(tracer), rec.port])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_no_op")
    await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    // Tracer DROPPED the event — zero stderr lines (the no-op invariant).
    expect(cap.lines).toHaveLength(0)
    // Recorder still saw the event — the filter is local to the tracer, the
    // tee's other consumers are unaffected.
    const dec = rec.events.find((e) => e.type === "decision")
    expect(dec).toBeDefined()
  })

  // ── Envelope round-trip + dual-consumer ─────────────────────────────────

  test("case-13: envelope round-trip — tracer + recorder both see decision; schema validates", async () => {
    const read = makeTool("read", { readOnly: true })
    const cap = captureStderr()
    const tracer = createDebugTracer({ write: cap.write, color: false, now: () => 1717000000000 })
    const rec = recordingStream()
    const tee = new TeeStream([tracerAsStream(tracer), rec.port])
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(tee),
    })
    const u = callOf("read", {}, "tc_env_rt")
    await runAdmissibilityGate(u, cfg, cfg.permission, actionOf(read))
    // Tracer wrote a line.
    expect(cap.lines).toHaveLength(1)
    // Recorder captured the same decision.
    const dec = rec.events.find((e) => e.type === "decision") as DecisionEvent | undefined
    expect(dec).toBeDefined()
    // Convert AgentEvent.decision → on-wire EventDecisionRecord and validate
    // via the envelope schema (proves the structural shape contract). The
    // EventBase shape REQUIRES type/schema_version/ts/turn_id; supply them.
    // `turn_id` must be a non-empty string — we synthesize from `dec.turn`.
    const wire = {
      type: "event_msg" as const,
      schema_version: 2 as const,
      ts: new Date(1717000000000).toISOString(),
      turn_id: `t${dec?.turn ?? 0}`,
      kind: "decision" as const,
      gate: dec?.kind ?? "permission",
      outcome: dec?.outcome ?? "allow",
      decision_reason: dec?.reason ?? "fallback",
      ...(dec?.toolCallId !== undefined ? { tool_call_id: dec.toolCallId } : {}),
      ...(dec?.ruleId !== undefined ? { rule_id: dec.ruleId } : {}),
      ...(dec?.hookName !== undefined ? { hook_name: dec.hookName } : {}),
      ...(dec?.metadata !== undefined ? { metadata: dec.metadata } : {}),
    }
    const parsed = EventDecisionSchema.safeParse(wire)
    expect(parsed.success).toBe(true)
  })
})
