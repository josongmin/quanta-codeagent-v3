/**
 * C2 last-mile (jun-6-progress-renderer.md) — ProgressSink producer wire hellgate.
 *
 * Pins the two pure halves of the missing producer leg in isolation (no LLM, no
 * dispatch loop):
 *
 *   1. `createProgressStreamSink` maps a snake_case `ProgressUpdateMirror` → a
 *      camelCase `progress_update` AgentEvent, conditionally spreading the
 *      optional terminal fields (no `undefined` keys under
 *      `exactOptionalPropertyTypes`), faithfully + deterministically.
 *   2. The sink is NO-THROW: a broken stream can never poison the caller.
 *   3. `maybeWireProgressSink` (via `assembleAgentConfig`) wires
 *      `cfg.progressSink` ONLY when `QUANTA_PROGRESS_UPDATE=1` — absent / "0" ⇒
 *      slot UNSET (default-OFF byte-identical), and a caller-pre-set sink is
 *      preserved (override precedence, ADR-0332).
 *   4. End-to-end: a `communicate_update` emit reaches `cfg.stream` as a
 *      `progress_update` AgentEvent with the correct camelCase fields; knob-off
 *      ⇒ the tool no-ops (no event).
 *
 * Mirror of `passive-vcs-bus-wire-hellgate.test.ts` (the proven pattern).
 */
import { describe, expect, test } from "bun:test"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { createProgressStreamSink, maybeWireProgressSink } from "@/host/runtime/progress-sink-wire"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import type { ToolContext, ToolEvent } from "@/tool"
import { createCommunicateUpdateTool } from "@/tool/communicate-update"

// ── stream double ─────────────────────────────────────────────────────────────

interface RecordingStream extends StreamPort {
  readonly events: AgentEvent[]
}
const recordingStream = (): RecordingStream => {
  const events: AgentEvent[] = []
  return { events, emit: (e) => void events.push(e) }
}

/** Narrow an emitted event to the `progress_update` shape for field assertions. */
const asProgress = (
  e: AgentEvent | undefined,
): { currentStep: string; finalSummary?: string; completedSubtitle?: string } => {
  if (e === undefined || e.type !== "progress_update") {
    throw new Error(`expected progress_update, got ${e?.type}`)
  }
  return e
}

/* ================================================================== */
/*  1. faithful, exactOptional-safe mirror → progress_update mapping  */
/* ================================================================== */

describe("createProgressStreamSink · ProgressUpdateMirror → progress_update AgentEvent", () => {
  test("HELL-ADP-step-only: current_step only ⇒ no finalSummary/completedSubtitle keys", () => {
    const s = recordingStream()
    createProgressStreamSink(s).emit({ current_step: "indexing repo" })
    expect(s.events).toHaveLength(1)
    const ev = s.events[0]
    expect(asProgress(ev).currentStep).toBe("indexing repo")
    // exactOptional discipline: absent fields must NOT appear as undefined keys.
    expect(Object.hasOwn(ev as object, "finalSummary")).toBe(false)
    expect(Object.hasOwn(ev as object, "completedSubtitle")).toBe(false)
    expect(Object.hasOwn(ev as object, "turn")).toBe(false)
  })

  test("HELL-ADP-subtitle: completed_subtitle maps to completedSubtitle (snake→camel)", () => {
    const s = recordingStream()
    createProgressStreamSink(s).emit({
      current_step: "running tests",
      completed_subtitle: "Ran the suite",
    })
    const ev = asProgress(s.events[0])
    expect(ev.currentStep).toBe("running tests")
    expect(ev.completedSubtitle).toBe("Ran the suite")
    expect(Object.hasOwn(s.events[0] as object, "finalSummary")).toBe(false)
  })

  test("HELL-ADP-all-fields: every field present maps snake→camel exactly", () => {
    const s = recordingStream()
    createProgressStreamSink(s).emit({
      current_step: "wrapping up",
      final_summary: "Closed the gap end-to-end.",
      completed_subtitle: "Wired the sink",
    })
    const ev = asProgress(s.events[0])
    expect(ev).toEqual({
      type: "progress_update",
      currentStep: "wrapping up",
      finalSummary: "Closed the gap end-to-end.",
      completedSubtitle: "Wired the sink",
    } as unknown as typeof ev)
  })

  test("HELL-ADP-deterministic: the SAME mirror always yields the SAME event", () => {
    const mirror = { current_step: "x", final_summary: "y", completed_subtitle: "z" } as const
    const a = recordingStream()
    const b = recordingStream()
    createProgressStreamSink(a).emit(mirror)
    createProgressStreamSink(b).emit(mirror)
    expect(a.events[0]).toEqual(b.events[0])
  })
})

/* ================================================================== */
/*  2. NO-THROW boundary                                              */
/* ================================================================== */

describe("createProgressStreamSink · NO-THROW boundary", () => {
  test("HELL-ADP-nothrow: a stream whose emit throws never propagates", () => {
    const throwing: StreamPort = {
      emit() {
        throw new Error("dead socket")
      },
    }
    const sink = createProgressStreamSink(throwing)
    expect(() => sink.emit({ current_step: "boom" })).not.toThrow()
  })
})

/* ================================================================== */
/*  3. assembler wires the sink ONLY when the knob is on              */
/* ================================================================== */

/** Minimal RuntimeAgentConfigBase the assembler needs. The assembler reads
 *  `cfg.stream` to build the sink; everything else is opaque to this slot. */
const baseConfig = (): RuntimeAgentConfigBase =>
  ({
    stream: recordingStream(),
    cwd: "/repo",
  }) as unknown as RuntimeAgentConfigBase

const assembleWith = (env: AssemblerEnv) =>
  assembleAgentConfig({ mode: "interactive", base: baseConfig() }, env)

describe("maybeWireProgressSink · gate (the host helper, mirror of maybeWireVcsEventSink)", () => {
  // These exercise the wire helper DIRECTLY on an assembled cfg. The final
  // `assembleAgentConfig`-routed assertion (knob-on ⇒ cfg.progressSink set
  // automatically) requires the ONE-LINE call-site insertion in the SHARED
  // `agent-config-assembler.ts wireOptionalCapabilitySlots` (REPORTED, not
  // edited here) — see `HELL-WIRE-assembler-routed` below.

  test("HELL-WIRE-on: QUANTA_PROGRESS_UPDATE=1 wires a sink bound to cfg.stream", () => {
    const cfg = assembleWith({}) // assembler does not yet auto-wire (call-site reported)
    maybeWireProgressSink(cfg, { QUANTA_PROGRESS_UPDATE: "1" })
    expect(cfg.progressSink).toBeDefined()
    cfg.progressSink?.emit({ current_step: "step a" })
    const stream = cfg.stream as RecordingStream
    const updates = stream.events.filter((e) => e.type === "progress_update")
    expect(updates).toHaveLength(1)
    expect(asProgress(updates[0]).currentStep).toBe("step a")
  })

  test("HELL-WIRE-off-absent: knob ABSENT ⇒ slot UNSET (default-OFF byte-identical)", () => {
    const cfg = assembleWith({})
    maybeWireProgressSink(cfg, {})
    expect(cfg.progressSink).toBeUndefined()
  })

  test("HELL-WIRE-off-zero: knob='0' ⇒ slot UNSET (strict opt-in)", () => {
    const cfg = assembleWith({})
    maybeWireProgressSink(cfg, { QUANTA_PROGRESS_UPDATE: "0" })
    expect(cfg.progressSink).toBeUndefined()
  })

  test("HELL-WIRE-override: a caller-pre-set sink is PRESERVED (override precedence)", () => {
    const cfg = assembleWith({})
    const calls: unknown[] = []
    cfg.progressSink = { emit: (u) => void calls.push(u) }
    maybeWireProgressSink(cfg, { QUANTA_PROGRESS_UPDATE: "1" })
    cfg.progressSink?.emit({ current_step: "via caller" })
    expect(calls).toHaveLength(1) // caller sink, not the adapter
  })

  // GREEN now that `maybeWireProgressSink` is called in
  // `wireOptionalCapabilitySlots` (mirror of `maybeWireVcsEventSink`).
  test("HELL-WIRE-assembler-routed: assembleAgentConfig auto-wires cfg.progressSink under the knob (reported call-site landed)", () => {
    const cfg = assembleWith({ QUANTA_PROGRESS_UPDATE: "1" })
    expect(cfg.progressSink).toBeDefined()
  })

  test("HELL-WIRE-assembler-off: assembleAgentConfig leaves cfg.progressSink unset when the knob is absent (default-OFF byte-identical)", () => {
    const cfg = assembleWith({})
    expect(cfg.progressSink).toBeUndefined()
  })
})

/* ================================================================== */
/*  4. end-to-end: communicate_update → sink → stream (gap closed)    */
/* ================================================================== */

/** A ToolContext carrying ONLY the progressSink slot the tool reads. */
const ctxWith = (sink: { emit(u: ProgressUpdateMirrorLike): void } | undefined): ToolContext =>
  ({ ...(sink !== undefined ? { progressSink: sink } : {}) }) as unknown as ToolContext

interface ProgressUpdateMirrorLike {
  current_step: string
  final_summary?: string
  completed_subtitle?: string
}

const drainTool = async (
  ctx: ToolContext,
  input: ProgressUpdateMirrorLike,
): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  const tool = createCommunicateUpdateTool()
  for await (const e of tool.execute(input as never, ctx)) out.push(e)
  return out
}

describe("communicate_update → progressSink → stream (the producer→renderer chain)", () => {
  test("HELL-E2E-knob-on: wired sink ⇒ a tool call reaches cfg.stream as progress_update", async () => {
    const stream = recordingStream()
    const sink = createProgressStreamSink(stream)
    const ctx = ctxWith(sink)
    const events = await drainTool(ctx, {
      current_step: "phase 1",
      completed_subtitle: "Did phase 1",
    })
    // tool still acks ok:true …
    expect(events.some((e) => e.type === "result")).toBe(true)
    // … AND the producer reached the stream the renderers ride.
    expect(stream.events).toHaveLength(1)
    const ev = asProgress(stream.events[0])
    expect(ev.currentStep).toBe("phase 1")
    expect(ev.completedSubtitle).toBe("Did phase 1")
  })

  test("HELL-E2E-knob-off: undefined sink ⇒ tool no-ops, NO progress_update emitted (byte-identical)", async () => {
    const stream = recordingStream()
    const ctx = ctxWith(undefined) // ctx.progressSink === undefined (knob-off shape)
    const events = await drainTool(ctx, { current_step: "phase 1" })
    expect(events.some((e) => e.type === "result")).toBe(true) // ok:true preserved
    expect(stream.events).toHaveLength(0) // nothing reached the stream
  })
})
