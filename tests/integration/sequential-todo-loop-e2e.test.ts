/**
 * "a 끝나면 b, b 끝나면 c" — does the REAL agent loop actually carry a
 * sequential multi-step instruction to completion? (ADR-0219 / ADR-0095)
 *
 * This drives the production `runAgent` loop with a SCRIPTED `LLMPort` and
 * answers three DISTINCT, deterministic questions the focus-chain unit/hellgate
 * tests do NOT touch:
 *
 *   (1) HARNESS CARRY-THROUGH — if the model emits a→b→c tool calls across
 *       turns, the loop runs every step in order and terminates `completed`
 *       only AFTER c. (The harness doesn't drop steps the model drives.)
 *
 *   (2) NO ENFORCEMENT (the honest negative) — if the model does a and then
 *       emits a no-tool-use turn with b,c still pending, the loop TERMINATES.
 *       b,c never run. Nothing in the harness forces the next step. Sequencing
 *       is the model's job; the loop only re-shows state.
 *
 *   (3) FOCUS-CHAIN AUTO-REINJECT IS INERT IN THE REAL WIRING — wire the
 *       focusChain slot (reinjectEveryN=2) AND planStore, let the model call
 *       create_plan + work several turns, and assert the "## Focus Chain —
 *       Todos" block NEVER appears in the transcript: NOTHING in production
 *       bridges the plan tool → `focusChain.tracker.setTodos`, so the Claude-
 *       Code-parity re-injection is dead unless something calls setTodos.
 *       The paired control (manually feeding setTodos) proves the assertion
 *       has teeth — fed, the block DOES appear.
 *
 * DETERMINISTIC: scripted LLM, real read tool over temp files, no network.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import { defaultFocusChainTracker } from "@/agent/focus-chain"
import { createInMemoryPlanStore } from "@/agent/plan/state"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ── scripted doubles (same shape as browser-agent-loop-e2e) ──────────────────

const tu = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const txt = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

class ScriptedLLM implements LLMPort {
  readonly model = "scripted-test-model"
  calls = 0
  private last: StreamEvent[] = []
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    this.calls += 1
    for (const e of next ?? this.last) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

// ── temp fixture files for the a/b/c work steps ──────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "seq-todo-"))
const fileA = join(dir, "a.txt")
const fileB = join(dir, "b.txt")
const fileC = join(dir, "c.txt")
writeFileSync(fileA, "STEP-A-CONTENT")
writeFileSync(fileB, "STEP-B-CONTENT")
writeFileSync(fileC, "STEP-C-CONTENT")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface RunOpts {
  readonly planStore?: ReturnType<typeof createInMemoryPlanStore>
  readonly focusChain?: NonNullable<AgentConfig["focusChain"]>
  readonly maxTurns?: number
}

const run = async (
  scripts: StreamEvent[][],
  opts: RunOpts = {},
): Promise<{ outcome: Awaited<ReturnType<typeof runAgent>>; stream: RecordingStream }> => {
  const stream = new RecordingStream()
  const cfg = {
    registry: new ToolRegistry(defaultTools),
    stream,
    permission: { mode: "default" },
    messages: [
      { role: "user", content: [{ type: "text", text: "do a then b then c" }] },
    ] as Message[],
    system: "test-system",
    cwd: dir,
    maxTurns: opts.maxTurns ?? 12,
    signal: new AbortController().signal,
    llm: new ScriptedLLM(scripts),
    onConfirm: async () => true,
    ...(opts.planStore ? { planStore: opts.planStore } : {}),
    ...(opts.focusChain ? { focusChain: opts.focusChain } : {}),
  } as unknown as AgentConfig
  const outcome = await runAgent(cfg)
  return { outcome, stream }
}

const dispatchedReads = (s: RecordingStream): string[] =>
  s.events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .filter((e) => e.name === "read")
    .map((e) => e.name)

const transcriptText = (outcome: Awaited<ReturnType<typeof runAgent>>): string =>
  outcome.messages
    .flatMap((m) => m.content)
    .map((b) =>
      b.type === "text"
        ? b.text
        : b.type === "tool_result"
          ? typeof b.content === "string"
            ? b.content
            : JSON.stringify(b.content)
          : "",
    )
    .join("\n")

const read = (id: string, path: string) => tu(id, "read", { path })

// ── (1) harness carry-through ────────────────────────────────────────────────

describe("sequential a→b→c through the real loop — CARRY-THROUGH", () => {
  test("model drives a→b→c: all three steps run in order, completes only after c", async () => {
    const { outcome, stream } = await run([
      read("a", fileA),
      read("b", fileB),
      read("c", fileC),
      txt("done"),
    ])

    expect(outcome.reason).toBe("completed")
    expect(dispatchedReads(stream).length).toBe(3)

    // The three steps' content round-tripped through the loop IN ORDER.
    const t = transcriptText(outcome)
    const iA = t.indexOf("STEP-A-CONTENT")
    const iB = t.indexOf("STEP-B-CONTENT")
    const iC = t.indexOf("STEP-C-CONTENT")
    expect(iA).toBeGreaterThanOrEqual(0)
    expect(iB).toBeGreaterThan(iA)
    expect(iC).toBeGreaterThan(iB)
  })
})

// ── (2) NO enforcement — model can bail mid-chain ────────────────────────────

describe("sequential a→b→c through the real loop — NO ENFORCEMENT", () => {
  test("model stops after a (b,c pending): loop terminates, b,c NEVER run", async () => {
    const { outcome, stream } = await run([
      read("a", fileA),
      txt("I'll stop here"), // model bails with b,c "remaining"
    ])

    expect(outcome.reason).toBe("completed")
    // Only a ran. The harness did NOT force b or c.
    expect(dispatchedReads(stream).length).toBe(1)
    const t = transcriptText(outcome)
    expect(t).toContain("STEP-A-CONTENT")
    expect(t).not.toContain("STEP-B-CONTENT")
    expect(t).not.toContain("STEP-C-CONTENT")
  })
})

// ── (3) focus-chain auto-reinject is INERT in the real wiring ────────────────

describe("focus-chain auto-reinject — INERT unless fed", () => {
  test("model calls create_plan + works 4 turns: focus-chain block NEVER appears", async () => {
    const planStore = createInMemoryPlanStore({ now: Date.now })
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    const { outcome } = await run(
      [
        tu("p", "create_plan", {
          name: "abc",
          overview: "do a then b then c",
          todos: [{ content: "a" }, { content: "b" }, { content: "c" }],
        }),
        read("a", fileA),
        read("b", fileB),
        read("c", fileC),
        txt("done"),
      ],
      { planStore, focusChain: { tracker, reinjectEveryN: 2 } },
    )

    expect(outcome.reason).toBe("completed")
    // The model DID author a plan (planStore got it; todos is a Record).
    expect(Object.keys(planStore.current()?.todos ?? {}).length).toBe(3)
    // ...yet the focus-chain re-injection NEVER fired: nothing bridges the
    // plan tool → tracker.setTodos, so the tracker stayed empty across 5 turns
    // (it would have injected at turns 2 and 4 had it any todos).
    expect(transcriptText(outcome)).not.toContain("## Focus Chain — Todos")
    expect(tracker.snapshotTodos().length).toBe(0)
  })

  test("PAIRED CONTROL — when setTodos IS fed, the block DOES re-appear (teeth)", async () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    tracker.setTodos([
      { text: "a", state: "in-progress" },
      { text: "b", state: "pending" },
    ])
    const { outcome } = await run(
      [read("a", fileA), read("b", fileB), read("c", fileC), txt("done")],
      { focusChain: { tracker, reinjectEveryN: 2 } },
    )

    expect(outcome.reason).toBe("completed")
    // Fed → the loop seam splices the block (proves test (3) isn't vacuously green).
    expect(transcriptText(outcome)).toContain("## Focus Chain — Todos")
  })
})
