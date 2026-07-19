/**
 * DOF-21 REAL-LOOP proof for the subagent cluster `subagent-introspect`
 * (`list_agents`, gate `config.subagent.enableIntrospect` / QUANTA_SUBAGENT_INTROSPECT)
 * driven over a REAL BACKGROUND subagent spawn (`subagent-background`).
 *
 * STALE/WEAK EXCERPT REPLACED — `tests/unit/subagent-introspect-hellgate.test.ts`
 * is a PURE HELPER CALL: it builds `buildSubagentIntrospectBlock({ enableIntrospect })`,
 * hand-seeds a `TaskRegistry`, finds the `list_agents` tool, and invokes its
 * `.execute(...)` DIRECTLY:
 *
 *     const features = buildSubagentIntrospectBlock(featuresConfig({ enableIntrospect: true }))
 *     const listTool = features.extraTools.find((t) => t.name === "list_agents")
 *     // ... call listTool.execute against a hand-seeded registry
 *
 * It never runs `runAgent`, never spawns a real child, and never proves a real
 * background subagent lands in the SAME registry `list_agents` reads. So
 * `runAgent × (list_agents observing a real spawn) == 0`.
 *
 * WHAT THIS DRIVES (the real loop, end-to-end):
 *   `runAgent` with a SCRIPTED `LLMPort`, `config.subagent = { enableIntrospect:
 *   true, taskRegistry }` (so the REAL `agent` + `list_agents` tools are both
 *   registered against ONE shared registry). The scripted parent FIRST spawns a
 *   real BACKGROUND child (`agent({ background: true })`) — the tool registers a
 *   lineage record and forks the real child loop — THEN calls `list_agents`,
 *   whose tool_result must ENUMERATE that real child. Two production consumers of
 *   the shared registry exercised through one loop.
 *
 * GROUND TRUTH: the rendered `list_agents` tool_result the model receives must
 * carry the background child's label (its task description) + a real registry
 * status row (`[running]`/`[settled]` + `depth=`) — proving `list_agents` read
 * the SAME registry the real spawn wrote to, not an empty/stub table.
 *
 * PAIRED CONTROL (gate OFF ⇒ behavior fails): `enableIntrospect` OMITTED ⇒
 * `list_agents` is NOT registered ⇒ the parent's `list_agents` tool_use resolves
 * to a dispatch "Unknown tool: list_agents" error. The background spawn still
 * works (that is the `agent` tool, always present when `subagent` is set), so the
 * discriminator is precisely the introspect gate — not the spawn.
 */

import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { TaskRegistry } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const bgSpawn = (id: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt, background: true } },
  { type: "message_stop", stop_reason: "tool_use" },
]
const listAgents = (id: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "list_agents" },
  { type: "tool_use_end", id, input: { includeSettled: true } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

class RoutingLLM implements LLMPort {
  readonly model = "introspect-bg-routing-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (!rule) {
      this.log.push(`UNMATCHED:${txt.slice(0, 40)}`)
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(rule.match)
    for (const e of rule.events) yield e
  }
}

const toolResults = (out: Awaited<ReturnType<typeof runAgent>>) =>
  out.messages.flatMap((m) =>
    m.content.filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result"),
  )

// The background child's task description ⇒ its list_agents label.
const CHILD_SEED = "investigate the failing test"
const BG_TASK = `SIDE-CHILD ${CHILD_SEED}`

describe("subagent-introspect + background — REAL loop: list_agents enumerates a real background spawn", () => {
  test("gate ON: parent spawns a real background child, then list_agents surfaces it from the shared registry", async () => {
    const taskRegistry = new TaskRegistry()
    const llm = new RoutingLLM([
      // MOST-SPECIFIC first: the background CHILD loop (seeded on its prompt) —
      // matches only the child's own seed text, which no other turn contains
      // BEFORE the list result renders it. Non-`once` so a re-render can't UNMATCH.
      { match: CHILD_SEED, events: text("child finished investigating"), once: false },
      // Parent turn 1: launch the background child (registers into taskRegistry).
      { match: "PARENT-GO", events: bgSpawn("s1", BG_TASK), once: true },
      // Parent turn 2: after the launch tool_result ("task_id:"), enumerate.
      { match: "task_id:", events: listAgents("l1"), once: true },
      // Parent turn 3: after the list render ("depth=" only appears there), finish.
      { match: "depth=", events: text("parent saw the agent list, done"), once: true },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          // GATE ON — introspect registers list_agents; shared registry threaded.
          subagent: { enableIntrospect: true, taskRegistry, maxDepth: 3 },
          maxTurns: 8,
        } as never),
      ),
      15_000,
      "introspect-bg-on",
    )

    expect(out.reason).toBe("completed")

    const results = toolResults(out)
    // The background launch produced a task_id result (real background spawn).
    const bgResult = results.find((r) => r.content.includes("task_id:"))
    expect(bgResult).toBeDefined()

    // GROUND TRUTH: the list_agents tool_result enumerated the real background
    // child from the SHARED registry — its label + a real status row rendered.
    const listResult = results.find(
      (r) => r.content.includes("depth=") && !r.content.includes("task_id:"),
    )
    expect(listResult).toBeDefined()
    expect(listResult?.is_error).toBeUndefined()
    expect(listResult?.content ?? "").toContain(CHILD_SEED)
    expect(listResult?.content ?? "").toMatch(/\[(running|settled|failed)\]/)

    // Read-back from the SAME registry instance list_agents consumed.
    const allTasks = taskRegistry.list()
    expect(allTasks.some((t) => (t.description ?? "").includes(CHILD_SEED))).toBe(true)

    expect(llm.log).not.toContain("UNMATCHED")
  })

  test("PAIRED CONTROL: gate OFF (enableIntrospect omitted) ⇒ list_agents NOT registered (Unknown tool)", async () => {
    const taskRegistry = new TaskRegistry()
    const llm = new RoutingLLM([
      { match: CHILD_SEED, events: text("child finished investigating"), once: false },
      { match: "PARENT-GO", events: bgSpawn("s1", BG_TASK), once: true },
      { match: "task_id:", events: listAgents("l1"), once: true },
      // list_agents is unregistered ⇒ Unknown tool ⇒ parent recovers + finishes.
      { match: "Unknown tool", events: text("parent recovered from missing list_agents"), once: true },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          // GATE OFF — subagent block present (background spawn still works) but
          // enableIntrospect OMITTED ⇒ list_agents NOT registered.
          subagent: { taskRegistry, maxDepth: 3 },
          maxTurns: 8,
        } as never),
      ),
      15_000,
      "introspect-bg-off",
    )

    expect(out.reason).toBe("completed")
    const results = toolResults(out)
    // The background spawn STILL worked (the `agent` tool is unaffected).
    expect(results.some((r) => r.content.includes("task_id:"))).toBe(true)
    // But list_agents is an UNKNOWN-TOOL error — the introspect gate is the sole
    // discriminator between the two runs.
    const listErr = results.find((r) => r.is_error === true)
    expect(listErr).toBeDefined()
    expect(listErr?.content ?? "").toContain("Unknown tool")
    expect(listErr?.content ?? "").toContain("list_agents")
    // Definitively: no agent-enumeration render happened.
    expect(results.some((r) => r.content.includes("depth="))).toBe(false)
  })
})
