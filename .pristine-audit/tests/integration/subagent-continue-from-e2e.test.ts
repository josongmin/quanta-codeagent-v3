import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * Round 3 — E2E: `continue_from` warm-starts a fresh subagent with a prior
 * task's `finalText` PREPENDED above the new prompt as a "## Previous attempt"
 * block. The agent-tool resolves the id against its TaskRegistry; the runner
 * (subagent-runner#buildSeedPrompt) injects `priorAttempt` into the child's
 * seed user-message.
 *
 * The load-bearing assertions are:
 *   (1) two children actually ran in order (first produces a finalText, second
 *       receives that text in its seed as a "## Previous attempt" block);
 *   (2) unknown ids are a recoverable deny tool_result (runner never invoked);
 *   (3) a STOPPED task with no retained finalText is also a recoverable deny.
 *
 * Pattern follows subagent-fork-e2e.test.ts and subagent-cancellation-e2e.test.ts.
 */

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const toolCall = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** All conversation text — robust against the trailing `<system-reminder>`. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/** Latest task_id + owner_token (S17) seen in any tool_result body — used by
 *  the parent to chain `task_output` / `continue_from` / `task_stop` against
 *  the live values minted by the registry. */
const findLastTaskFields = (input: StreamInput): { taskId?: string; ownerToken?: string } => {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]
    if (!m) continue
    for (const b of m.content) {
      if (b.type !== "tool_result") continue
      const taskMatch = b.content.match(/task_id: (\S+)/)
      const ownerMatch = b.content.match(/owner_token: (\S+)/)
      if (taskMatch?.[1] || ownerMatch?.[1]) {
        return {
          ...(taskMatch?.[1] ? { taskId: taskMatch[1] } : {}),
          ...(ownerMatch?.[1] ? { ownerToken: ownerMatch[1] } : {}),
        }
      }
    }
  }
  return {}
}

const rewriteTaskId = (
  e: StreamEvent,
  fields: { taskId?: string; ownerToken?: string },
): StreamEvent => {
  if (e.type !== "tool_use_end") return e
  const inp = (e as { input?: unknown }).input
  if (!inp || typeof inp !== "object") return e
  const rec = inp as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = { ...rec }
  if (fields.taskId !== undefined && rec.task_id === "__PLACEHOLDER__") {
    out.task_id = fields.taskId
    changed = true
  }
  if (fields.taskId !== undefined && rec.continue_from === "__PLACEHOLDER__") {
    out.continue_from = fields.taskId
    changed = true
  }
  // S17: owner_token capability gate for task_stop.
  if (fields.ownerToken !== undefined && rec.owner_token === "__PLACEHOLDER__") {
    out.owner_token = fields.ownerToken
    changed = true
  }
  return changed ? { ...e, input: out } : e
}

class RoutingLLM implements LLMPort {
  readonly model = "routing-test-model"
  log: string[] = []
  observations: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    this.observations.push(txt)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (!rule) {
      this.log.push(`UNMATCHED:${txt.slice(0, 80)}`)
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(rule.match)
    for (const e of rule.events) yield e
  }
}

describe("subagent continue_from — e2e prior attempt threaded into child seed", () => {
  test("two-spawn warm-start chain: child2 seed PREPENDS `## Previous attempt` with child1's finalText", async () => {
    const llm = new RoutingLLM([
      // Parent turn 1: spawn first child (background) so we can poll for its
      // finalText. The first child runs to completion under its own marker.
      {
        match: "PARENT-GO",
        events: toolCall("a1", "agent", {
          prompt: "FIRST-TASK GO inspect alpha",
          background: true,
        }),
        once: true,
      },
      // Parent turn 2: after the launch tool_result carrying `task_id`, block
      // on task_output to surface the child's finalText.
      {
        match: "Subagent launched in background. task_id:",
        events: toolCall("o1", "task_output", {
          task_id: "__PLACEHOLDER__",
          block: true,
        }),
        once: true,
      },
      // Parent turn 3: spawn second child WITH `continue_from` referencing the
      // first child's id. The agent-tool resolves the registry entry and threads
      // `priorAttempt = FIRST-ATTEMPT findings: X` into the runner's req.
      {
        match: "FIRST-ATTEMPT findings: X",
        events: toolCall("a2", "agent", {
          prompt: "SECOND-TASK continue using prior",
          continue_from: "__PLACEHOLDER__",
        }),
        once: true,
      },
      // Parent turn 4: after second child's summary returns, finish.
      { match: "SECOND-CHILD-DONE", events: text("PARENT-DONE") },

      // First child's only turn — produces the finalText the second child will warm-start from.
      { match: "FIRST-TASK GO", events: text("FIRST-ATTEMPT findings: X"), once: true },
      // Second child's first turn — routes on the prepended block marker. If
      // this rule fires it PROVES `buildSeedPrompt` injected
      // `## Previous attempt's findings\nFIRST-ATTEMPT findings: X` above the
      // new prompt. Acceptance string includes both the heading and the prior text.
      {
        match: "## Previous attempt's findings\nFIRST-ATTEMPT findings: X",
        events: text("SECOND-CHILD-DONE warm-started from prior"),
        once: true,
      },
      // Guard: if the second child saw its prompt WITHOUT the prepend, this
      // bare-prompt rule would fire and surface the regression.
      { match: "SECOND-TASK continue using prior", events: text("SECOND-CHILD-MISSING-PRIOR") },
    ])

    // Substitute __PLACEHOLDER__ task ids on tool_use_end events with the live
    // task_id from the most recent tool_result in the parent transcript.
    const origStream = llm.stream.bind(llm)
    llm.stream = async function* (input: StreamInput): AsyncIterable<StreamEvent> {
      const lastTaskFields = findLastTaskFields(input)
      for await (const e of origStream(input)) {
        yield rewriteTaskId(e, lastTaskFields)
      }
    }

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 8,
        }),
      ),
      15_000,
      "subagent-continue-from-warm-start",
    )

    expect(out.reason).toBe("completed")

    // Both children ran, in order. The second child's load-bearing rule (the
    // prepended block) fired — direct proof the warm-start reached the runner.
    expect(llm.log).toContain("FIRST-TASK GO")
    expect(llm.log).toContain("## Previous attempt's findings\nFIRST-ATTEMPT findings: X")
    expect(llm.log.indexOf("FIRST-TASK GO")).toBeLessThan(
      llm.log.indexOf("## Previous attempt's findings\nFIRST-ATTEMPT findings: X"),
    )
    expect(llm.log).not.toContain("SECOND-CHILD-MISSING-PRIOR")
    expect(llm.log).not.toContain("SECOND-TASK continue using prior")
    expect(llm.log.some((l) => l.startsWith("UNMATCHED"))).toBe(false)

    // Direct observation: the second child's first-turn conversation text
    // contains BOTH the prepended block AND the new `## Current task` header
    // followed by the new prompt — exactly the layout buildSeedPrompt produces.
    const secondChildSeedTurn = llm.observations.find(
      (t) =>
        t.includes("## Previous attempt's findings") &&
        t.includes("FIRST-ATTEMPT findings: X") &&
        t.includes("## Current task") &&
        t.includes("SECOND-TASK continue using prior"),
    )
    expect(secondChildSeedTurn).toBeDefined()

    // Parent completed with the scripted final text.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-DONE")
  })

  test("unknown continue_from ⇒ recoverable deny; runner never invoked", async () => {
    const llm = new RoutingLLM([
      // Parent turn 1: attempt to warm-start from an id that does NOT exist
      // in the registry. The agent-tool refuses without ever calling the runner.
      {
        match: "PARENT-GO",
        events: toolCall("a1", "agent", {
          prompt: "would-warm-start-but-cannot",
          continue_from: "task_does_not_exist",
        }),
        once: true,
      },
      // Parent turn 2: after deny tool_result, recover and finish via the
      // "unknown" marker (the agent-tool's deny message includes "unknown").
      { match: "unknown", events: text("PARENT-RECOVERED-FROM-DENY") },

      // GUARD: if the runner DID get invoked despite the deny, the would-be
      // child's seed would contain `would-warm-start-but-cannot`. This rule
      // would fire and surface the regression.
      { match: "would-warm-start-but-cannot", events: text("CHILD-RAN-ILLEGALLY") },
    ])

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "subagent-continue-from-unknown",
    )

    expect(out.reason).toBe("completed")

    // Recovery path fired, runner never invoked.
    expect(llm.log).toContain("PARENT-GO")
    expect(llm.log).toContain("unknown")
    expect(llm.log).not.toContain("would-warm-start-but-cannot")
    expect(llm.log).not.toContain("CHILD-RAN-ILLEGALLY")

    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-RECOVERED-FROM-DENY")

    // The deny tool_result is `ok:false` with a body that mentions the unknown id.
    const denyTR = out.messages.flatMap((m) =>
      m.content.filter(
        (b) => b.type === "tool_result" && b.content.toLowerCase().includes("unknown"),
      ),
    )
    expect(denyTR.length).toBeGreaterThan(0)
  })

  test("continue_from a STOPPED task ⇒ deny (no retained finalText)", async () => {
    const llm = new RoutingLLM([
      // Parent turn 1: spawn a background child we'll never let finish.
      {
        match: "PARENT-GO",
        events: toolCall("a1", "agent", {
          prompt: "DOOMED-TASK never finishes",
          background: true,
        }),
        once: true,
      },
      // Parent turn 2: stop it immediately so it transitions to status:stopped
      // with no retained finalText.
      {
        match: "Subagent launched in background. task_id:",
        events: toolCall("s1", "task_stop", {
          task_id: "__PLACEHOLDER__",
          owner_token: "__PLACEHOLDER__",
        }),
        once: true,
      },
      // Parent turn 3: now try to continue_from the stopped id. Should be a deny.
      {
        match: "Stopped task",
        events: toolCall("a2", "agent", {
          prompt: "second-task-would-warm-start",
          continue_from: "__PLACEHOLDER__",
        }),
        once: true,
      },
      // Parent turn 4: recover from the deny and finish.
      { match: "unknown", events: text("PARENT-RECOVERED-FROM-STOPPED-DENY"), once: true },

      // The DOOMED child loop: keep spinning via a deterministic read against a
      // nonexistent path. Without this fallback the child could finish via the
      // unmatched-fallback text and produce a finalText we don't want.
      {
        match: "DOOMED-TASK",
        events: toolCall("d1", "read", { path: "/tmp/does-not-exist-marker" }),
      },
      // Guard: a deny that string-matched "unknown" should NOT trip the doomed
      // child's runner. (Defensive — placed below the higher-priority rules.)
      {
        match: "second-task-would-warm-start",
        events: text("SECOND-CHILD-RAN-DESPITE-DENY"),
      },
    ])

    const origStream = llm.stream.bind(llm)
    llm.stream = async function* (input: StreamInput): AsyncIterable<StreamEvent> {
      const lastTaskFields = findLastTaskFields(input)
      for await (const e of origStream(input)) {
        yield rewriteTaskId(e, lastTaskFields)
      }
    }

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 10,
        }),
      ),
      15_000,
      "subagent-continue-from-stopped",
    )

    expect(out.reason).toBe("completed")

    // The deny path fired; the second child never actually ran.
    expect(llm.log).toContain("PARENT-GO")
    expect(llm.log).toContain("Stopped task")
    expect(llm.log).toContain("unknown")
    expect(llm.log).not.toContain("SECOND-CHILD-RAN-DESPITE-DENY")
    expect(llm.log).not.toContain("second-task-would-warm-start")

    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-RECOVERED-FROM-STOPPED-DENY")
  })
})
