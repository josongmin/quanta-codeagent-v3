import { describe, expect, test } from "bun:test"
import { runAgent, wireOptionalAgentPorts } from "@/agent"
import type { AgentConfig } from "@/agent"
import type { StreamEvent } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent } from "@/stream"
import type { Tool, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { z } from "zod"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the item-lifecycle stream (gap-other-agent GAP 10),
 * driven by a FAKE LLM through the REAL agent loop (`runAgent`).
 *
 * What was ALREADY proven, and what was NOT:
 *   · item-lifecycle-hellgate     — the PURE tracker in isolation (fuzz/unit).
 *   · item-lifecycle-wire-hellgate — the wire, but by MANUALLY calling
 *     `out.stream.emit(toolCall)` with a hand-built event. No real loop.
 *
 * UNVERIFIED before this file: that a REAL `runAgent` turn — model streams
 * text, then calls a tool, then a tool_result comes back, then a turn boundary —
 * feeds the projector the loop's ACTUAL events in the loop's ACTUAL order, so
 * the derived `item_started`/`item_completed` pairs land INTERLEAVED with the
 * real `turn_start`/`assistant_text`/`tool_call`/`tool_result`/`done` events.
 *
 * The seam under test is the composition wire (`wireOptionalAgentPorts` with
 * `QUANTA_ITEM_LIFECYCLE=1`) decorating `config.stream`, then that decorated
 * config handed to `runAgent`. The RecordingStream is the SOURCE stream the
 * decorator emits onto (real event first, then its derived lifecycle events),
 * so it captures the real, in-order, interleaved trace the loop produced.
 *
 * Non-vacuity:
 *   · CONTROL (knob OFF) ⇒ stream returned UNWRAPPED; the identical run emits
 *     ZERO `item_*` events and a byte-identical (item-free) event trace.
 *   · RED-ON-INJECTION ⇒ see the block comment on that test: neutering the
 *     decorator or the tracker makes the pairs vanish and this suite goes RED.
 */

const PROBE_TOOL = "lifecycle_probe"

/** A trivial deterministic read-only tool so the loop produces a guaranteed
 *  `tool_call` → `tool_result` pair with a known id — no filesystem / network. */
const probeTool = (): Tool => ({
  name: PROBE_TOOL,
  description: "deterministic probe for the item-lifecycle e2e",
  inputSchema: z.object({ q: z.string() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // eslint-disable-next-line require-yield
  async *execute(input: { q: string }): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: `probed:${input.q}` } }
  },
})

const registryWithProbe = (): ToolRegistry => new ToolRegistry([...defaultTools, probeTool()])

/** One assistant turn that STREAMS text, THEN issues a single tool call — so the
 *  loop emits `assistant_text` (→ a text item) BEFORE `tool_call` (→ a tool
 *  item), exercising the projector's text-close-on-tool-open transition. */
const textThenToolCall = (id: string, prose: string, q: string): StreamEvent[] => [
  { type: "text_delta", delta: prose },
  { type: "tool_use_start", id, name: PROBE_TOOL },
  { type: "tool_use_end", id, input: { q } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** A finishing assistant turn (streamed text, end_turn). */
const finalText = (prose: string): StreamEvent[] => [
  { type: "text_delta", delta: prose },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Minimal one-script-per-call fake LLM (records nothing extra). */
class ScriptLLM {
  readonly model = "item-lifecycle-e2e"
  private readonly turns: StreamEvent[][]
  constructor(turns: StreamEvent[][]) {
    this.turns = turns
  }
  async *stream(): AsyncIterable<StreamEvent> {
    const next = this.turns.shift() ?? finalText("done")
    for (const e of next) yield e
  }
}

const TOOL_ID = "probe-1"

/** The scripted conversation shared by the ON and OFF runs (identical input, so
 *  the ONLY difference between the two traces is the lifecycle decoration). */
const scriptedLLM = (): ScriptLLM =>
  new ScriptLLM([
    textThenToolCall(TOOL_ID, "let me probe first", "hello"),
    finalText("all done"),
  ])

const baseCfg = (llm: ScriptLLM, stream: RecordingStream): AgentConfig =>
  cfg({
    llm: llm as unknown as AgentConfig["llm"],
    stream,
    registry: registryWithProbe(),
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    maxTurns: 6,
  })

const types = (evs: readonly AgentEvent[]): AgentEvent["type"][] => evs.map((e) => e.type)
const indicesOf = (evs: readonly AgentEvent[], t: AgentEvent["type"]): number[] =>
  evs.flatMap((e, i) => (e.type === t ? [i] : []))

const runWired = async (
  env: Record<string, string | undefined>,
  label: string,
): Promise<RecordingStream> => {
  const stream = new RecordingStream()
  const wired = wireOptionalAgentPorts(baseCfg(scriptedLLM(), stream), env)
  const out = await withTimeout(runAgent(wired), 15_000, label)
  expect(out.reason).toBe("completed")
  return stream
}

describe("item-lifecycle stream — real loop + fake LLM end-to-end (GAP 10)", () => {
  test("knob ON ⇒ projector sees the REAL loop events in real order, emitting 1:1 item pairs interleaved", async () => {
    const stream = await runWired({ QUANTA_ITEM_LIFECYCLE: "1" }, "item-lifecycle-on")
    const evs = stream.events

    // (0) The wire actually decorated the stream: item_* events are present at all.
    const started = evs.filter((e) => e.type === "item_started")
    const completed = evs.filter((e) => e.type === "item_completed")
    expect(started.length).toBeGreaterThanOrEqual(2) // ≥ one text item + one tool item
    // Sanity: the real loop events the projector is supposed to be fed all landed.
    expect(types(evs)).toContain("turn_start")
    expect(types(evs)).toContain("assistant_text")
    expect(types(evs)).toContain("tool_call")
    expect(types(evs)).toContain("tool_result")
    expect(types(evs)).toContain("done")

    // (1) 1:1 PAIRING — every started item has exactly one completed item and
    //     vice-versa (by itemId). No orphan starts, no phantom completions.
    const startedIds = started.map((e) => (e.type === "item_started" ? e.itemId : ""))
    const completedIds = completed.map((e) => (e.type === "item_completed" ? e.itemId : ""))
    expect(completedIds.length).toBe(startedIds.length)
    for (const id of startedIds) {
      expect(completedIds.filter((c) => c === id)).toHaveLength(1)
    }
    for (const id of completedIds) {
      expect(startedIds.filter((s) => s === id)).toHaveLength(1)
    }

    // (2) The TOOL item is keyed by the real tool-call id, and its started/
    //     completed straddle the real tool_call / tool_result — the projector
    //     was fed the loop's ACTUAL ids in the loop's ACTUAL order.
    const toolStartedAt = evs.findIndex(
      (e) => e.type === "item_started" && e.itemKind === "tool" && e.itemId === TOOL_ID,
    )
    const toolCompletedAt = evs.findIndex(
      (e) => e.type === "item_completed" && e.itemId === TOOL_ID,
    )
    expect(toolStartedAt).toBeGreaterThanOrEqual(0)
    expect(toolCompletedAt).toBeGreaterThanOrEqual(0)

    const toolCallAt = evs.findIndex((e) => e.type === "tool_call")
    const toolResultAt = evs.findIndex((e) => e.type === "tool_result")

    // GROUND TRUTH ordering: the tool item's started immediately follows its
    // real tool_call, its completed immediately follows the real tool_result,
    // and started strictly precedes completed.
    expect(toolStartedAt).toBe(toolCallAt + 1)
    expect(toolCompletedAt).toBe(toolResultAt + 1)
    expect(toolStartedAt).toBeLessThan(toolCompletedAt)

    // (3) The tool item's started precedes its completed which precedes the
    //     NEXT turn boundary (turn_start after it, or the terminal done).
    const nextBoundaryAfterTool = evs.findIndex(
      (e, i) => i > toolCompletedAt && (e.type === "turn_start" || e.type === "done"),
    )
    expect(nextBoundaryAfterTool).toBeGreaterThan(toolCompletedAt)

    // (4) The TEXT item opened on the first real assistant_text and closed at/
    //     before the tool item opened (the model moved on to a tool call).
    const textStartedAt = evs.findIndex(
      (e) => e.type === "item_started" && e.itemKind === "text",
    )
    expect(textStartedAt).toBeGreaterThanOrEqual(0)
    const textItemId =
      evs[textStartedAt]?.type === "item_started" ? evs[textStartedAt].itemId : ""
    const textCompletedAt = evs.findIndex(
      (e) => e.type === "item_completed" && e.itemId === textItemId,
    )
    expect(textCompletedAt).toBeGreaterThan(textStartedAt)
    expect(textCompletedAt).toBeLessThanOrEqual(toolStartedAt)

    // (5) EVERY item_completed comes after its own item_started (no completion
    //     precedes its start across the whole real trace).
    for (const c of indicesOf(evs, "item_completed")) {
      const id = evs[c]?.type === "item_completed" ? evs[c].itemId : ""
      const s = evs.findIndex((e) => e.type === "item_started" && e.itemId === id)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(c)
    }
  })

  test("CONTROL (knob OFF): identical run ⇒ NO item_* events + item-free trace is byte-identical", async () => {
    // OFF run: the wire returns the stream UNWRAPPED (proven by the wire test);
    // here we prove the END-TO-END consequence — the real loop emits zero
    // lifecycle events, and the trace with lifecycle events stripped from the ON
    // run equals the OFF trace exactly (the decoration is purely additive).
    const offStream = await runWired({}, "item-lifecycle-off")
    const onStream = await runWired({ QUANTA_ITEM_LIFECYCLE: "1" }, "item-lifecycle-on-parity")

    const isItem = (e: AgentEvent): boolean =>
      e.type === "item_started" || e.type === "item_updated" || e.type === "item_completed"

    // OFF ⇒ no lifecycle events at all.
    expect(offStream.events.some(isItem)).toBe(false)

    // ON ⇒ lifecycle events ARE present (guards against a vacuous OFF==OFF pass).
    expect(onStream.events.some(isItem)).toBe(true)

    // Byte-identity of the underlying loop trace: strip the additive lifecycle
    // events from the ON run and it must equal the OFF run event-for-event.
    const onWithoutItems = onStream.events.filter((e) => !isItem(e))
    expect(JSON.stringify(onWithoutItems)).toBe(JSON.stringify(offStream.events))
  })
})

// RED-ON-INJECTION (manual proof, recorded — not asserted by CI):
//
//   Injection A — neuter the WIRE GATE (src/agent/optional-ports.ts,
//   `wireItemLifecycleStream`): make it `return base` unconditionally (drop the
//   `if (!itemLifecycleEnabled(env))` decoration). Then the knob-ON run emits no
//   lifecycle events ⇒ test 1 fails at "started.length >= 2" and test 2 fails at
//   "onStream ... some(isItem) === true".
//
//   Injection B — neuter the PROJECTOR (src/stream/item-lifecycle.ts,
//   `ItemLifecycleTracker.track`): make it `return []` for every event. Same
//   effect — the decorator wraps the stream but derives nothing ⇒ zero pairs.
//
//   Injection C — break ORDERING only: have `wireItemLifecycleStream.emit` emit
//   the derived events BEFORE `source.emit(event)`. Then test 1's
//   `toolStartedAt === toolCallAt + 1` / `toolCompletedAt === toolResultAt + 1`
//   invariants flip and go RED, while presence checks still pass — proving the
//   ORDER assertions are load-bearing, not just the count.

// Keep runtime-config hermetic across this file (the wire calls runtimeConfig()
// for the unrelated fast-apply-merge gate); reset so no ambient process.env knob
// bleeds in. Registered at module scope via bun's global hooks equivalent.
import { afterAll, beforeAll } from "bun:test"
beforeAll(() => __resetRuntimeConfig())
afterAll(() => __resetRuntimeConfig())
