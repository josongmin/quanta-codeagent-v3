import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import { CapEnforcer } from "@/agent/cap-enforcer"
import type { Message, StreamEvent, StreamInput } from "@/llm"
import type { NextAction, Tool, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, eventsOf, RecordingStream, text, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the ADR-0062 rule #3 CAP-ENFORCER, driven by a FAKE LLM
 * through the REAL agent loop (`runAgent`) — NOT the isolated
 * `CapEnforcer.check/record` unit calls in `next-action-cap-enforce.test.ts`.
 *
 * The unit test only proves `check()`/`record()` compute the right string in
 * isolation. What was UNVERIFIED end-to-end: that when a tool emits a
 * `nextAction` hint on turn N and the model re-issues the SAME (tool,path) on
 * turn N+1 WITHOUT applying it, the enforcement reminder actually
 *   1. rides `execute()` → `capEnforcer.record` (post-execute), then
 *   2. `capEnforcer.check` (pre-execute next turn) → `handleCapReminder` emits a
 *      `tool_progress` event AND `prependCapReminder` splices the
 *      `<system-reminder>` into the tool_result the loop appends to working
 *      memory — so it REACHES THE NEXT TURN'S LLM INPUT `messages`.
 *
 * We capture every `StreamInput.messages` in the scripted LLM and assert the
 * reminder appears in a SUBSEQUENT turn's input. Paired controls prove the
 * assertion is non-vacuous:
 *   · APPLIED-hint variant  ⇒ NO reminder (the enforcer is silent when the model
 *                             obeys — proves the reminder isn't unconditional).
 *   · enforcer-ABSENT variant ⇒ NO reminder (OFF-parity — proves the reminder is
 *                             produced BY the enforcer, not by the loop itself).
 */

const CAP_TOOL = "capped_probe"
const SUGGESTED_DEPTH = 4

/** A test tool that ALWAYS returns an `increase_max_depth` nextAction hint on a
 *  successful result — the same third-channel signal `file_tree_summary` emits
 *  when its output is truncated, but deterministic (no filesystem / truncation
 *  setup needed). This is the REAL `execute()` → `capEnforcer.record` path. */
const cappedProbeTool = (): Tool => ({
  name: CAP_TOOL,
  description: "test probe that emits an increase_max_depth nextAction hint",
  inputSchema: z.object({ path: z.string(), max_depth: z.number() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: { path: string; max_depth: number }): AsyncIterable<ToolEvent> {
    const nextAction: NextAction = {
      kind: "increase_max_depth",
      suggested: SUGGESTED_DEPTH,
      reason: "output capped at requested depth",
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: `probed ${input.path} at depth ${input.max_depth}`,
        nextAction,
      },
    }
  },
})

const registryWithProbe = (): ToolRegistry => new ToolRegistry([...defaultTools, cappedProbeTool()])

const capCall = (id: string, path: string, maxDepth: number): StreamEvent[] => [
  { type: "tool_use_start", id, name: CAP_TOOL },
  { type: "tool_use_end", id, input: { path, max_depth: maxDepth } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** Records every per-turn `StreamInput.messages` so the test can inspect what
 *  the model SAW on each turn (the reminder-tail is what we're proving). */
class CapturingLLM {
  readonly model = "cap-enforcer-e2e"
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

/** Flatten every tool_result block's textual content across all messages of a
 *  single turn — the reminder is spliced into a tool_result `content`. */
const toolResultText = (messages: Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
    .join("\n")

const REMINDER_MARK = "increase_max_depth"
const REMINDER_ENVELOPE = "<system-reminder>"

describe("cap-enforcer — real loop + fake LLM end-to-end (ADR-0062 rule #3)", () => {
  test("model IGNORES the cap hint across turns ⇒ steer reminder reaches the NEXT turn's LLM messages", async () => {
    // Turn 1: call the probe (records nextAction). Turn 2: call SAME (tool,path)
    // with the SAME max_depth (IGNORES the hint ⇒ check() fires). Turn 3: finish.
    const llm = new CapturingLLM([
      capCall("c1", "src/", 2),
      capCall("c2", "src/", 2), // ← ignores: max_depth still 2 (< suggested 4)
      text("done"),
    ])
    const stream = new RecordingStream()
    const enforcer = new CapEnforcer()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: registryWithProbe(),
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          capEnforcer: enforcer,
          maxTurns: 6,
        }),
      ),
      15_000,
      "cap-enforcer-ignore",
    )

    expect(out.reason).toBe("completed")

    // The reminder must appear in a turn the model saw AFTER the ignored call —
    // i.e. NOT the first turn (which had no tool_result yet). Turn index 2 (0-based)
    // is the turn following the second, ignored call.
    const reminderTurns = llm.seenMessages
      .map((msgs, idx) => ({ idx, txt: toolResultText(msgs) }))
      .filter((t) => t.txt.includes(REMINDER_ENVELOPE) && t.txt.includes(REMINDER_MARK))

    expect(reminderTurns.length).toBeGreaterThanOrEqual(1)
    // It must land on a SUBSEQUENT turn (not turn 0 — proves cross-turn dynamics).
    expect(reminderTurns.every((t) => t.idx >= 1)).toBe(true)

    // The stream also carries the `tool_progress` reminder (UI/recorder surface).
    const progress = eventsOf(stream, "tool_progress").filter((e) =>
      (e.message ?? "").includes(REMINDER_MARK),
    )
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0]?.name).toBe(CAP_TOOL)
  })

  test("CONTROL (applied hint): model APPLIES the hint on turn 2 ⇒ NO reminder (non-vacuous)", async () => {
    const llm = new CapturingLLM([
      capCall("a1", "src/", 2),
      capCall("a2", "src/", 8), // ← applies: max_depth 8 >= suggested 4
      text("done"),
    ])
    const stream = new RecordingStream()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: registryWithProbe(),
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          capEnforcer: new CapEnforcer(),
          maxTurns: 6,
        }),
      ),
      15_000,
      "cap-enforcer-applied",
    )

    expect(out.reason).toBe("completed")
    const anyReminder = llm.seenMessages.some((msgs) =>
      toolResultText(msgs).includes(REMINDER_ENVELOPE),
    )
    expect(anyReminder).toBe(false)
    const progress = eventsOf(stream, "tool_progress").filter((e) =>
      (e.message ?? "").includes(REMINDER_MARK),
    )
    expect(progress.length).toBe(0)
  })

  test("CONTROL (enforcer OFF): identical ignore-script with NO capEnforcer ⇒ NO reminder (OFF-parity)", async () => {
    const llm = new CapturingLLM([
      capCall("o1", "src/", 2),
      capCall("o2", "src/", 2), // same ignore-script as the positive case
      text("done"),
    ])
    const stream = new RecordingStream()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: registryWithProbe(),
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          // capEnforcer intentionally ABSENT ⇒ default-OFF byte-identical.
          maxTurns: 6,
        }),
      ),
      15_000,
      "cap-enforcer-off",
    )

    expect(out.reason).toBe("completed")
    const anyReminder = llm.seenMessages.some((msgs) =>
      toolResultText(msgs).includes(REMINDER_ENVELOPE),
    )
    expect(anyReminder).toBe(false)
    expect(eventsOf(stream, "tool_progress").length).toBe(0)
  })
})
