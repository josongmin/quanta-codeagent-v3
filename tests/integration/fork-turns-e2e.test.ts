import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { TaskRegistry } from "@/subagent"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `fork-turns` (GAP8a / C5059-04). The parent's
 * `agent(fork_turns:"all"|N)` tool call must compose the child's seed prompt
 * with an inherited preamble of the parent transcript — and the CHILD's real
 * loop must actually RECEIVE it. Prior coverage was pure-fn unit + a MOCKED
 * runner, so the inheritance through a live child loop was unverified
 * (`runAgent × scripted == 0`). This drives the REAL `runAgent` → real `agent`
 * tool (whose `forkPrompt` is wired at `buildSubagentBlock`, reading
 * `config.messages` when no live `transcriptSource` is injected) → REAL child
 * loop, and inspects the child's actual `StreamInput.messages`.
 */

// A distinctive token in the PARENT's transcript. If fork inheritance works, it
// must reach the CHILD's LLM input; with fork_turns:"none" it must NOT.
const PARENT_MEMO = "PARENT-MEMO-FORKTOKEN-42"

const forkAgentCall = (id: string, prompt: string, forkTurns: "none" | "all" | number): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt, fork_turns: forkTurns } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const convo = (i: StreamInput): string =>
  i.messages
    .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")))
    .join(" ")

/** Routes by substring; records EVERY stream input so we can inspect what the
 *  child loop actually received. */
class CapturingRoutingLLM implements LLMPort {
  readonly model = "fork-test-model"
  readonly childInputs: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    const t = convo(i)
    // Anything that mentions the CHILD task marker is a child turn — record it.
    if (t.includes("CHILD-TASK")) this.childInputs.push(t)
    const rule = this.rules.find((r) => t.includes(r.match) && !(r.once && r.spent))
    if (rule === undefined) {
      yield* text("unmatched")
      return
    }
    if (rule.once) rule.spent = true
    for (const e of rule.events) yield e
  }
}

const run = async (forkTurns: "none" | "all" | number) => {
  __resetRuntimeConfig()
  const llm = new CapturingRoutingLLM([
    { match: "PARENT-GO", events: forkAgentCall("a1", "CHILD-TASK do the subtask", forkTurns), once: true },
    { match: "CHILD-TASK", events: text("CHILD-ANSWER done") },
    { match: "CHILD-ANSWER", events: text("PARENT-DONE") },
  ])
  const out = await withTimeout(
    runAgent(
      cfg({
        llm,
        stream: new RecordingStream(),
        registry: new ToolRegistry(defaultTools),
        // The parent transcript carries the memo — this is what fork_turns:"all"
        // must inherit into the child (config.messages is the forkPrompt source
        // when no live transcriptSource is wired).
        messages: [
          { role: "user", content: [{ type: "text", text: `PARENT-GO. Please remember ${PARENT_MEMO}. Then spawn a child.` }] },
        ],
        subagent: { maxDepth: 3, taskRegistry: new TaskRegistry() },
        maxTurns: 8,
      }),
    ),
    15_000,
    `fork-turns-${forkTurns}`,
  )
  return { out, childInputs: llm.childInputs }
}

describe("fork-turns — real child loop inherits the parent transcript", () => {
  test('fork_turns:"all" ⇒ the child loop RECEIVES the parent memo in its input', async () => {
    const { out, childInputs } = await run("all")
    expect(out.reason).toBe("completed")
    expect(childInputs.length).toBeGreaterThanOrEqual(1)
    // The load-bearing assertion: the parent's transcript token actually reached
    // the CHILD's real LLM input via the fork preamble.
    expect(childInputs.some((t) => t.includes(PARENT_MEMO))).toBe(true)
  })

  test('CONTROL fork_turns:"none" ⇒ the child does NOT receive the parent memo (non-vacuous)', async () => {
    const { out, childInputs } = await run("none")
    expect(out.reason).toBe("completed")
    expect(childInputs.length).toBeGreaterThanOrEqual(1)
    // Cold start — no inheritance. Proves the "all" assertion above discriminates.
    expect(childInputs.some((t) => t.includes(PARENT_MEMO))).toBe(false)
  })

  test("fork_turns:N (numeric) also inherits (last-N turns path)", async () => {
    const { out, childInputs } = await run(5)
    expect(out.reason).toBe("completed")
    expect(childInputs.some((t) => t.includes(PARENT_MEMO))).toBe(true)
  })
})
