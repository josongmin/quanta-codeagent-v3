import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { renderAgentFleet } from "@/apps/cli/agents-fleet-panel"
import { toAgentFleetRow } from "@/apps/cli/repl/slash-surface"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { decodeSubagentFrame, encodeSubagentFrame } from "@/protocol/subagent-frame"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import type { SubagentObservation } from "@/protocol/subagent"
import { TaskRegistry } from "@/subagent"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the Sub-Agents panel, driven by a FAKE LLM through the
 * REAL agent loop (`runAgent`) — NOT the isolated `createSubagentRunner`.
 *
 *   fake LLM emits `agent(...)` tool call
 *     → runAgent forks a REAL child loop
 *       → parent TaskRegistry gains a lineage record   (CLI `/agents` reads this)
 *       → onSubagentEvent fires spawn + status          (web panel reads this)
 *
 * Asserts the full chain AND both no-leak fixes end-to-end (a secret the child
 * echoes into its final answer must not survive to either sink).
 */

const agentCall = (id: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

/** Routes each turn by a substring match; `once` rules fire a single time. */
class RoutingLLM implements LLMPort {
  readonly model = "routing-test-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (rule === undefined) {
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(rule.match)
    for (const e of rule.events) yield e
  }
}

// A secret the CHILD echoes into its final answer — must be scrubbed on BOTH
// the CLI record path and the web event path.
const SECRET = "sk-ant-api03-PANELE2ELEAKPANELE2ELEAKPANELE2ELEAK00"

describe("Sub-Agents panel — real loop + fake LLM end-to-end", () => {
  beforeEach(() => {
    // Default policy cap is 1; a single root→child (depth 1) spawn is admitted.
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("fake LLM spawns a real subagent ⇒ registry + events + CLI tree + web frame, secret scrubbed", async () => {
    const llm = new RoutingLLM([
      // Parent turn 1: spawn a subagent with a routable marker in the prompt.
      { match: "PARENT-GO", events: agentCall("a1", "CHILD-TASK investigate the flake"), once: true },
      // Child turn 1: return a final answer that (adversarially) leaks a secret.
      { match: "CHILD-TASK", events: text(`CHILD-ANSWER done, key was ${SECRET}`) },
      // Parent turn 2: after the child's tool_result comes back, finish.
      { match: "CHILD-ANSWER", events: text("PARENT-DONE") },
    ])

    const registry = new TaskRegistry()
    const events: SubagentObservation[] = []

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          // Panel ON: taskRegistry populated + onSubagentEvent wired ⇒ the
          // foreground `agent` spawn registers (per the OFF-gate contract).
          subagent: { maxDepth: 3, taskRegistry: registry },
          onSubagentEvent: (e) => events.push(e),
          maxTurns: 8,
        }),
      ),
      15_000,
      "subagent-panel-e2e",
    )

    // 1. The parent completed and the CHILD actually ran through the real loop.
    expect(out.reason).toBe("completed")
    expect(llm.log).toContain("CHILD-TASK")

    // 2. The parent registry gained the child's lineage record (CLI reads this).
    const tasks = registry.list()
    expect(tasks.length).toBe(1)
    const child = tasks[0]
    expect(child?.description).toContain("CHILD-TASK")
    expect(child?.status).toBe("completed")
    expect(child?.depth).toBe(1)

    // 3. onSubagentEvent fired spawn + a completed status (web panel reads this).
    const spawns = events.filter((e) => e.type === "subagent_spawn")
    const settles = events.filter(
      (e) => e.type === "subagent_status" && e.status === "completed",
    )
    expect(spawns.length).toBeGreaterThanOrEqual(1)
    expect(settles.length).toBeGreaterThanOrEqual(1)
    expect(spawns[0]?.taskId).toBe(child?.id ?? "")

    // 4. NO-LEAK on the WEB event path: the completed status' finalTextPreview
    //    (redacted at the projection) must not carry the secret. Encode/decode
    //    the real WS frame to prove it survives the wire scrubbed.
    const settle = settles[0]
    if (settle?.type === "subagent_status") {
      expect(settle.finalTextPreview ?? "").not.toContain(SECRET)
      const frame = encodeSubagentFrame({ ...settle, emittedAt: 1 })
      const decoded = decodeSubagentFrame(frame)
      expect(decoded).not.toBeNull()
      expect(JSON.stringify(decoded)).not.toContain(SECRET)
    }

    // 5. NO-LEAK + correctness on the CLI path: render `/agents --tree` off the
    //    REAL registry via the real projection. The child shows; the secret does
    //    not (the record's raw finalText is scrubbed at toAgentFleetRow).
    const rows = registry.list().map(toAgentFleetRow)
    const tree = renderAgentFleet(rows, { format: "tree", now: Date.now() })
    expect(tree).toContain("CHILD-TASK")
    expect(tree).not.toContain(SECRET)
    const json = renderAgentFleet(rows, { format: "json", now: Date.now() })
    expect(json).not.toContain(SECRET)
  })
})
