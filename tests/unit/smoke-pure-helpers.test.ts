/**
 * Pure-helper coverage for the smoke harness.
 *
 * The end-to-end battery (`tests/unit/smoke-battery.test.ts`) only proves the
 * happy path: every scenario passes. The PURE helpers — fail-closed JSON
 * extraction, recorder propose/diff, per-run capture slicing, trajectory
 * replay cursor — need direct unit coverage so a regression in their failure
 * modes (which the happy path can't trigger) is caught.
 *
 * Audit consensus (A: C1, B: §3) flagged these exports as untested:
 *   - `parseJudgeReply`           (tests/smoke/judge.ts)
 *   - `proposeExpect` / `diffExpect` (tests/smoke/recorder.ts)
 *   - `serializeTrajectory`       (tests/smoke/recorder.ts)
 *   - `CaptureStream.assistantTextByRun` (tests/smoke/capture-stream.ts)
 *   - `TrajectoryReplayLLM.nextRun` exhaustion + boundary (tests/smoke/replay-llm.ts)
 */
import { describe, expect, test } from "bun:test"
import { CaptureStream } from "../smoke/capture-stream"
import { parseJudgeReply } from "../smoke/judge"
import { diffExpect, proposeExpect, serializeTrajectory } from "../smoke/recorder"
import { TrajectoryReplayLLM } from "../smoke/replay-llm"
import type { ExpectSpec, TrajectoryEntry } from "../smoke/types"

// =====================================================================
// parseJudgeReply — fail-closed JSON extraction.
// =====================================================================
describe("parseJudgeReply", () => {
  test("valid object returns clamped score + rationale", () => {
    const r = parseJudgeReply('{"score": 0.8, "rationale": "ok"}')
    expect(r.score).toBe(0.8)
    expect(r.rationale).toBe("ok")
  })

  test("score above 1 is clamped to 1", () => {
    expect(parseJudgeReply('{"score": 1.5, "rationale": "x"}').score).toBe(1)
  })

  test("score below 0 is clamped to 0", () => {
    expect(parseJudgeReply('{"score": -0.5, "rationale": "x"}').score).toBe(0)
  })

  test("non-numeric score fails closed at 0", () => {
    const r = parseJudgeReply('{"score": "high", "rationale": "x"}')
    expect(r.score).toBe(0)
  })

  test("missing rationale becomes empty string", () => {
    const r = parseJudgeReply('{"score": 0.7}')
    expect(r.score).toBe(0.7)
    expect(r.rationale).toBe("")
  })

  test("no JSON at all → fail closed with diagnostic", () => {
    const r = parseJudgeReply("model decided not to respond in JSON")
    expect(r.score).toBe(0)
    expect(r.rationale).toContain("unparseable")
  })

  test("prose-wrapped JSON is still extracted (first { to last })", () => {
    const raw = 'Here is my evaluation: {"score": 0.9, "rationale": "fine"} -- done.'
    const r = parseJudgeReply(raw)
    expect(r.score).toBe(0.9)
    expect(r.rationale).toBe("fine")
  })

  test("malformed inner JSON fails closed", () => {
    const r = parseJudgeReply('{"score": 0.5, "rationale": broken}')
    expect(r.score).toBe(0)
    expect(r.rationale).toContain("invalid judge JSON")
  })

  test("NaN/Infinity score fails closed", () => {
    // JSON.parse rejects NaN/Infinity tokens; an upstream model that returns
    // them is malformed JSON ⇒ catch path ⇒ score 0.
    expect(parseJudgeReply('{"score": NaN}').score).toBe(0)
    expect(parseJudgeReply('{"score": Infinity}').score).toBe(0)
  })

  test("never throws on adversarial input", () => {
    expect(() => parseJudgeReply("")).not.toThrow()
    expect(() => parseJudgeReply("{")).not.toThrow()
    expect(() => parseJudgeReply("}")).not.toThrow()
    expect(() => parseJudgeReply("{{{}}}")).not.toThrow()
  })
})

// =====================================================================
// proposeExpect / diffExpect — recorder advisories.
// =====================================================================
describe("proposeExpect", () => {
  const capture = (toolNames: string[]): CaptureStream => {
    const c = new CaptureStream()
    toolNames.forEach((name, i) => {
      c.emit({ type: "tool_call", id: `t${i}`, name, input: {} })
    })
    return c
  }

  test("empty capture produces a minimal but valid spec", () => {
    const spec = proposeExpect({ capture: capture([]), stopReason: "completed", turns: 1 })
    expect(spec.stopReason).toBe("completed")
    expect(spec.turns?.count).toEqual({ min: 1, max: 1 })
    // No tools observed ⇒ toolCalls block exists but `required` and `counts`
    // are intentionally omitted so a future scenario can opt in by hand.
    expect(spec.toolCalls?.required).toBeUndefined()
    expect(spec.toolCalls?.counts).toBeUndefined()
  })

  test("captures tool counts exactly (min == max)", () => {
    const spec = proposeExpect({
      capture: capture(["read", "edit", "read"]),
      stopReason: "completed",
      turns: 3,
    })
    expect(spec.toolCalls?.required).toEqual(["edit", "read"])
    expect(spec.toolCalls?.counts).toEqual({ read: { min: 2, max: 2 }, edit: { min: 1, max: 1 } })
  })

  test("turns range is exact (min == max == observed)", () => {
    const spec = proposeExpect({ capture: capture([]), stopReason: "completed", turns: 5 })
    expect(spec.turns?.count).toEqual({ min: 5, max: 5 })
  })
})

describe("diffExpect", () => {
  test("identical proposed fields produce empty diff", () => {
    const a: ExpectSpec = {
      stopReason: "completed",
      turns: { count: { min: 2, max: 2 } },
      toolCalls: { required: ["read"], counts: { read: { min: 1, max: 1 } } },
    }
    expect(diffExpect(a, a)).toBe("")
  })

  test("turns divergence is surfaced", () => {
    const existing: ExpectSpec = { turns: { count: { min: 2, max: 2 } } }
    const observed: ExpectSpec = { turns: { count: { min: 3, max: 3 } } }
    const d = diffExpect(existing, observed)
    expect(d).toContain("turns.count")
    expect(d).toContain("2")
    expect(d).toContain("3")
  })

  test("stopReason divergence is surfaced", () => {
    const d = diffExpect({ stopReason: "completed" }, { stopReason: "error" })
    expect(d).toContain("stopReason")
    expect(d).toContain("completed")
    expect(d).toContain("error")
  })

  test("required-tools divergence is surfaced", () => {
    const d = diffExpect(
      { toolCalls: { required: ["read"] } },
      { toolCalls: { required: ["read", "edit"] } },
    )
    expect(d).toContain("toolCalls.required")
  })
})

// =====================================================================
// serializeTrajectory — replay-compatible JSONL.
// =====================================================================
describe("serializeTrajectory", () => {
  test("round-trips through TrajectoryReplayLLM", async () => {
    const entries: TrajectoryEntry[] = [
      { run: 0, turn: 0, event: { type: "text_delta", delta: "hi" } as Record<string, unknown> },
      {
        run: 0,
        turn: 0,
        event: { type: "message_stop", stop_reason: "end_turn" } as Record<string, unknown>,
      },
    ]
    const serialized = serializeTrajectory(entries)
    // One object per line + trailing newline.
    expect(serialized.split("\n").filter((l) => l.length > 0)).toHaveLength(2)
    const parsed = serialized
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as TrajectoryEntry)
    expect(parsed).toEqual(entries)
  })

  test("empty input produces a lone newline (replay reads 0 entries)", () => {
    expect(serializeTrajectory([])).toBe("\n")
  })
})

// =====================================================================
// CaptureStream.assistantTextByRun — per-run slicing.
// =====================================================================
describe("CaptureStream.assistantTextByRun", () => {
  test("no beginRun() ⇒ single run bucket with concatenated text", () => {
    const c = new CaptureStream()
    c.emit({ type: "assistant_text", delta: "hello " })
    c.emit({ type: "assistant_text", delta: "world" })
    expect(c.assistantTextByRun()).toEqual(["hello world"])
  })

  test("beginRun() boundaries slice text correctly", () => {
    const c = new CaptureStream()
    c.beginRun()
    c.emit({ type: "assistant_text", delta: "run0 " })
    c.emit({ type: "assistant_text", delta: "text" })
    c.beginRun()
    c.emit({ type: "assistant_text", delta: "run1" })
    c.beginRun()
    c.emit({ type: "assistant_text", delta: "run2" })
    expect(c.assistantTextByRun()).toEqual(["run0 text", "run1", "run2"])
  })

  test("empty run between boundaries yields empty string at that index", () => {
    const c = new CaptureStream()
    c.beginRun()
    c.emit({ type: "assistant_text", delta: "a" })
    c.beginRun() // run 1 has no text
    c.beginRun()
    c.emit({ type: "assistant_text", delta: "c" })
    expect(c.assistantTextByRun()).toEqual(["a", "", "c"])
  })
})

// =====================================================================
// TrajectoryReplayLLM — cursor + exhaustion.
// =====================================================================
describe("TrajectoryReplayLLM", () => {
  const drain = async (iter: AsyncIterable<unknown>): Promise<unknown[]> => {
    const out: unknown[] = []
    for await (const ev of iter) out.push(ev)
    return out
  }

  const input = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }],
    tools: [],
  }

  test("yields the bucketed events in (run, turn) order", async () => {
    const llm = new TrajectoryReplayLLM([
      { run: 0, turn: 0, event: { type: "text_delta", delta: "a" } },
      { run: 0, turn: 0, event: { type: "message_stop", stop_reason: "end_turn" } },
    ])
    const events = await drain(llm.stream(input))
    expect(events).toHaveLength(2)
  })

  test("nextRun() advances run cursor; subsequent stream() reads run 1", async () => {
    const llm = new TrajectoryReplayLLM([
      { run: 0, turn: 0, event: { type: "text_delta", delta: "first" } },
      { run: 0, turn: 0, event: { type: "message_stop", stop_reason: "end_turn" } },
      { run: 1, turn: 0, event: { type: "text_delta", delta: "second" } },
      { run: 1, turn: 0, event: { type: "message_stop", stop_reason: "end_turn" } },
    ])
    await drain(llm.stream(input))
    llm.nextRun()
    const second = (await drain(llm.stream(input))) as Array<{
      type: string
      delta?: string
    }>
    expect(second.some((e) => e.type === "text_delta" && e.delta === "second")).toBe(true)
  })

  test("exhausted bucket throws with run+turn coordinates in the message", () => {
    const llm = new TrajectoryReplayLLM([])
    expect(async () => {
      for await (const _ of llm.stream(input)) {
        // exhausted on first read
      }
    }).toThrow(/run=0 turn=0/)
  })

  test("nextRun() beyond recorded runs throws on next stream()", async () => {
    const llm = new TrajectoryReplayLLM([
      { run: 0, turn: 0, event: { type: "message_stop", stop_reason: "end_turn" } },
    ])
    await drain(llm.stream(input))
    llm.nextRun() // run 1 — not recorded
    expect(async () => {
      for await (const _ of llm.stream(input)) {
        // exhausted
      }
    }).toThrow(/run=1 turn=0/)
  })

  test("multiple turns within one run advance the turn cursor", async () => {
    const llm = new TrajectoryReplayLLM([
      { run: 0, turn: 0, event: { type: "tool_use_start", id: "a", name: "read" } },
      { run: 0, turn: 0, event: { type: "tool_use_end", id: "a", input: {} } },
      { run: 0, turn: 0, event: { type: "message_stop", stop_reason: "tool_use" } },
      { run: 0, turn: 1, event: { type: "text_delta", delta: "done" } },
      { run: 0, turn: 1, event: { type: "message_stop", stop_reason: "end_turn" } },
    ])
    const first = await drain(llm.stream(input))
    const second = (await drain(llm.stream(input))) as Array<{ type: string }>
    expect(first.length).toBe(3)
    expect(second.length).toBe(2)
    expect(second[0]?.type).toBe("text_delta")
  })
})
