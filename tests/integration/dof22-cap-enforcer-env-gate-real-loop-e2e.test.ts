import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import type { Message, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import type { NextAction, Tool, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, eventsOf, RecordingStream, text, withTimeout } from "./_harness"

/**
 * DOF-22 — GATE-SPECIFIC behavior-regression proof for cap-enforcer
 * (QUANTA_CAP_ENFORCE, gate-read src/agent/cap-enforcer.ts:154 via
 * loop-helpers.attachCapEnforcer → session-bootstrap).
 *
 * WHY THIS IS NOT REDUNDANT WITH `cap-enforcer-real-loop-e2e.test.ts`:
 * that sibling INJECTS a `capEnforcer: new CapEnforcer()` directly into the
 * config, so it proves the dispatch wiring but BYPASSES the real
 * `runtimeConfig().capEnforce` gate-read entirely — the enforcer exists no matter
 * what the env says. DOF-22 requires the gate be exercised through its ACTUAL
 * production read-site: set `QUANTA_CAP_ENFORCE=1` → `__resetRuntimeConfig()` →
 * `buildCapEnforcer()` reads `runtimeConfig().capEnforce` → `attachCapEnforcer`
 * (which runs inside the REAL `runAgent` session bootstrap) constructs the
 * enforcer. NO `capEnforcer` is injected here — the loop MUST build it from env.
 *
 * WHY THE GENERIC 8-AXIS A/B CANNOT SEE THIS (adversarial-audit finding):
 * the cap reminder is spliced into a `tool_result`'s CONTENT on a subsequent
 * turn — it does NOT move `systemBytes` (the first system prompt is unchanged),
 * and the run still `completed` with the same turn/tool/event counts, so the
 * generic harness reports a FALSE NO-REGRESSION. The specific observable is the
 * `<system-reminder>` carrying `increase_max_depth` reaching a later turn's LLM
 * `input.messages`, asserted DIRECTLY here.
 *
 * OBSERVABLE       : `<system-reminder>` + `increase_max_depth` text in a
 *                    SUBSEQUENT turn's `StreamInput.messages` tool_result; plus a
 *                    `tool_progress` AgentEvent on the stream.
 * ON  (env set)    : reminder present on turn ≥1.
 * OFF (control)    : env unset ⇒ enforcer never built ⇒ reminder absent.
 * RED-ON-INJECTION : the ON scenario with the env UNSET (same script) ⇒ the
 *                    observable vanishes (the last test doubles as the injection).
 */

const CAP_TOOL = "capped_probe"
const SUGGESTED_DEPTH = 4
const GATE = "QUANTA_CAP_ENFORCE"

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
      result: { ok: true, output: `probed ${input.path} at depth ${input.max_depth}`, nextAction },
    }
  },
})

const registryWithProbe = (): ToolRegistry => new ToolRegistry([...defaultTools, cappedProbeTool()])

const capCall = (id: string, path: string, maxDepth: number): StreamEvent[] => [
  { type: "tool_use_start", id, name: CAP_TOOL },
  { type: "tool_use_end", id, input: { path, max_depth: maxDepth } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** Records every per-turn `StreamInput.messages` so the test can inspect what the
 *  model SAW on each turn. */
class CapturingLLM {
  readonly model = "dof22-cap-enforcer"
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

const toolResultText = (messages: Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
    .join("\n")

const REMINDER_MARK = "increase_max_depth"
const REMINDER_ENVELOPE = "<system-reminder>"

/** Build a config that DOES NOT inject a capEnforcer — the loop must build it from
 *  the env gate-read (that is the whole point of this DOF-22 file). */
const capConfig = (llm: CapturingLLM, stream: RecordingStream) =>
  cfg({
    llm,
    stream,
    registry: registryWithProbe(),
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    maxTurns: 6,
    // capEnforcer intentionally OMITTED — attachCapEnforcer must read the env.
  })

/** The IGNORE script: turn 1 records the hint, turn 2 re-issues the SAME
 *  (tool,path) with the SAME max_depth (ignores it ⇒ check() fires), turn 3
 *  finishes. */
const ignoreLLM = (): CapturingLLM =>
  new CapturingLLM([capCall("c1", "src/", 2), capCall("c2", "src/", 2), text("done")])

const reminderReachedALaterTurn = (llm: CapturingLLM): boolean =>
  llm.seenMessages
    .map((msgs, idx) => ({ idx, txt: toolResultText(msgs) }))
    .filter((t) => t.txt.includes(REMINDER_ENVELOPE) && t.txt.includes(REMINDER_MARK))
    .some((t) => t.idx >= 1)

describe("DOF-22 cap-enforcer — real runAgent loop builds the enforcer from the QUANTA_CAP_ENFORCE gate-read", () => {
  const orig = process.env[GATE]
  beforeEach(() => {
    delete process.env[GATE]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (orig === undefined) delete process.env[GATE]
    else process.env[GATE] = orig
    __resetRuntimeConfig()
  })

  test("ON (env=1) ⇒ ignored cap hint ⇒ steer reminder reaches a SUBSEQUENT turn's LLM messages", async () => {
    process.env[GATE] = "1"
    __resetRuntimeConfig()
    const llm = ignoreLLM()
    const stream = new RecordingStream()
    const out = await withTimeout(runAgent(capConfig(llm, stream)), 15_000, "dof22-cap-on")
    expect(out.reason).toBe("completed")
    // SPECIFIC observable: reminder reached a later turn's model input.
    expect(reminderReachedALaterTurn(llm)).toBe(true)
    // Stream-side surface: a matching tool_progress event fired.
    const progress = eventsOf(stream, "tool_progress").filter((e) =>
      (e.message ?? "").includes(REMINDER_MARK),
    )
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0]?.name).toBe(CAP_TOOL)
  })

  test("OFF CONTROL (env unset) ⇒ SAME ignore-script ⇒ enforcer never built ⇒ NO reminder", async () => {
    // env already deleted by beforeEach.
    const llm = ignoreLLM()
    const stream = new RecordingStream()
    const out = await withTimeout(runAgent(capConfig(llm, stream)), 15_000, "dof22-cap-off")
    expect(out.reason).toBe("completed")
    const anyReminder = llm.seenMessages.some((m) => toolResultText(m).includes(REMINDER_ENVELOPE))
    expect(anyReminder).toBe(false)
    expect(eventsOf(stream, "tool_progress").length).toBe(0)
  })

  // RED-ON-INJECTION: this is the OFF control run with the EXACT same script as the
  // ON case; because the ONLY difference is the env gate, if the gate-read were
  // inert (enforcer always built, or never), one of the two tests above would go
  // red. Here we pin the pair-delta EXPLICITLY: ON has the reminder, OFF does not,
  // within a single test, so a mutation that ignores the env fails immediately.
  test("RED-ON-INJECTION: the reminder presence is CONTROLLED BY the env gate (ON≠OFF, same script)", async () => {
    process.env[GATE] = "1"
    __resetRuntimeConfig()
    const onLlm = ignoreLLM()
    await withTimeout(runAgent(capConfig(onLlm, new RecordingStream())), 15_000, "dof22-cap-inj-on")
    const onHit = reminderReachedALaterTurn(onLlm)

    delete process.env[GATE]
    __resetRuntimeConfig()
    const offLlm = ignoreLLM()
    await withTimeout(
      runAgent(capConfig(offLlm, new RecordingStream())),
      15_000,
      "dof22-cap-inj-off",
    )
    const offHit = offLlm.seenMessages.some((m) => toolResultText(m).includes(REMINDER_ENVELOPE))

    expect(onHit).toBe(true)
    expect(offHit).toBe(false)
    // The delta is attributable to the gate ALONE (identical script + config).
    expect(onHit).not.toBe(offHit)
  })
})
