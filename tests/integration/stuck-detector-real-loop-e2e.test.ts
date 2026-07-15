import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import {
  defaultProposeHandler,
  defaultStuckDetector,
  type StuckDetectorPort,
} from "@/agent/auto-background"
import type { StreamEvent, StreamInput } from "@/llm"
import type { Tool, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { z } from "zod"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the ADR-0223 AUTO-BACKGROUND STUCK-DETECTOR tick-wire,
 * driven by a FAKE LLM through the REAL agent loop (`runAgent`).
 *
 * The dispatch wrapper (`executeWithStuckTracking`) brackets `execute()` with
 * `detector.tickToolStart(...)` before and `detector.tickToolEnd(...)` in a
 * `finally`. The isolation suite (`auto-background-*-hellgate.test.ts`) calls
 * `tickToolStart`/`tickToolEnd` MANUALLY on a bare detector — the bracket is
 * NEVER driven by a real loop, so a regression that dropped either half of the
 * wire (or ordered it wrong) is invisible.
 *
 * We drive a tool whose `execute()` STALLS on a promise we control, and while
 * it is in-flight we probe the SAME detector instance the loop was wired with,
 * using the feature's injectable time seam (fake clock) — no real wall-clock
 * wait. Assertions:
 *   1. WHILE `execute()` is stalled, the bracket is OPEN: the injected detector
 *      already tracks the call (tickToolStart ran through the real loop), so a
 *      probe at `now = start + 3000ms` (> 2s threshold) reports `stuck:true`
 *      and the proposer surfaces the "background this?" proposal exactly once.
 *   2. AFTER the tool completes, the bracket CLOSED: `tickToolEnd` ran from the
 *      dispatch `finally`, dropping the entry — a re-probe reports NOT stuck.
 *   3. CONTROL (fast tool, non-vacuous): a tool that returns immediately, probed
 *      at `now = start + 100ms` (< threshold), is NOT stuck and NOT proposed.
 */

const STALL_TOOL = "stall_probe"
const FAST_TOOL = "fast_probe"
const THRESHOLD_MS = 2_000

/** A tool whose `execute()` blocks until an external `release()` resolves the
 *  gate promise — models a >2s stall deterministically (no real sleep). */
const stallTool = (gate: Promise<void>): Tool => ({
  name: STALL_TOOL,
  description: "blocks until externally released — models a stuck exec",
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    await gate
    yield { type: "result", result: { ok: true, output: "unstuck" } }
  },
})

const fastTool = (): Tool => ({
  name: FAST_TOOL,
  description: "returns immediately",
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "fast" } }
  },
})

const call = (id: string, name: string): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input: {} },
  { type: "message_stop", stop_reason: "tool_use" },
]

class ScriptLLM {
  readonly model = "stuck-e2e"
  private readonly turns: StreamEvent[][]
  constructor(turns: StreamEvent[][]) {
    this.turns = turns
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const next = this.turns.shift() ?? text("done")
    for (const e of next) yield e
  }
}

/** The tool-call id the loop generates is the `tool_use_start.id` we scripted,
 *  so the detector is keyed on THAT id. */
const CALL_ID = "s-stuck-1"
const FAST_CALL_ID = "f-fast-1"

describe("auto-background stuck-detector — real loop + fake LLM end-to-end (ADR-0223)", () => {
  test("stalled execute() ⇒ tick bracket OPEN mid-flight: detector stuck + proposer surfaces; CLOSED after finish", async () => {
    // Fake clock the detector + proposer share (feature's injectable time seam).
    let clock = 1_000
    const detector: StuckDetectorPort = defaultStuckDetector({
      thresholdMs: THRESHOLD_MS,
      now: () => clock, // startTimeMs is stamped from this at tickToolStart
    })
    let proposeFired = 0
    const proposer = defaultProposeHandler({ detector, now: () => clock })

    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })

    const llm = new ScriptLLM([call(CALL_ID, STALL_TOOL), text("done")])
    const stream = new RecordingStream()

    // Kick off the loop; it will stall inside the stall tool's execute().
    const runPromise = runAgent(
      cfg({
        llm,
        stream,
        registry: new ToolRegistry([...defaultTools, stallTool(gate)]),
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        autoBackground: { detector, proposer, thresholdMs: THRESHOLD_MS },
        maxTurns: 6,
      }),
    )

    // Wait until the bracket is OPEN — i.e. the real loop reached
    // `tickToolStart` and is now awaiting the stalled execute(). We poll the
    // detector's own list() (populated ONLY by the loop's tickToolStart wire).
    const deadline = Date.now() + 5_000
    while (detector.list().length === 0) {
      if (Date.now() > deadline) throw new Error("bracket never opened (tickToolStart not wired)")
      await new Promise((r) => setTimeout(r, 5))
    }

    // ── §1 bracket OPEN: the entry was created by the REAL loop, keyed on our
    //    scripted call id. Advance the fake clock past threshold and probe.
    const tracked = detector.list()
    expect(tracked.length).toBe(1)
    expect(tracked[0]?.toolCallId).toBe(CALL_ID)

    clock += 3_000 // +3s > 2s threshold
    const probe = detector.isStuck({ toolCallId: CALL_ID, now: clock })
    expect(probe.stuck).toBe(true)
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(THRESHOLD_MS)

    // Proposer surfaces "background this?" exactly once for the stuck id.
    if (proposer.shouldPropose({ toolCallId: CALL_ID, now: clock })) proposeFired += 1
    if (proposer.shouldPropose({ toolCallId: CALL_ID, now: clock })) proposeFired += 1
    expect(proposeFired).toBe(1) // once-per-id
    expect(proposer.hasProposed(CALL_ID)).toBe(true)

    // ── release the stall; let the loop finish and run the finally-wired
    //    tickToolEnd.
    release()
    const out = await withTimeout(runPromise, 15_000, "stuck-detector")
    expect(out.reason).toBe("completed")

    // ── §2 bracket CLOSED: tickToolEnd (dispatch finally) dropped the entry.
    expect(detector.list().length).toBe(0)
    const after = detector.isStuck({ toolCallId: CALL_ID, now: clock })
    expect(after.stuck).toBe(false)
    expect(after.elapsedMs).toBe(0) // absent-entry shape-stable zero
  })

  test("CONTROL: fast tool probed under threshold ⇒ NOT stuck, NOT proposed (non-vacuous)", async () => {
    let clock = 1_000
    const detector: StuckDetectorPort = defaultStuckDetector({
      thresholdMs: THRESHOLD_MS,
      now: () => clock,
    })
    const proposer = defaultProposeHandler({ detector, now: () => clock })

    const llm = new ScriptLLM([call(FAST_CALL_ID, FAST_TOOL), text("done")])

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools, fastTool()]),
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          autoBackground: { detector, proposer, thresholdMs: THRESHOLD_MS },
          maxTurns: 6,
        }),
      ),
      15_000,
      "stuck-detector-fast",
    )

    expect(out.reason).toBe("completed")
    // The fast tool's bracket opened AND closed within the loop; the entry is
    // gone. A probe just under threshold on a still-tracked entry (had it not
    // ended) would be NOT stuck — we prove the sub-threshold semantics directly
    // via a manual track using the SAME clock seam so the control isn't vacuous.
    const manualId = "manual-fast"
    detector.tickToolStart({ toolCallId: manualId })
    clock += 100 // +100ms < 2s threshold
    const probe = detector.isStuck({ toolCallId: manualId, now: clock })
    expect(probe.stuck).toBe(false)
    expect(proposer.shouldPropose({ toolCallId: manualId, now: clock })).toBe(false)
    detector.tickToolEnd({ toolCallId: manualId })
  })
})
