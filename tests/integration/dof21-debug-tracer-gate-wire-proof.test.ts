/** biome-ignore-all lint/style/noRestrictedImports: cross-slice DOF-21 proof — `@/apps/cli/*` has no public alias (intentional); verbatim source path is the documented escape-hatch for the surface-integration test tier. This proof drives the real production factory `buildDebugTracerAndStream` under the real `QUANTA_DEBUG` gate. */
/**
 * DOF-21 real-proof — debug-tracer-decision-event.
 *
 * WHAT THIS REPLACES / STRENGTHENS
 * --------------------------------
 * `tests/integration/decision-tracer-e2e-hellgate.test.ts` drives the real
 * admissibility gate and real `createDebugTracer`, but it constructs the tracer
 * DIRECTLY (`createDebugTracer({ write, ... })`) and tees it in by hand. It never
 * exercises the production GATE: `QUANTA_DEBUG` → `readCliFeatureConfig` →
 * `buildDebugTracerAndStream`, which is the factory that DECIDES whether a tee /
 * tracer exists at all. So the existing test proves the tracer's output SHAPE,
 * not that a real decision event reaches the tracer sink THROUGH THE GATED WIRE.
 *
 * This proof closes that gap end-to-end:
 *   env `QUANTA_DEBUG=1` (+ stderr TTY)  →  real `readCliFeatureConfig`
 *      →  real `buildDebugTracerAndStream(featureCfg, baseStream)`
 *      →  the RETURNED (tee-wrapped) stream is used as the decision emitter's sink
 *      →  a REAL `runAdmissibilityGate` call emits a real `decision` event
 *      →  the tracer writes a `decision permission=...` line to `process.stderr`.
 *
 * The tracer built by the factory writes to the REAL `process.stderr` (the
 * factory passes no `write` override — that IS the production sink), so this
 * proof captures `process.stderr.write` to observe the authentic wire, not a
 * hand-injected buffer.
 *
 * PAIRED CONTROL (the load-bearing half):
 *   - Gate OFF (`QUANTA_DEBUG` unset) ⇒ `readCliFeatureConfig` yields
 *     `debugTracer.enabled === false` ⇒ `buildDebugTracerAndStream` returns the
 *     LITERAL base stream reference (no tee, `debugHandle === undefined`). The
 *     SAME real decision event flows through, and ZERO tracer lines hit stderr.
 *     A regression that wired the tracer regardless of the gate would print a
 *     `decision` line here and go RED.
 *   - Non-TTY control: `QUANTA_DEBUG=1` but `stderrIsTTY=false` ⇒ still disabled
 *     (pipe/redirect protection). Proves the gate is a conjunction.
 *
 * Byte-identity witness: gate-OFF returns the SAME stream object it was handed
 * (`Object.is`), proving the default path allocates no extra consumer.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import { buildDebugTracerAndStream } from "@/apps/cli/repl/factories"
import { type CliFeatureConfig, readCliFeatureConfig } from "@/apps/cli/repl/cli-feature-config"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { decisionEmitterFromStream } from "@/stream"
import type { ToolUseBlock } from "@/llm"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// ─── fixtures ─────────────────────────────────────────────────────────────

const makeReadTool = (name = "read"): Tool =>
  ({
    name,
    description: `${name} tool`,
    inputSchema: z.object({}) as z.ZodType<unknown>,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: () =>
      (async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      })(),
  }) as unknown as Tool

const callOf = (name: string, id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input: {},
})

const cfgOf = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

const actionOf = (t: Tool): AdmissibilityAction => ({
  tool: t.name,
  input: {},
  isReadOnly: t.isReadOnly(),
})

/** A recording base stream — proves the tee ALSO fans decisions to the
 *  underlying surface consumer (not just the tracer). */
const recordingStream = (): { port: StreamPort; events: AgentEvent[] } => {
  const events: AgentEvent[] = []
  return { port: { emit: (e) => void events.push(e) }, events }
}

/** Capture EVERY `process.stderr.write` chunk (the real tracer sink) into an
 *  array of non-empty lines; returns a restore fn. */
const captureRealStderr = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of the write overload set.
  ;(process.stderr as any).write = (chunk: any, ...rest: any[]): boolean => {
    const s = typeof chunk === "string" ? chunk : String(chunk)
    for (const piece of s.split("\n")) if (piece.length > 0) lines.push(piece)
    // Swallow — do NOT forward to the real terminal (keeps test output clean).
    // A callback may be present as the last arg; invoke it to satisfy the API.
    const cb = rest[rest.length - 1]
    if (typeof cb === "function") cb()
    return true
  }
  return {
    lines,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original write.
      ;(process.stderr as any).write = original
    },
  }
}

/** Build the feature config exactly the way the composition root does, then run
 *  it through the REAL production factory. Returns the factory output + a fresh
 *  base stream so callers can assert Object.is identity for the OFF path. */
const wireThroughGate = (
  quantaDebug: string | undefined,
  stderrIsTTY: boolean,
): {
  base: StreamPort
  baseEvents: AgentEvent[]
  featureCfg: CliFeatureConfig
  out: ReturnType<typeof buildDebugTracerAndStream>
} => {
  const { port: base, events: baseEvents } = recordingStream()
  const env = { ...(quantaDebug !== undefined ? { QUANTA_DEBUG: quantaDebug } : {}) }
  // stdoutIsTTY irrelevant to the debug gate; stderrIsTTY is the one that gates.
  const featureCfg = readCliFeatureConfig(env as NodeJS.ProcessEnv, false, stderrIsTTY)
  const out = buildDebugTracerAndStream(featureCfg, base)
  return { base, baseEvents, featureCfg, out }
}

// ─── suite ────────────────────────────────────────────────────────────────

describe("DOF-21 — debug-tracer decision-event through the QUANTA_DEBUG gated wire", () => {
  let restoreStderr: (() => void) | undefined
  afterEach(() => {
    restoreStderr?.()
    restoreStderr = undefined
  })

  // ── PROOF: gate ON ⇒ real decision event reaches the tracer sink ─────────
  test("gate ON: QUANTA_DEBUG=1 + TTY ⇒ a real admissibility decision writes a `decision` line to stderr", async () => {
    // Gate says ON.
    const { out, baseEvents, featureCfg } = wireThroughGate("1", true)
    expect(featureCfg.debugTracer.enabled).toBe(true)
    // Factory allocated a tee (the returned stream is NOT the base object) + a
    // live debugHandle.
    expect(out.debugHandle).toBeDefined()

    const cap = captureRealStderr()
    restoreStderr = cap.restore

    // Run the REAL gate; emit decisions through the FACTORY-RETURNED stream.
    const read = makeReadTool()
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(out.stream),
    })
    const res = await runAdmissibilityGate(
      callOf("read", "tc_gate_on"),
      cfg,
      cfg.permission,
      actionOf(read),
    )

    cap.restore()
    restoreStderr = undefined

    // Gate admitted the read-only tool.
    expect(res).toBe(null)

    // OBSERVABLE EFFECT — a `decision` line hit the REAL stderr sink through the
    // gated tracer wire.
    const decisionLines = cap.lines.filter((l) => l.includes("decision"))
    expect(decisionLines.length).toBe(1)
    const ln = decisionLines[0] ?? ""
    expect(ln).toContain("permission=allow")
    expect(ln).toContain("tc_gate_on")

    // Fan-out witness — the base surface consumer ALSO saw the decision (the tee
    // did not steal the event from the underlying stream).
    const baseDecisions = baseEvents.filter((e) => e.type === "decision")
    expect(baseDecisions.length).toBe(1)
    expect(baseDecisions[0]).toMatchObject({ toolCallId: "tc_gate_on", outcome: "allow" })
  })

  // ── PAIRED CONTROL: gate OFF ⇒ NO tracer line, literal passthrough ───────
  test("gate OFF (paired control): QUANTA_DEBUG unset ⇒ literal-stream passthrough, ZERO decision lines on stderr", async () => {
    const { out, base, baseEvents, featureCfg } = wireThroughGate(undefined, true)
    // RED-on-regression anchor: gate resolved to disabled.
    expect(featureCfg.debugTracer.enabled).toBe(false)
    // BYTE-IDENTITY: the factory returned the SAME stream object + no handle.
    expect(Object.is(out.stream, base)).toBe(true)
    expect(out.debugHandle).toBeUndefined()

    const cap = captureRealStderr()
    restoreStderr = cap.restore

    const read = makeReadTool()
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(out.stream),
    })
    const res = await runAdmissibilityGate(
      callOf("read", "tc_gate_off"),
      cfg,
      cfg.permission,
      actionOf(read),
    )

    cap.restore()
    restoreStderr = undefined

    expect(res).toBe(null)
    // The decision STILL flowed to the base consumer (behaviour of the gate is
    // unchanged) — proving the event was genuinely produced...
    expect(baseEvents.filter((e) => e.type === "decision").length).toBe(1)
    // ...but ZERO tracer lines hit stderr because the gate withheld the tee.
    // This is the assertion that goes RED if the gate stopped mattering.
    expect(cap.lines.filter((l) => l.includes("decision"))).toHaveLength(0)
    expect(cap.lines).toHaveLength(0)
  })

  // ── PAIRED CONTROL 2: non-TTY ⇒ gate refuses even with QUANTA_DEBUG=1 ────
  test("non-TTY control: QUANTA_DEBUG=1 but stderr not a TTY ⇒ disabled ⇒ literal passthrough, zero lines", async () => {
    const { out, base, baseEvents, featureCfg } = wireThroughGate("1", /* stderrIsTTY */ false)
    expect(featureCfg.debugTracer.enabled).toBe(false)
    expect(Object.is(out.stream, base)).toBe(true)

    const cap = captureRealStderr()
    restoreStderr = cap.restore
    const read = makeReadTool()
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(out.stream),
    })
    await runAdmissibilityGate(callOf("read", "tc_nontty"), cfg, cfg.permission, actionOf(read))
    cap.restore()
    restoreStderr = undefined

    expect(baseEvents.filter((e) => e.type === "decision").length).toBe(1)
    expect(cap.lines.filter((l) => l.includes("decision"))).toHaveLength(0)
  })

  // ── EDGE: category filter from env narrows the SAME wire ─────────────────
  // `QUANTA_DEBUG=tools` enables the tracer but with categories={tools}; a
  // decision event (category "decisions") must be DROPPED by the same gated
  // wire — proving the env-derived category set threads through the factory,
  // not just a blanket on/off. (This is the production parse path — the gate's
  // categories field is read straight off `parseDebugEnv`.)
  test("edge: QUANTA_DEBUG=tools ⇒ tracer enabled but decision events filtered out (zero decision lines)", async () => {
    const { out, featureCfg } = wireThroughGate("tools", true)
    // Enabled, but the category set excludes "decisions".
    expect(featureCfg.debugTracer.enabled).toBe(true)
    expect(featureCfg.debugTracer.categories?.has("tools")).toBe(true)
    expect(featureCfg.debugTracer.categories?.has("decisions")).toBe(false)
    expect(out.debugHandle).toBeDefined()

    const cap = captureRealStderr()
    restoreStderr = cap.restore
    const read = makeReadTool()
    const cfg = cfgOf({
      registry: new ToolRegistry([read]),
      decisionEmitter: decisionEmitterFromStream(out.stream),
    })
    await runAdmissibilityGate(callOf("read", "tc_cat"), cfg, cfg.permission, actionOf(read))
    cap.restore()
    restoreStderr = undefined

    // Tracer ran but DROPPED the decision (wrong category) ⇒ zero decision lines.
    expect(cap.lines.filter((l) => l.includes("decision"))).toHaveLength(0)
  })
})
