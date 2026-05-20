import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * Full-loop e2e regression for the HIGH cancellation bug. The parent's model
 * spawns a BACKGROUND subagent, then calls `task_stop` on it. The forked
 * `runAgent` running the child MUST observe the per-task AbortController
 * threaded via `req.signal` (chained into the child's loop signal in
 * `buildChildConfig`) and exit with `aborted` — proving the historical bug
 * (`agent-tool.ts#launchBackground` discarded the controller, so `task_stop`
 * flipped the registry status flag but never unwound the child) is closed.
 *
 * Design notes:
 *  - The child loop never produces an `end_turn` text on its own — it just
 *    keeps emitting tool_use calls forever (deterministic, bounded by the
 *    abort, not by maxTurns or natural completion).
 *  - The child's tool calls hit `read` against an existing file (or just a
 *    deterministic registered default tool) so the loop produces a real
 *    tool_result and proceeds to the next turn — until the abort fires.
 *  - The parent's flow is: spawn background → call `task_stop` → call
 *    `task_output` to observe `status: stopped` → finish.
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

/** All conversation text (every message, every block) — robust against the
 *  trailing `<system-reminder>` reminder block. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/** Sniff the most recent agent-tool tool_result for `task_id: <id>`. Used by
 *  the routing LLM to substitute the live task_id into scripted tool calls
 *  that reference `__PLACEHOLDER__`. Returns undefined when no tool_result
 *  carries a task_id yet (i.e. the parent's first turn). */
const findLastTaskId = (input: StreamInput): string | undefined => {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]
    if (!m) continue
    for (const b of m.content) {
      if (b.type !== "tool_result") continue
      const mt = b.content.match(/task_id: (\S+)/)
      if (mt?.[1]) return mt[1]
    }
  }
  return undefined
}

/** Replace `__PLACEHOLDER__` task_ids on tool_use_end events with the live
 *  task_id from the registry. All other events pass through unchanged. */
const rewriteTaskId = (e: StreamEvent, liveTaskId: string | undefined): StreamEvent => {
  if (!liveTaskId) return e
  if (e.type !== "tool_use_end") return e
  const inp = (e as { input?: unknown }).input
  if (!inp || typeof inp !== "object") return e
  if ((inp as { task_id?: unknown }).task_id !== "__PLACEHOLDER__") return e
  return { ...e, input: { ...(inp as Record<string, unknown>), task_id: liveTaskId } }
}

/** Routes turns by substring match. `once:true` rules fire once then are spent.
 *  When no rule matches we yield a deterministic "noop" tool_call (a `read` on
 *  a non-existing path — produces a tool_result + next turn) so an unrouted
 *  child loop CANNOT silently finish via fallback text; only the abort can
 *  unwind it. */
class RoutingLLM implements LLMPort {
  readonly model = "routing-test-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  // A monotonically-increasing counter so we can issue unique tool_use ids on
  // the fallback path.
  private fallback = 0
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (rule) {
      if (rule.once) rule.spent = true
      this.log.push(rule.match)
      for (const e of rule.events) yield e
      return
    }
    // Fallback: deterministic tool_use that keeps the loop going indefinitely.
    // Used for the child to keep spinning until abort. NOT for the parent —
    // every parent step has an explicit rule.
    this.fallback += 1
    const id = `fb${this.fallback}`
    this.log.push(`FALLBACK:${this.fallback}`)
    yield { type: "tool_use_start", id, name: "read" }
    yield { type: "tool_use_end", id, input: { path: "/tmp/does-not-exist-marker" } }
    yield { type: "message_stop", stop_reason: "tool_use" }
  }
}

describe("subagent cancellation — task_stop unwinds the forked runAgent", () => {
  test("parent spawns background child, calls task_stop, child loop exits via abort", async () => {
    const llm = new RoutingLLM([
      // Parent turn 1: spawn the background subagent.
      {
        match: "PARENT-GO",
        events: toolCall("a1", "agent", {
          prompt: "CHILD-MARK keep spinning forever",
          background: true,
        }),
        once: true,
      },
      // Parent turn 2: after the agent tool returns the task_id (visible in
      // the tool_result body), call task_stop. We route on the task_id token,
      // not on substring of the tool_result, because that's deterministic.
      {
        match: "task_id:",
        events: toolCall("s1", "task_stop", { task_id: "__PLACEHOLDER__" }),
        once: true,
      },
      // Parent turn 3: stop returned ok ⇒ call task_output to observe stopped.
      {
        match: "Stopped task",
        events: toolCall("o1", "task_output", { task_id: "__PLACEHOLDER__" }),
        once: true,
      },
      // Parent turn 4: tool_output returned status:stopped ⇒ finish.
      { match: "status: stopped", events: text("PARENT-DONE child was stopped") },
    ])

    // Wire id-rewriting into the LLM: the parent doesn't actually know the
    // task_id ahead of time, so we intercept and substitute on the fly.
    const origStream = llm.stream.bind(llm)
    llm.stream = async function* (input: StreamInput): AsyncIterable<StreamEvent> {
      const lastTaskId = findLastTaskId(input)
      for await (const e of origStream(input)) {
        yield rewriteTaskId(e, lastTaskId)
      }
    }

    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          // High enough that the child would naturally keep spinning past the
          // parent's `task_stop` — so a passing test proves the ABORT, not
          // natural termination, ended the child.
          maxTurns: 20,
        }),
      ),
      15_000,
      "subagent-cancellation-e2e",
    )

    // The parent completed cleanly (status:stopped tool_result → final text).
    expect(out.reason).toBe("completed")

    // Routing log: parent took the four scripted steps.
    expect(llm.log).toContain("PARENT-GO")
    expect(llm.log).toContain("task_id:")
    expect(llm.log).toContain("Stopped task")
    expect(llm.log).toContain("status: stopped")

    // The child's loop did spin (at least one FALLBACK turn fired before the
    // parent stopped it). Without this we couldn't claim the abort unwound a
    // *running* loop.
    const fallbackTurns = llm.log.filter((l) => l.startsWith("FALLBACK:")).length
    expect(fallbackTurns).toBeGreaterThan(0)

    // The parent's final assistant text confirms the status:stopped recovery
    // path was taken.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-DONE")

    // A tool_result with `status: stopped` is present in the parent's
    // transcript — direct e2e proof that the registry observed the stop AND
    // the child task transitioned to `stopped` (the runner exited via the
    // chained abort and the registry's `stop()` flipped the status).
    const stoppedTR = out.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result" && b.content.includes("status: stopped")),
    )
    expect(stoppedTR.length).toBeGreaterThan(0)
  })
})
