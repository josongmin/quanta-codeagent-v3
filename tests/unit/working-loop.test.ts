import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * Proves the loop now routes its in-session history through the
 * `WorkingMemory` slice (RFC §6.3): seed messages, appended assistant turns,
 * appended tool-result turns, and compaction-replaced history all flow through
 * the canonical buffer, and `runAgent` outcome.messages still reflects the
 * final buffer exactly as before. FakeLLM pattern is duplicated locally on
 * purpose (no cross-test imports).
 */

/** Records every StreamInput it receives and replays scripts in order. */
class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  calls = 0
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    this.calls += 1
    for (const ev of script) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "working-loop-perm-state-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("loop routes history through WorkingMemory", () => {
  test("seed message flows into the first LLM request unchanged", async () => {
    const llm = new RecordingLLM([textScript("done")])
    const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "seed ask" }] }]
    const out = await runAgent(cfg({ llm, messages: seed }))

    expect(out.reason).toBe("completed")
    const first = llm.inputs[0]
    expect(first).toBeDefined()
    // The canonical buffer was seeded from config.messages: the seed user
    // text is the head of the request the LLM saw.
    const head = first?.messages[0]
    const headText =
      head?.role === "user"
        ? head.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        : ""
    expect(headText).toContain("seed ask")
  })

  test("config.messages seed is not mutated; outcome reflects the final buffer", async () => {
    const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "start" }] }]
    const llm = new RecordingLLM([textScript("final reply")])
    const out = await runAgent(cfg({ llm, messages: seed }))

    expect(out.reason).toBe("completed")
    // WorkingMemory was constructed defensively from config.messages: the
    // caller's array stays length 1, untouched by appends.
    expect(seed).toHaveLength(1)
    // outcome.messages is the final canonical buffer: seed + assistant turn.
    expect(out.messages.length).toBeGreaterThanOrEqual(2)
    expect(out.messages[0]).toEqual(seed[0] as Message)
    const last = out.messages.at(-1)
    expect(last?.role).toBe("assistant")
    const lastText = last?.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(lastText).toBe("final reply")
  })

  test("appended assistant + tool-result turns accumulate in the buffer across turns", async () => {
    const llm = new RecordingLLM([
      toolUseScript("c1", "read", { path: "/tmp/__nope_working_loop__.txt" }),
      textScript("wrapped up"),
    ])
    const out = await runAgent(cfg({ llm }))

    expect(out.reason).toBe("completed")
    // Buffer grew across the two turns: seed user, assistant tool_use,
    // user tool_result, final assistant text.
    const roles = out.messages.map((m) => m.role)
    expect(roles).toEqual(["user", "assistant", "user", "assistant"])
    // The tool_result turn (appended via wm.append) is present.
    const resultMsg = out.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    expect(resultMsg).toBeDefined()
    // The second LLM request saw the appended history (>1 message).
    expect(llm.inputs[1]?.messages.length ?? 0).toBeGreaterThan(1)
  })

  test("compaction-replaced history flows through the buffer (wm.replace)", async () => {
    const big = "x".repeat(8000)
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: big }] },
      { role: "assistant", content: [{ type: "text", text: "older turn 1" }] },
      { role: "user", content: [{ type: "text", text: "more" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn 2" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ]
    // [0] summary call, [1] the actual turn after compaction.
    const llm = new RecordingLLM([textScript("SUMMARY OF HISTORY"), textScript("final answer")])
    const out = await runAgent(
      cfg({
        llm,
        messages: history,
        compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
      }),
    )

    expect(out.reason).toBe("completed")
    // After wm.replace(compacted), the turn LLM call sees the synthetic
    // summary as the buffer head.
    const turnInput = llm.inputs[1]
    const firstBlock = turnInput?.messages[0]?.content[0]
    expect(firstBlock?.type).toBe("text")
    if (firstBlock?.type === "text") {
      expect(firstBlock.text).toContain("<conversation summary>")
      expect(firstBlock.text).toContain("SUMMARY OF HISTORY")
    }
    // The final outcome buffer also begins with the compacted summary, proving
    // the replace landed in the canonical WorkingMemory (not a stale copy).
    const outHead = out.messages[0]?.content[0]
    expect(outHead?.type).toBe("text")
    if (outHead?.type === "text") expect(outHead.text).toContain("<conversation summary>")
    // The original caller-supplied history array is untouched (defensive copy).
    expect(history).toHaveLength(5)
    expect((history[0]?.content[0] as { text: string }).text).toBe(big)
  })
})
