/**
 * OPERATOR KILL-SWITCH + MIN-CAP through the REAL agent loop (RFC jul-13 §4.2/§4.3).
 *
 * The existing `subagent-fork-e2e` proves recursion is bounded when the bound
 * comes from the PER-RUN `config.subagent.maxDepth`. This suite proves the
 * complementary, un-covered guarantee: the OPERATOR POLICY cap
 * (`QUANTA_MAX_DESCENDANT_DEPTH` → `runtimeConfig().maxDescendantDepth`) is
 * authoritative through the real `runAgent` loop, and a generous per-run
 * `maxDepth` can only TIGHTEN it, never RAISE it (the `effectiveCap = min(policy,
 * requested)` rev.4 MIN-CAP rule).
 *
 * Because this drives the real loop, the guarantee is behavioral end-to-end (not
 * a predicate unit): at `cap=0` the `agent` spawn tool is never even minted into
 * the child registry, so a spawn attempt surfaces as an `Unknown tool: agent`
 * dispatch deny and NO child loop ever streams. Each test carries a paired
 * control so the denial is proven to be caused by the operator cap (non-vacuous),
 * plus an explicit note of the mutation that would flip it RED.
 *
 * runtimeConfig() is first-access-frozen, so every case sets the env then calls
 * `__resetRuntimeConfig()` before `runAgent`, and the afterEach restores it.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, withTimeout } from "./_harness"

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const agentCall = (id: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

class RoutingLLM implements LLMPort {
  readonly model = "killswitch-routing-model"
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

const withCap = (value: string | undefined): void => {
  if (value === undefined) delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  else process.env.QUANTA_MAX_DESCENDANT_DEPTH = value
  __resetRuntimeConfig()
}

describe("subagent nesting — operator kill-switch through the real loop", () => {
  afterEach(() => {
    withCap(undefined)
  })

  test("cap=0 kill-switch: the root's OWN agent tool is never minted; no child ever forks — even with a generous per-run maxDepth:3", async () => {
    // Operator sets QUANTA_MAX_DESCENDANT_DEPTH=0 (total kill switch). Even though
    // the run asks for `subagent.maxDepth:3`, `effectiveCap = min(0, 3) = 0`, so
    // `spawnToolsAvailable(root@depth0)` is false and `buildSubagentBlock` returns
    // undefined — the `agent` tool is NOT registered. The parent's spawn attempt
    // dispatches to a non-existent tool ⇒ "Unknown tool: agent" ⇒ recoverable.
    withCap("0")
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "CHILD-TASK must never run"), once: true },
      // Parent recovers from the dispatch deny and finishes.
      { match: "Unknown tool: agent", events: text("PARENT-OBSERVED-KILLSWITCH") },
      // Sentinel: a real child loop would seed on CHILD-TASK. It must NEVER run.
      { match: "CHILD-TASK", events: text("CHILD-RAN-ILLEGALLY") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "killswitch-cap0",
    )

    expect(out.reason).toBe("completed")
    // No child loop ever streamed — the spawn tool was absent, not merely denied
    // at the runner. The generous per-run maxDepth:3 could NOT raise the cap.
    expect(llm.log).not.toContain("CHILD-TASK")
    expect(llm.log).not.toContain("CHILD-RAN-ILLEGALLY")
    expect(llm.log).not.toContain("UNMATCHED")
    // The parent saw the capability-absence dispatch deny and recovered.
    expect(llm.log).toContain("Unknown tool: agent")
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-OBSERVED-KILLSWITCH")
  })

  test("PAIRED CONTROL: default policy (env unset ⇒ rev.4 cap 1) with the SAME cfg ⇒ the child DOES fork", async () => {
    // Identical run, only the operator cap differs (unset ⇒ rev.4 default 1 =
    // root-only). The root's `agent` tool IS minted and its depth-1 child forks
    // (childDepth 1 ≤ effectiveCap min(1,3)=1) — proving the cap=0 denial above
    // was caused by the operator kill-switch, not the harness.
    // MUTATION: reverting `effectiveCap` from min() to a policy-ignoring resolve
    // would let cap=0 behave like this control ⇒ the kill-switch test flips RED.
    withCap(undefined)
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "CHILD-TASK do the work"), once: true },
      { match: "Subagent completed", events: text("PARENT-DONE-WITH-CHILD") },
      { match: "CHILD-TASK", events: text("CHILD-ANSWER from the fork") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "killswitch-control",
    )

    expect(out.reason).toBe("completed")
    // The child loop actually ran this time.
    expect(llm.log).toContain("CHILD-TASK")
    expect(llm.log).not.toContain("Unknown tool: agent")
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr[0].content).toContain("Subagent completed")
    expect(tr[0].content).toContain("CHILD-ANSWER from the fork")
  })

  test("MIN-CAP: operator policy cap=1 CAPS a generous per-run maxDepth:5 — parent spawns a child, but the child's grandchild spawn is runner-denied", async () => {
    // Operator policy = 1 (root-only descendants). The run asks for the generous
    // `subagent.maxDepth:5`, but the runner bounds recursion with the SAME
    // `effectiveCap = min(policy 1, requested 5) = 1`. So:
    //   • parent (depth 0): forks a child (childDepth 1 ≤ 1 — admitted).
    //   • child  (depth 1): attempts a grandchild ⇒ childDepth 2 > effectiveCap 1 ⇒
    //     the AUTHORITATIVE runtime reject denies it ("Subagent denied: recursion
    //     depth 2 exceeds …") — recoverable, never a throw, never an unbounded spawn.
    // With `maxDepth:5` ALONE (no operator cap) that grandchild at depth 2 WOULD be
    // admitted (2 ≤ 5); the deny here is caused solely by the operator policy 1
    // capping the per-run knob. That is the MIN-CAP guarantee end-to-end: a per-run
    // knob can only TIGHTEN, never RAISE above the operator ceiling. MUTATION:
    // `effectiveCap = max(policy, requested)` (or dropping the policy term) would let
    // maxDepth:5 win and the grandchild WOULD fork ⇒ "GRANDCHILD-TASK" in the log ⇒ RED.
    withCap("1")
    const llm = new RoutingLLM([
      // Parent (depth 0): spawn a child once, then finish.
      { match: "PARENT-GO", events: agentCall("a1", "CHILD-TASK spawn a grandchild"), once: true },
      { match: "PARENT-GO", events: text("PARENT-DONE") },
      // Child (depth 1): attempt a grandchild — the runner denies it (depth 2 > cap 1).
      {
        match: "CHILD-TASK",
        events: agentCall("a2", "GRANDCHILD-TASK must never run"),
        once: true,
      },
      // Child recovers from the recoverable runner deny and finishes. Routing on
      // "recursion depth" proves it was the depth-bound reject, not another failure.
      { match: "recursion depth", events: text("CHILD-SAW-CAP-AND-STOPPED") },
      // Sentinel: a real grandchild loop would seed on GRANDCHILD-TASK. Never.
      { match: "GRANDCHILD-TASK", events: text("GRANDCHILD-RAN-ILLEGALLY") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 5 },
          maxTurns: 8,
        }),
      ),
      15_000,
      "killswitch-mincap",
    )

    expect(out.reason).toBe("completed")
    // The child DID fork (policy 1 admits a depth-1 descendant)…
    expect(llm.log).toContain("CHILD-TASK")
    // …but the grandchild NEVER ran — the runner denied it at effectiveCap 1,
    // despite the per-run maxDepth:5. The operator policy 1 capped it.
    expect(llm.log).not.toContain("GRANDCHILD-TASK")
    expect(llm.log).not.toContain("GRANDCHILD-RAN-ILLEGALLY")
    expect(llm.log).not.toContain("UNMATCHED")
    // The child observed the depth-bound reject and routed its recovery rule
    // (proves the deny is the recursion-depth reject, and that it is recoverable —
    // the whole chain still completes rather than throwing).
    expect(llm.log).toContain("recursion depth")
  })
})
