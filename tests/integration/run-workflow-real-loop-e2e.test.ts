/**
 * DOF-21 REAL-LOOP proof for `run-workflow` (§25.1, gate QUANTA_WORKFLOW /
 * `config.subagent.enableWorkflow`).
 *
 * STALE/WEAK EXCERPT REPLACED — `tests/unit/workflow/workflow-e2e-hellgate.test.ts`
 * drives `runWorkflow(...)` with a `scriptedAgent` FAKE `AgentRunPort` that never
 * forks a real agent loop:
 *
 *     const scriptedAgent = (byLabel) => ({
 *       async run(req) { calls.push(req); return { ok: true, text: byLabel[req.label] ?? "{}" } }
 *     })
 *     const r = await runWorkflow(wf, { agentRun: fake, ... })
 *
 * That proves the engine's phase/threading arithmetic, but it BYPASSES the whole
 * production wire: it never registers the `run_workflow` TOOL, never enables the
 * `QUANTA_WORKFLOW` gate through `buildSubagentBlock` (`config.subagent.enableWorkflow`),
 * and never routes a workflow `agent` step through the REAL
 * `subagentRunnerToAgentRunPort(createSubagentRunner(config))` — i.e. a real forked
 * `runAgent` child loop. `runAgent × run_workflow == 0`.
 *
 * WHAT THIS DRIVES (the real seam, end-to-end):
 *   A SCRIPTED `LLMPort` issues a `run_workflow` tool_use from the TOP-LEVEL
 *   `runAgent` loop. Because `config.subagent = { enableWorkflow: true }`,
 *   `buildSubagentBlock` registers the tool wired to
 *   `subagentRunnerToAgentRunPort(createSubagentRunner(config), { depth: 1 })`.
 *   The tool compiles the spec and drives it: EACH workflow `agent` step forks a
 *   REAL child `runAgent` whose seed prompt IS the step prompt and whose model is
 *   the SAME scripted `llm`. The child's final assistant text becomes the step
 *   value; the tool returns a summary the PARENT loop surfaces as a tool_result.
 *
 *   We route the one scripted LLM by a per-step marker in the latest user text
 *   (the fork-e2e idiom) so parent / step-1 / step-2 turns are deterministic.
 *
 * GROUND TRUTH (non-vacuous): each step's child loop MUST actually stream (its
 * routed marker appears in the LLM log) and its answer MUST round-trip into the
 * parent's `run_workflow` tool_result summary. A fake that skipped the fork would
 * leave the step markers UNMATCHED and the summary empty.
 *
 * PAIRED CONTROL (gate OFF ⇒ behavior fails): with `enableWorkflow` OMITTED the
 * `run_workflow` tool is NOT registered, so the parent's tool_use resolves to a
 * dispatch "Unknown tool: run_workflow" error, NO step child ever forks (the step
 * markers never appear in the LLM log), and NO workflow summary is produced. This
 * is the byte-identical default-OFF path — it proves the gate, not some ambient
 * mechanism, is what makes the workflow execute.
 */

import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A single `run_workflow` tool call carrying a 2-phase spec: phase A runs
 *  step-1, phase B runs step-2. Each step is one real forked subagent. */
const runWorkflowCall = (id: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "run_workflow" },
  {
    type: "tool_use_end",
    id,
    input: {
      phases: [
        { name: "PhaseA", steps: [{ id: "step-one", prompt: "STEP1-MARKER analyze the input" }] },
        { name: "PhaseB", steps: [{ id: "step-two", prompt: "STEP2-MARKER synthesize the result" }] },
      ],
    },
  },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** All conversation text (robust against the ephemeral trailing reminder tail),
 *  matching the subagent-fork-e2e routing idiom. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

/** Routes each turn by a substring against the conversation; `once` rules fire
 *  a single time then fall through to the next rule with the same match. */
class RoutingLLM implements LLMPort {
  readonly model = "workflow-routing-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (!rule) {
      this.log.push(`UNMATCHED:${txt.slice(0, 50)}`)
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

describe("run-workflow — REAL runAgent loop dispatches run_workflow; steps fork real subagents", () => {
  test("gate ON: parent run_workflow drives 2 real forked step loops; answers round-trip to the summary", async () => {
    const llm = new RoutingLLM([
      // Parent root turn: author + dispatch the declarative workflow.
      { match: "PARENT-GO", events: runWorkflowCall("wf1"), once: true },
      // After the workflow summary tool_result returns, the parent finishes.
      { match: "workflow complete", events: text("parent done with workflow") },
      // Each workflow step is a REAL forked child loop, seeded on its step prompt.
      { match: "STEP1-MARKER", events: text("STEP1-ANSWER from the first forked step") },
      { match: "STEP2-MARKER", events: text("STEP2-ANSWER from the second forked step") },
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          // GATE ON — enableWorkflow registers `run_workflow` wired to the REAL
          // subagent runner. maxDepth headroom so the depth-1 step children fork.
          subagent: { enableWorkflow: true, maxDepth: 3 },
          maxTurns: 8,
        }),
      ),
      20_000,
      "run-workflow-on",
    )

    expect(out.reason).toBe("completed")

    // Both workflow STEP CHILD LOOPS actually forked + streamed (ground truth:
    // a fake that skipped the fork would never route these markers).
    expect(llm.log).toContain("STEP1-MARKER")
    expect(llm.log).toContain("STEP2-MARKER")
    expect(llm.log).not.toContain("UNMATCHED")
    // Phase ordering: step-1 forked before step-2 (sequential phases).
    expect(llm.log.indexOf("STEP1-MARKER")).toBeLessThan(llm.log.indexOf("STEP2-MARKER"))

    // The parent got exactly ONE run_workflow tool_result, and it reports a
    // COMPLETE run over 2 phases / 2 agent runs (real fork count, not a stub).
    const tr = toolResults(out)
    expect(tr).toHaveLength(1)
    const summary = tr[0]?.content ?? ""
    expect(summary).toContain("workflow complete")
    expect(summary).toContain("2 phases")
    expect(summary).toContain("2 agent runs")
    expect(summary).toContain("step-one")
    expect(summary).toContain("step-two")
    expect(tr[0]?.is_error).toBeUndefined()

    // Parent then completed with its own final assistant turn.
    const finalText = (out.messages.findLast((m) => m.role === "assistant")?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("parent done with workflow")
  })

  test("PAIRED CONTROL: gate OFF (enableWorkflow omitted) ⇒ run_workflow NOT registered; no step forks, no summary", async () => {
    const llm = new RoutingLLM([
      // The parent tries the SAME workflow call...
      { match: "PARENT-GO", events: runWorkflowCall("wf1"), once: true },
      // ...but the tool is unknown, so dispatch returns an error tool_result;
      // the parent recovers on seeing the unknown-tool text and finishes.
      { match: "Unknown tool", events: text("parent recovered from missing workflow tool") },
      // These step markers MUST NEVER route — no child ever forks when the gate
      // is off (regression sentinels).
      { match: "STEP1-MARKER", events: text("STEP1-LEAKED") },
      { match: "STEP2-MARKER", events: text("STEP2-LEAKED") },
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          // GATE OFF — subagent block present (so `agent` etc. still exist) but
          // enableWorkflow OMITTED ⇒ run_workflow is NOT in the registry.
          subagent: { maxDepth: 3 },
          maxTurns: 8,
        }),
      ),
      20_000,
      "run-workflow-off",
    )

    expect(out.reason).toBe("completed")

    // The workflow never executed: NO step child forked.
    expect(llm.log).not.toContain("STEP1-MARKER")
    expect(llm.log).not.toContain("STEP2-MARKER")
    expect(llm.log).not.toContain("STEP1-LEAKED")
    expect(llm.log).not.toContain("STEP2-LEAKED")

    // The parent's tool_result is an UNKNOWN-TOOL error, not a workflow summary.
    const tr = toolResults(out)
    expect(tr).toHaveLength(1)
    expect(tr[0]?.is_error).toBe(true)
    expect(tr[0]?.content ?? "").toContain("Unknown tool")
    expect(tr[0]?.content ?? "").toContain("run_workflow")
    // Definitively no workflow ran.
    expect(tr[0]?.content ?? "").not.toContain("workflow complete")
  })
})
