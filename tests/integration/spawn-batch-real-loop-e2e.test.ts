import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { TaskRegistry } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for the `spawn_batch` FAN-OUT tool (ADR-0436), driven by a
 * FAKE LLM through the REAL agent loop (`runAgent`).
 *
 * The unit + regression suites (`subagent-batch-hellgate`,
 * `subagent-batch-template`, `team-dag-spawn-batch-live-e2e-hellgate`) all drive
 * the PURE dispatch core (`runBatch`) with an INJECTED fake runner — they never
 * fork a real child loop. So `runAgent × scripted-LLM == 0` for the batch tool:
 * a regression in the composition-root wiring (the tool never reaching the
 * registry, the injected runner not forking real children, or results not
 * aggregating back to the parent) would be invisible.
 *
 * This drives the WHOLE path:
 *   parent `runAgent` (scripted) → `spawn_batch` tool (minted at
 *   `buildSubagentBatchBlock` when `config.subagent.enableBatchSpawn === true`,
 *   the GATED live-tool gate — also settable via `QUANTA_SUBAGENT_BATCH=on` at
 *   the composition root) → the REAL `createSubagentRunner(config)` bridge →
 *   `runAgent` forked per item at depth 1 (parentDepth 0 + 1, admitted by the
 *   default `maxDescendantDepth = 1`) → per-item results aggregated back into
 *   the parent's tool_result.
 *
 * We route each real child loop by a unique `{{item}}` marker in its seed prompt
 * so parent / child-A / child-B are deterministic and isolated, and assert:
 *   1. BOTH real children actually forked and ran (their scripted answers fired).
 *   2. The aggregated `spawn_batch` tool_result reaches the parent carrying
 *      "batch complete: 2/2 ok" + each child's answer head.
 *   3. The parent then completes on its own final turn.
 */

const ENABLE = { maxDepth: 1, taskRegistry: new TaskRegistry(), enableBatchSpawn: true } as const

const spawnBatchCall = (id: string, input: Record<string, unknown>): StreamEvent[] => [
  { type: "tool_use_start", id, name: "spawn_batch" },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** All conversation text (every message, every block) so routing is robust
 *  against the ephemeral trailing `<system-reminder>` the loop appends — the
 *  marker we route on lives in a real user/tool_result block. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/** Routes each stream() call by a substring against the whole conversation.
 *  `once:true` rules fire a single time then are spent (so the parent, after a
 *  tool_result returns, advances to its follow-up finish rule). Logs which rule
 *  fired so we can assert BOTH children actually forked and ran. */
class RoutingLLM implements LLMPort {
  readonly model = "spawn-batch-e2e"
  readonly log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (rule === undefined) {
      this.log.push(`UNMATCHED:${txt.slice(0, 48)}`)
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(rule.match)
    for (const e of rule.events) yield e
  }
}

describe("spawn_batch — real fan-out through runAgent forks N real children + aggregates", () => {
  test("parent spawn_batch spawns 2 REAL child loops; both run; results aggregate back to the parent", async () => {
    __resetRuntimeConfig()
    const llm = new RoutingLLM([
      // Parent root turn: fan out over 2 items via the batch tool. The template
      // renders `CHILD-TASK-<item>` per item ⇒ two distinct child seeds.
      {
        match: "PARENT-GO",
        events: spawnBatchCall("b1", {
          items: ["alpha", "bravo"],
          prompt_template: "CHILD-TASK-{{item}} do the subtask",
        }),
        once: true,
      },
      // After the batch tool_result returns, the parent finishes.
      { match: "batch complete", events: text("PARENT-DONE all children back") },
      // The two REAL forked child loops — each routed by its own item marker.
      { match: "CHILD-TASK-alpha", events: text("ANSWER-ALPHA computed in fork") },
      { match: "CHILD-TASK-bravo", events: text("ANSWER-BRAVO computed in fork") },
    ])
    const stream = new RecordingStream()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: ENABLE,
          maxTurns: 6,
        }),
      ),
      20_000,
      "spawn-batch-fanout",
    )

    expect(out.reason).toBe("completed")

    // GROUND TRUTH #1 — BOTH real child loops forked and ran (each routed turn
    // fired between the parent's spawn and finish turns).
    expect(llm.log).toContain("CHILD-TASK-alpha")
    expect(llm.log).toContain("CHILD-TASK-bravo")
    expect(llm.log).not.toContain("UNMATCHED")
    // The parent forked BEFORE either child could route.
    expect(llm.log.indexOf("PARENT-GO")).toBeLessThan(llm.log.indexOf("CHILD-TASK-alpha"))
    expect(llm.log.indexOf("PARENT-GO")).toBeLessThan(llm.log.indexOf("CHILD-TASK-bravo"))

    // GROUND TRUTH #2 — the aggregated batch result came back to the PARENT as a
    // single spawn_batch tool_result carrying the summary + BOTH child answers.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr[0].content).toContain("batch complete: 2/2 ok")
    // Per-item summary lines carry each child's final-text head (index-ordered).
    expect(tr[0].content).toContain("ANSWER-ALPHA")
    expect(tr[0].content).toContain("ANSWER-BRAVO")
    expect(tr[0].is_error).toBeUndefined() // ok:true ⇒ no error flag

    // GROUND TRUTH #3 — the parent completed on its own final assistant turn.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-DONE all children back")
  })

  test("CONTROL: gate OFF (enableBatchSpawn omitted) ⇒ spawn_batch absent from the registry (non-vacuous)", async () => {
    // Triple default-OFF (ADR-0436): without `enableBatchSpawn:true`,
    // `buildSubagentBatchBlock` returns [] so the tool never reaches the
    // ToolRegistry. The parent's identical spawn_batch call therefore hits the
    // dispatch "Unknown tool" deny — NO child ever forks. This discriminates the
    // positive test: the fan-out is real only because the gate minted the tool.
    __resetRuntimeConfig()
    const llm = new RoutingLLM([
      {
        match: "PARENT-GO",
        events: spawnBatchCall("b1", {
          items: ["alpha", "bravo"],
          prompt_template: "CHILD-TASK-{{item}} do the subtask",
        }),
        once: true,
      },
      // The tool is absent ⇒ dispatch yields "Unknown tool: spawn_batch"; the
      // parent recovers from that deny and finishes.
      { match: "Unknown tool: spawn_batch", events: text("PARENT-SAW-DENY") },
      // Sentinels: NO child may ever route (the tool never forked anything).
      { match: "CHILD-TASK-alpha", events: text("ILLEGAL-ALPHA") },
      { match: "CHILD-TASK-bravo", events: text("ILLEGAL-BRAVO") },
    ])

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          // maxDepth wired but enableBatchSpawn deliberately OMITTED ⇒ tool OFF.
          subagent: { maxDepth: 1, taskRegistry: new TaskRegistry() },
          maxTurns: 6,
        }),
      ),
      15_000,
      "spawn-batch-gate-off",
    )

    expect(out.reason).toBe("completed")
    // No child ever forked (the tool was never in the registry).
    expect(llm.log).not.toContain("CHILD-TASK-alpha")
    expect(llm.log).not.toContain("CHILD-TASK-bravo")
    expect(llm.log).not.toContain("ILLEGAL-ALPHA")
    expect(llm.log).not.toContain("ILLEGAL-BRAVO")
    // The parent saw the registry-level "Unknown tool" deny.
    expect(llm.log).toContain("Unknown tool: spawn_batch")
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") {
      expect(tr[0].content).toContain("Unknown tool: spawn_batch")
    }
  })

  test("partial-failure isolation: one child exhausts its per-item turn budget ⇒ 1/2 ok, the OTHER child still succeeds", async () => {
    // A batch with `max_turns:1` per worker: the FAILING child only ever emits a
    // tool_use (never finishing within its 1-turn budget) ⇒ runner returns
    // reason:"max_turns" ⇒ that item is `error`; the SUCCEEDING child finishes
    // in one turn ⇒ `ok`. Pins the isolation invariant end-to-end: one worker
    // failing never stops the rest, and the aggregate is `1/2 ok` (still ok:true
    // because not ALL failed).
    __resetRuntimeConfig()
    const llm = new RoutingLLM([
      {
        match: "PARENT-GO",
        events: spawnBatchCall("b1", {
          items: ["good", "bad"],
          prompt_template: "WORKER-{{item}} run",
          max_turns: 1,
        }),
        once: true,
      },
      { match: "batch complete", events: text("PARENT-DONE-PARTIAL") },
      // The "good" worker finishes in one turn ⇒ ok.
      { match: "WORKER-good", events: text("GOOD-WORKER-DONE") },
      // The "bad" worker only ever emits a tool_use ⇒ never satisfies its
      // 1-turn budget ⇒ max_turns ⇒ error (but isolated from the good one).
      {
        match: "WORKER-bad",
        events: [
          { type: "tool_use_start", id: "r", name: "read" },
          { type: "tool_use_end", id: "r", input: { path: "/tmp/__nope_batch__.txt" } },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
      },
    ])

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: ENABLE,
          maxTurns: 6,
        }),
      ),
      20_000,
      "spawn-batch-partial-failure",
    )

    expect(out.reason).toBe("completed")
    // Both real children ran (the failing one still forked; it just didn't finish).
    expect(llm.log).toContain("WORKER-good")
    expect(llm.log).toContain("WORKER-bad")
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    // Aggregate: exactly one ok, one failed — partial-failure isolation held.
    expect(tr[0].content).toContain("batch complete: 1/2 ok, 1 failed")
    expect(tr[0].content).toContain("GOOD-WORKER-DONE")
    // Not all failed ⇒ the batch itself is ok (no is_error flag).
    expect(tr[0].is_error).toBeUndefined()
  })
})
