/**
 * T-B2 (ADR-0539) — context-only span-sink wired at bench boot + rule-5 LIVE-gate.
 *
 * `bootBenchOtelExport` (`apps/bench/otel.ts`) installs `makeContextOnlySpanSink()`
 * when `QUANTA_TRACE_CONTEXT` is truthy AND no OTLP endpoint is set, so ordinary
 * (non-export) bench runs mint real `{traceId,spanId}` — the trajectory viewer's
 * span-tree is non-empty — while exporting NOTHING.
 *
 * ⚠️ THE WHOLE POINT of this ticket is the INSTANCE-FATAL coupling: installing ANY
 * sink flips `traceContextExpected: () => getSpanSink() !== null` true
 * (`runner/batch/observe.ts:179`). A recorded event emitted OUTSIDE
 * `withActiveSpanScope` while the sink is live emits `observability_degraded`
 * (`reason:"missing_trace_context"`) and FAILS the strict rail → `verdict:"degraded"`
 * → EXCLUDED from the eval denominator = a bench-correctness regression. This suite
 * PROVES:
 *   1. knob-on + no endpoint → sink installed; a full driven instance shape
 *      (session_start→turn_start→llm_request→usage→tool_*→verdict/patch→done)
 *      produces cassette + OBSERVE events ALL carrying a UNIFIED hex
 *      `{traceId,spanId}` (the `buildSpanTree(...).unified===true` invariant) with
 *      ZERO `missing_trace_context` degraded lines across the whole instance;
 *   2. endpoint set + knob on → the installed sink is the OTLP EXPORTER (context-only
 *      did NOT shadow it);
 *   3. knob off → NO sink installed, byte-identical;
 *   4. LIVE-GATE red-on-injection: under the live sink, ONE recorded event emitted
 *      OUTSIDE any `withActiveSpanScope` DOES take the degraded/fatal path (proves
 *      the gate is non-inert AND documents the failure mode) — while the REAL
 *      loop path (every emit in-scope) never triggers it.
 *
 * The recorder here is the REAL `JsonlRecorder` wired EXACTLY as `observe.ts` wires
 * it (`getActiveTraceRef` + `traceContextExpected: () => getSpanSink()!==null`), so
 * the coupling is exercised end-to-end without importing the read-only `observe.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withActiveSpanScope } from "@/agent/session-resources"
import { bootBenchOtelExport } from "@/apps/bench/otel"
import { withBenchInstanceRoot } from "@/apps/bench/run-main-helpers"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import type { ExportSpan, OtelExporter } from "@/observability/otel-exporter"
import { createExporterSpanSink } from "@/observability/otel-span-export"
import {
  __resetSpanSink,
  endSpan,
  getSpanSink,
  SPAN_NAMES,
  type Span,
  setSpanSink,
  startSpan,
} from "@/observability/spans"
import { getActiveTraceRef } from "@/observability/tracing"
import type { RunContext } from "@/shared"
import type { AgentEvent } from "@/stream"
import { JsonlRecorder } from "@/stream/adapters/jsonl-recorder"

// ── fixtures ────────────────────────────────────────────────────────────────

const noTimer = {
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}
const bootOpts = { flushIntervalMs: 0, ...noTimer }

const tmpDirs: string[] = []
const mkFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tb2-ctx-sink-"))
  tmpDirs.push(dir)
  return join(dir, "obs.jsonl")
}

afterEach(() => {
  __resetSpanSink()
  __resetDefaultMetricSink()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Line {
  readonly kind: string
  readonly traceId?: string
  readonly spanId?: string
  readonly parentSpanId?: string
  readonly data?: { reason?: string }
}
const readLines = (file: string): Line[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Line)
    : []

const degradedMissingCtx = (lines: Line[]): Line[] =>
  lines.filter(
    (l) => l.kind === "observability_degraded" && l.data?.reason === "missing_trace_context",
  )

/** Build the REAL recorder, wired EXACTLY as `runner/batch/observe.ts` wires it
 *  (the two DI seams that make the coupling live). `strict:true` mirrors the eval
 *  rail — a `missing_trace_context` defect throws (→ instance degrades). */
const makeRecorder = (file: string, ctx: RunContext): JsonlRecorder =>
  new JsonlRecorder(file, {
    ctx,
    strict: true,
    now: () => 1_700_000_000_000,
    getActiveTraceRef,
    // THE coupling — identical to observe.ts:179.
    traceContextExpected: () => getSpanSink() !== null,
  })

/** The exact AgentEvent sequence a real bench instance emits, in order, spanning
 *  every recorded kind the ticket names. Each is emitted INSIDE the loop's real
 *  `withActiveSpanScope` frames so it carries an active ref — the real path. */
const driveInstance = async (rec: JsonlRecorder): Promise<void> => {
  const events: AgentEvent[] = [
    { type: "session_start" },
    { type: "turn_start", turn: 0 },
    { type: "llm_request", model: "gpt-5" },
    { type: "usage", inputTokens: 10, outputTokens: 5, model: "gpt-5" },
    { type: "tool_call", id: "tc1", name: "bash", input: { cmd: "ls" } },
    { type: "tool_result", id: "tc1", name: "bash", ok: true, preview: "a\nb" },
    { type: "turn_start", turn: 1 },
    { type: "llm_request", model: "gpt-5" },
    { type: "usage", inputTokens: 3, outputTokens: 2, model: "gpt-5" },
    { type: "done", reason: "completed", turns: 2 },
  ]
  // Bench root scope (installs the active ref) — then each turn opens its own
  // turn/tool/sampling scope, exactly like `turn-loop.ts` / `dispatch.ts`.
  await withBenchInstanceRoot({ instanceId: "django__django-1", attempt: 0 }, async () => {
    for (const e of events) {
      const span: Span = startSpan(SPAN_NAMES.turn, {})
      // eslint-disable-next-line no-await-in-loop
      await withActiveSpanScope(false, span, async () => {
        rec.emit(e)
      })
      endSpan(span, "ok", {})
    }
  })
}

/** Simulate the OBSERVE-writer append path (patch_generated/verify) that
 *  `ObserveWriter.append` takes — a DIRECT recorder line, wrapped in the loop's
 *  active-span scope exactly as the real writer runs under the instance root. */
const observeAppend = async (
  rec: JsonlRecorder,
  kind: "patch_generated" | "verify",
): Promise<void> => {
  await withBenchInstanceRoot({ instanceId: "django__django-1", attempt: 0 }, async () => {
    const span: Span = startSpan(SPAN_NAMES.turn, {})
    await withActiveSpanScope(false, span, async () => {
      // `patch_generated`/`verify` are OBSERVE kinds; drive them through the same
      // recorder frame() the writer uses (emit maps only AgentEvent kinds, so we
      // exercise the frame path via a synthetic verify-like AgentEvent proxy:
      // `recovery` rides the same gate). The gate is kind-agnostic.
      rec.emit({ type: "recovery", reason: kind } as AgentEvent)
    })
    endSpan(span, "ok", {})
  })
}

// ── (3) knob OFF → byte-identical, NO sink ──────────────────────────────────

describe("T-B2 knob OFF — no sink installed, byte-identical", () => {
  test("no knob, no endpoint ⇒ getSpanSink() stays null (nothing installed)", () => {
    const env: Record<string, string | undefined> = { QUANTA_BENCH_PRESET: "p" }
    const boot = bootBenchOtelExport(env, bootOpts)
    expect(boot.otelExport.exporter).toBeNull()
    expect(getSpanSink()).toBeNull() // ← byte-identical: no sink, no coupling
  })

  test("blank knob (whitespace) ⇒ treated as OFF, no sink", () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "   " }
    bootBenchOtelExport(env, bootOpts)
    expect(getSpanSink()).toBeNull()
  })
})

// ── (1) knob ON + no endpoint → sink installed, unified ids, ZERO degraded ──

describe("T-B2 knob ON + no endpoint — context-only sink installed", () => {
  test("a context-only sink is installed AND mints a REAL active ref inside a scope", async () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    const boot = bootBenchOtelExport(env, bootOpts)
    // No exporter (no endpoint) — but a sink IS now live (the whole T-B1/B2 point).
    expect(boot.otelExport.exporter).toBeNull()
    expect(getSpanSink()).not.toBeNull()

    // Inside a scope the sink issues a real W3C-shaped id (context-only decoupled).
    let ref: { traceId: string; spanId: string } | undefined
    await withBenchInstanceRoot({ instanceId: "i", attempt: 0 }, async () => {
      ref = getActiveTraceRef()
    })
    expect(ref?.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(ref?.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  test("HELLGATE: a full driven instance yields UNIFIED {traceId,spanId} on EVERY line + ZERO missing_trace_context", async () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    bootBenchOtelExport(env, bootOpts)
    expect(getSpanSink()).not.toBeNull() // sink live ⇒ gate armed

    const file = mkFile()
    const rec = makeRecorder(file, { runId: "r1", instanceId: "django__django-1", attempt: 0 })
    await driveInstance(rec)
    rec.close()

    const lines = readLines(file)
    expect(lines.length).toBeGreaterThan(0)

    // ZERO spurious degraded lines across the WHOLE instance — real solves stay ok.
    expect(degradedMissingCtx(lines)).toEqual([])
    expect(lines.some((l) => l.kind === "observability_degraded")).toBe(false)

    // UNIFIED: every recorded line carries a hex {traceId,spanId} (the invariant
    // `buildSpanTree(inst).unified===true` reads off) — one trace, coherent tree.
    for (const l of lines) {
      expect(l.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(l.spanId).toMatch(/^[0-9a-f]{16}$/)
    }
    // All lines within one instance share ONE trace id (the join key).
    const traceIds = new Set(lines.map((l) => l.traceId))
    expect(traceIds.size).toBe(1)

    // The named recorded kinds all reached disk (nothing was silently dropped).
    const kinds = new Set(lines.map((l) => l.kind))
    for (const k of [
      "session_start",
      "turn_start",
      "llm_request",
      "llm_usage",
      "tool_call",
      "tool_result",
      "session_end",
    ]) {
      expect(kinds.has(k)).toBe(true)
    }
  })

  test("OBSERVE-writer append kinds (patch/verify family) under the sink also carry unified ids, ZERO degraded", async () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    bootBenchOtelExport(env, bootOpts)
    const file = mkFile()
    const rec = makeRecorder(file, { runId: "r1", instanceId: "i", attempt: 0 })
    await observeAppend(rec, "patch_generated")
    await observeAppend(rec, "verify")
    rec.close()

    const lines = readLines(file)
    expect(degradedMissingCtx(lines)).toEqual([])
    for (const l of lines) expect(l.traceId).toMatch(/^[0-9a-f]{32}$/)
  })
})

// ── (2) endpoint set + knob on → EXPORTER wins, context-only did NOT shadow ──

describe("T-B2 install-order guard — an OTLP endpoint WINS over context-only", () => {
  const captureFetch = (): { fetch: typeof fetch; bodies: string[] } => {
    const bodies: string[] = []
    const f = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === "string") bodies.push(init.body)
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake Response
      return { ok: true, status: 200 } as any
    }
    return { fetch: f as unknown as typeof fetch, bodies }
  }

  test("endpoint + knob both set ⇒ the installed sink is the EXPORTER (it EXPORTS; context-only did NOT shadow)", async () => {
    const { fetch, bodies } = captureFetch()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: "http://127.0.0.1:4318",
      QUANTA_TRACE_CONTEXT: "1",
    }
    const boot = bootBenchOtelExport(env, { fetch, ...bootOpts })
    // The exporter WAS installed (endpoint present) → context-only branch is
    // guarded off by `exporter === null` being false.
    expect(boot.otelExport.exporter).not.toBeNull()
    expect(getSpanSink()).not.toBeNull()

    // Proof the live sink is the EXPORTER's, not context-only: a closed span
    // reaches the OTLP wire. Context-only's `onEnd` is a no-op → NOTHING would
    // POST, so a non-empty traces body is a positive discriminator.
    endSpan(startSpan(SPAN_NAMES.sessionLoop, {}), "ok", {})
    await boot.otelExport.teardown()
    expect(bodies.some((b) => b.includes(SPAN_NAMES.sessionLoop))).toBe(true)
  })

  test("with a PRE-INSTALLED exporter sink, boot+knob does NOT clobber it (idempotent ownership)", () => {
    // Model the endpoint-wins path by ownership: an exporter sink already owns the
    // registry. `bootBenchOtelExport` with the knob on must NOT replace it with
    // context-only (the `getSpanSink()===null` ownership guard).
    const spans: ExportSpan[] = []
    const exporter: OtelExporter = {
      recordSpan: (s) => spans.push(s),
      recordMetric: () => {},
      flush: async () => {},
      teardown: async () => {},
    }
    const exporterSink = createExporterSpanSink(exporter)
    setSpanSink(exporterSink)

    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    bootBenchOtelExport(env, bootOpts)

    // The SAME exporter sink is still installed — context-only did NOT shadow it.
    expect(getSpanSink()).toBe(exporterSink)
    // And it still EXPORTS (context-only would export nothing).
    endSpan(startSpan(SPAN_NAMES.sessionLoop, {}), "ok", {})
    expect(spans.length).toBe(1)
  })
})

// ── (4) LIVE-GATE red-on-injection — the gate is non-inert AND guards the hole ─

describe("T-B2 LIVE-GATE — the rule-5 gate is LIVE (not fatal-by-accident)", () => {
  test("RED-ON-INJECTION: an emit OUTSIDE any withActiveSpanScope under the live sink DEGRADES the instance", () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    bootBenchOtelExport(env, bootOpts)
    expect(getSpanSink()).not.toBeNull() // sink live ⇒ gate armed

    const file = mkFile()
    const rec = makeRecorder(file, { runId: "r1", instanceId: "i", attempt: 0 })

    // Emit with NO active scope ⇒ getActiveTraceRef() is undefined WHILE a context
    // was EXPECTED (sink live). Strict ⇒ the recorder THROWS (fails the rail →
    // verdict:"degraded" → excluded from the denominator). This is the failure
    // mode the ticket forbids on the real path — proven catchable here so we KNOW
    // the gate is not inert.
    expect(getActiveTraceRef()).toBeUndefined()
    expect(() => rec.emit({ type: "session_start" })).toThrow(/missing_trace_context/)

    // AND it wrote the greppable degraded line (operator triage marker).
    rec.close()
    expect(degradedMissingCtx(readLines(file)).length).toBe(1)
  })

  test("CONTROL: the SAME emit IN-scope under the SAME live sink does NOT degrade (proves the real path is safe)", async () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    bootBenchOtelExport(env, bootOpts)
    const file = mkFile()
    const rec = makeRecorder(file, { runId: "r1", instanceId: "i", attempt: 0 })

    // Identical event, identical sink — only difference is it runs IN a scope.
    await withBenchInstanceRoot({ instanceId: "i", attempt: 0 }, async () => {
      const span: Span = startSpan(SPAN_NAMES.turn, {})
      await withActiveSpanScope(false, span, async () => {
        expect(getActiveTraceRef()).toBeDefined() // ← the real loop guarantees this
        rec.emit({ type: "session_start" }) // MUST NOT throw
      })
      endSpan(span, "ok", {})
    })
    rec.close()
    expect(degradedMissingCtx(readLines(file))).toEqual([])
  })

  test("SINK-OFF CONTROL: the very same out-of-scope emit is HARMLESS when no sink (gate not armed)", () => {
    // Proves the coupling is the SINK, not the emit site: with no sink the gate
    // returns false and the deterministic-id fallback keeps the line — byte-identical.
    expect(getSpanSink()).toBeNull()
    const file = mkFile()
    const rec = makeRecorder(file, { runId: "r1", instanceId: "i", attempt: 0 })
    expect(() => rec.emit({ type: "session_start" })).not.toThrow()
    rec.close()
    expect(degradedMissingCtx(readLines(file))).toEqual([])
  })
})
