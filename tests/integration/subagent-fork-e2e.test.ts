import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * GAP 6 — a REAL recursive subagent fork through `runAgent`.
 *
 * `config.subagent` is set, so features.ts builds the `agent`/`task_output`/
 * `task_stop` tools wired against a real `createSubagentRunner(config)` — the
 * ACTUAL fork path (no injected fake runner). When the scripted parent model
 * calls the `agent` tool, the runner builds a child `AgentConfig`
 * (`buildChildConfig`: keeps `parent.llm`) and calls the real `runAgent` on
 * the child. The child runs its own loop on the SAME `llm`; we route turns by
 * a unique marker in the latest user message so parent / child / grandchild
 * are deterministic and isolated.
 *
 * Asserts: (1) the child actually forked and ran (its scripted turn produced
 * the answer the parent surfaces as a tool_result summary), (2) the parent
 * then completes, and (3) SOTA++ ADR-0011: `buildChildConfig` now PROPAGATES
 * `config.subagent` into the child, so a forked child ALSO registers the
 * `agent` tool and CAN spawn sub-subagents. Recursion is bounded MULTI-LEVEL
 * by `maxDepth`: with `maxDepth:2` a parent→child→grandchild chain spawns real
 * nested subagents, and the FIRST spawn attempt that would exceed the ceiling
 * returns a recoverable "max subagent depth exceeded" tool_result (never a
 * throw, never an unbounded spawn) while the whole chain still completes.
 */

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const agentCall = (id: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** All conversation text (every message, every block) so routing is robust
 *  against the ephemeral trailing `<system-reminder>` `buildTurnContext`
 *  appends — the marker we route on lives in a real user/tool_result block. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/**
 * Routes each turn by a substring match against the latest user message.
 * `once:true` rules fire a single time then are spent (so a parent that polls
 * again after a tool_result moves to its follow-up rule).
 */
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
    if (!rule) {
      this.log.push(`UNMATCHED:${txt.slice(0, 40)}`)
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(`${rule.match}`)
    for (const e of rule.events) yield e
  }
}

describe("GAP 6 — real recursive subagent fork through runAgent", () => {
  test("parent forks a real child runAgent; child summary returned to parent", async () => {
    const llm = new RoutingLLM([
      // Parent root turn: delegate via the real `agent` tool.
      {
        match: "PARENT-GO",
        events: agentCall("a1", "CHILD-TASK do the subtask"),
        once: true,
      },
      // After the child's tool_result returns, parent finishes.
      { match: "Subagent completed", events: text("parent done with child result") },
      // Child root turn (its seed = the req.prompt) — real forked loop.
      { match: "CHILD-TASK", events: text("CHILD-ANSWER computed in the fork") },
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "subagent-fork",
    )

    expect(out.reason).toBe("completed")
    // The child loop actually ran (its routed turn fired between the parent's).
    expect(llm.log).toContain("CHILD-TASK")
    expect(llm.log.indexOf("PARENT-GO")).toBeLessThan(llm.log.indexOf("CHILD-TASK"))

    // The child's answer comes back to the PARENT as the agent tool_result.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr[0].content).toContain("Subagent completed")
    expect(tr[0].content).toContain("CHILD-ANSWER computed in the fork")

    // Parent then completed with its own final assistant turn.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("parent done with child result")
  })

  test("recursion is bounded MULTI-LEVEL by maxDepth: parent→child→grandchild, the next spawn is a recoverable deny", async () => {
    // SOTA++ ADR-0011: `buildChildConfig` (subagent-runner.ts) NOW propagates
    // `config.subagent` into the child, so the child's own `runAgent`/
    // `buildSessionFeatures` DOES register an `agent` tool — a forked child can
    // itself spawn sub-subagents. Recursion is bounded MULTI-LEVEL by
    // `maxDepth` (the real, load-bearing bound): with `maxDepth:2` the depth
    // chain is parent(depth 0) → child(depth 1) → grandchild(depth 2). The
    // grandchild's attempt to spawn a 4th level computes `childDepth = 3 >
    // maxDepth 2`, so the `agent` tool yields a recoverable deny tool_result
    // ("recursion depth 3 exceeds maxDepth 2") WITHOUT ever calling the runner
    // — never a throw, never an unbounded spawn. The runner's own
    // `req.depth > maxDepth ⇒ "max subagent depth exceeded"` guard is the
    // mirror of the same bound (it would fire if a req.depth of 3 ever reached
    // it). The deny is recoverable, so the grandchild, child and parent all
    // still complete cleanly.
    //
    // Determinism + hard bound against a logic regression: each level routes on
    // its OWN unique seed marker. Every spawn rule is `once`, so a level spawns
    // AT MOST one child; after it is spent the same marker matches that level's
    // follow-up rule. Markers are disjoint and there is NO rule that would
    // spawn a 4th-level loop, so a depth-guard regression cannot infinite-loop
    // — it would instead surface as an UNMATCHED fallback / spawn-count
    // assertion failure. maxTurns is also low per the cfg default.
    const llm = new RoutingLLM([
      // Parent (depth 0): spawn child once, then finish.
      { match: "PARENT-GO", events: agentCall("a1", "LEVEL1-TASK spawn child"), once: true },
      { match: "PARENT-GO", events: text("PARENT-DONE") },
      // Child (depth 1): spawn grandchild once, then finish.
      { match: "LEVEL1-TASK", events: agentCall("a2", "LEVEL2-TASK spawn grandchild"), once: true },
      { match: "LEVEL1-TASK", events: text("CHILD-DONE") },
      // Grandchild (depth 2): attempt a 4th level — the `agent` tool denies it
      // (childDepth 3 > maxDepth 2). Recover from the deny tool_result, finish.
      {
        match: "LEVEL2-TASK",
        events: agentCall("a3", "LEVEL3-TASK must never spawn a real loop"),
        once: true,
      },
      { match: "exceeds maxDepth", events: text("GRANDCHILD-SAW-DENY-AND-STOPPED") },
      // Guard: a real 4th-level loop would seed on LEVEL3-TASK. It must NEVER
      // run — if this fires the depth bound regressed.
      { match: "LEVEL3-TASK", events: text("LEVEL4-RAN-ILLEGALLY") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 2 },
          maxTurns: 6,
        }),
      ),
      15_000,
      "subagent-depth-multi",
    )

    expect(out.reason).toBe("completed")

    // All three real levels ran, in order, exactly once each.
    expect(llm.log).toContain("LEVEL1-TASK")
    expect(llm.log).toContain("LEVEL2-TASK")
    // The 4th-level loop NEVER executed (recursion bounded at maxDepth).
    expect(llm.log).not.toContain("LEVEL3-TASK")
    expect(llm.log).not.toContain("LEVEL4-RAN-ILLEGALLY")
    expect(llm.log).not.toContain("UNMATCHED")
    // The grandchild saw the deny tool_result and recovered (proves the bound
    // is a recoverable deny, not a throw and not an unbounded spawn).
    expect(llm.log).toContain("exceeds maxDepth")

    // Hard call-count bound: a depth-guard regression cannot infinite-loop.
    // Exactly the 6 scripted turns: parent ×2 (spawn child, then finish),
    // child ×2 (spawn grandchild, then finish), grandchild ×2 (attempt 4th
    // level → denied, then recover). A regression that let the grandchild
    // actually fork a 4th loop would add a "LEVEL3-TASK" turn (asserted absent
    // above) and push this count past 6 / surface as UNMATCHED.
    expect(llm.log.length).toBe(6)
    expect(llm.log).toEqual([
      "PARENT-GO", // parent forks child (req.depth 1 ≤ 2)
      "LEVEL1-TASK", // child forks grandchild (req.depth 2 ≤ 2)
      "LEVEL2-TASK", // grandchild attempts 4th level → tool deny (childDepth 3 > 2)
      "exceeds maxDepth", // grandchild recovers from the deny tool_result
      "LEVEL1-TASK", // child finishes after grandchild summary
      "PARENT-GO", // parent finishes after child summary
    ])

    // Order: each level forked before the level below it could route.
    expect(llm.log.indexOf("PARENT-GO")).toBeLessThan(llm.log.indexOf("LEVEL1-TASK"))
    expect(llm.log.indexOf("LEVEL1-TASK")).toBeLessThan(llm.log.indexOf("LEVEL2-TASK"))
    expect(llm.log.indexOf("LEVEL2-TASK")).toBeLessThan(llm.log.indexOf("exceeds maxDepth"))

    // The whole chain still completed. The parent's single tool_result carries
    // the child's summary; per the runner's contract `finalText` is the child's
    // TRAILING assistant text only (`lastAssistantText`) — the grandchild's
    // summary was a tool_result *inside the child loop*, not the child's final
    // assistant turn, so it does NOT string-nest into the parent's tool_result.
    // Transitive completion across all three levels is instead proven by the
    // exact `llm.log` ordering asserted above (each level forked the one below
    // and the grandchild recovered from the deny before any level finished).
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr[0].content).toContain("Subagent completed")
    expect(tr[0].content).toContain("CHILD-DONE")

    // Parent then completed with its own final assistant turn.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-DONE")
  })
})
