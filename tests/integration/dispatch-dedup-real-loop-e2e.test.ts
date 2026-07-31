import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import { DedupGate } from "@/agent/dispatch-dedup"
import type { Message, StreamEvent, StreamInput } from "@/llm"
import type { Tool, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the T3 pre-flight DEDUP GATE (`DedupGate`), driven by a
 * FAKE LLM through the REAL agent loop (`runAgent`).
 *
 * The unit tests (`dispatch-dedup.test.ts` / `dedup.test.ts`) exercise
 * `DedupGate.record` in ISOLATION with hand-fed turn numbers. ZERO test drives
 * the gate through `runAgent`, so a misfire is invisible:
 *   · blocking a legitimate DIFFERENT-args retry (false positive), or
 *   · failing to block a true cross-turn duplicate (false negative)
 * would both pass the isolation suite.
 *
 * This drives the gate via the loop's REAL per-turn `run.turn` stamping (the
 * loop sets `cfg.run = {turn}` each turn — the gate's ONLY turn source). We
 * assert:
 *   1. A duplicate (same tool + same canonical args) issued across SEPARATE
 *      turns is BLOCKED — the tool's real `execute()` is NOT reached for the
 *      blocked call, and the synthetic `[dedup-gate]` observation reaches the
 *      NEXT turn's LLM input `messages`.
 *   2. PAIRED CONTROL (non-vacuous): the SAME tool with DIFFERENT args across
 *      turns is NOT blocked — every call executes, no `[dedup-gate]` appears.
 */

const PROBE = "dedup_probe"
const DEDUP_MARK = "[dedup-gate]"

/** A read-only test tool (stays in the gate's `general` regime — bucket keyed
 *  on `<name> <canonical-args>`) that counts how many times its `execute()`
 *  actually RAN. A blocked call short-circuits pre-flight and never runs, so
 *  the counter is the ground truth for "did the dispatch reach execute?". */
const probeTool = (counter: { runs: string[] }): Tool => ({
  name: PROBE,
  description: "read-only probe that records each real execution",
  inputSchema: z.object({ q: z.string() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: { q: string }): AsyncIterable<ToolEvent> {
    counter.runs.push(input.q)
    yield { type: "result", result: { ok: true, output: `probe(${input.q})` } }
  },
})

const probeCall = (id: string, q: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: PROBE },
  { type: "tool_use_end", id, input: { q } },
  { type: "message_stop", stop_reason: "tool_use" },
]

class CapturingLLM {
  readonly model = "dedup-e2e"
  readonly seenMessages: Message[][] = []
  private readonly turns: StreamEvent[][]
  constructor(turns: StreamEvent[][]) {
    this.turns = turns
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages)
    const next = this.turns.shift() ?? text("done")
    for (const e of next) yield e
  }
}

const allToolResultText = (seen: Message[][]): string =>
  seen
    .flat()
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
    .join("\n")

describe("dispatch-dedup — real loop + fake LLM end-to-end (T3 verify-loop stuck brake)", () => {
  test("SAME (tool,args) across turns ⇒ 2nd call BLOCKED, execute NOT reached, [dedup-gate] reaches next turn", async () => {
    // Tight cap so the SECOND distinct-turn identical call trips the brake.
    const gate = new DedupGate({ generalWindow: 8, generalThreshold: 2 })
    const counter = { runs: [] as string[] }
    // Turn 1: probe(dup). Turn 2: probe(dup) — IDENTICAL args ⇒ blocked. Turn 3: done.
    const llm = new CapturingLLM([
      probeCall("d1", "same-args"),
      probeCall("d2", "same-args"),
      text("done"),
    ])
    const stream = new RecordingStream()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry([...defaultTools, probeTool(counter)]),
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          dedupGate: gate,
          maxTurns: 6,
        }),
      ),
      15_000,
      "dedup-block",
    )

    expect(out.reason).toBe("completed")
    // The FIRST call executed; the SECOND (duplicate) was short-circuited BEFORE
    // execute — so the tool ran exactly once with "same-args".
    expect(counter.runs).toEqual(["same-args"])
    // The synthetic dedup observation reached the model on a subsequent turn.
    expect(allToolResultText(llm.seenMessages)).toContain(DEDUP_MARK)
  })

  test("CONTROL: SAME tool, DIFFERENT args across turns ⇒ NEVER blocked (non-vacuous)", async () => {
    const gate = new DedupGate({ generalWindow: 8, generalThreshold: 2 })
    const counter = { runs: [] as string[] }
    // Same tight cap, but each call carries DISTINCT args ⇒ distinct buckets ⇒
    // the count never reaches threshold, so every call executes.
    const llm = new CapturingLLM([
      probeCall("v1", "arg-one"),
      probeCall("v2", "arg-two"),
      probeCall("v3", "arg-three"),
      text("done"),
    ])
    const stream = new RecordingStream()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry([...defaultTools, probeTool(counter)]),
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          dedupGate: gate,
          maxTurns: 6,
        }),
      ),
      15_000,
      "dedup-control",
    )

    expect(out.reason).toBe("completed")
    // ALL three distinct-args calls executed — none was false-blocked.
    expect(counter.runs).toEqual(["arg-one", "arg-two", "arg-three"])
    expect(allToolResultText(llm.seenMessages)).not.toContain(DEDUP_MARK)
  })
})
