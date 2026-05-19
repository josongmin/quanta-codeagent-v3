import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { loadSession, runAgent, saveSession } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

describe("session state persistence", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-state-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("save → load round trip preserves sessionId and messages", async () => {
    const path = join(dir, "session.json")
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]
    await saveSession(path, { sessionId: "s-42", messages, reason: "completed", turns: 2 })
    const loaded = await loadSession(path)
    expect(loaded).not.toBeNull()
    expect(loaded?.sessionId).toBe("s-42")
    expect(loaded?.messages).toEqual(messages)
  })

  test("missing file → null", async () => {
    const loaded = await loadSession(join(dir, "nope.json"))
    expect(loaded).toBeNull()
  })

  test("corrupt file → null (never throws)", async () => {
    const path = join(dir, "bad.json")
    writeFileSync(path, "{ this is not json")
    const loaded = await loadSession(path)
    expect(loaded).toBeNull()
  })

  test("valid JSON but wrong shape → null", async () => {
    const path = join(dir, "wrong.json")
    writeFileSync(path, JSON.stringify({ foo: "bar" }))
    const loaded = await loadSession(path)
    expect(loaded).toBeNull()
  })

  // C5 closure (not a vacuity): a real runAgent → saveSession → loadSession
  // round trip. The run completes via malformed-tool exhaustion; pre-fix the
  // loop dropped the final assistant turn from AgentOutcome.messages, so the
  // persisted session lost it and resume started missing the model's last
  // turn. Post-fix the final assistant turn survives the persist/resume.
  test("runAgent (malformed-exhausted) → save → load keeps the final assistant turn", async () => {
    class ScriptedLLM implements LLMPort {
      calls = 0
      private readonly scripts: StreamEvent[][]
      constructor(scripts: StreamEvent[][]) {
        this.scripts = scripts
      }
      async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        this.calls += 1
        const script = this.scripts.shift() ?? []
        for (const evn of script) yield evn
      }
    }
    class RecordingStream implements StreamPort {
      readonly events: AgentEvent[] = []
      emit(event: AgentEvent): void {
        this.events.push(event)
      }
    }
    // Two "tool_use" stops with ZERO tool blocks: nudge once, then
    // completed-via-exhaustion with a final assistant text turn.
    const llm = new ScriptedLLM([
      [
        { type: "text_delta", delta: "malformed once" },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "the genuinely final answer" },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
    ])
    const config: AgentConfig = {
      llm,
      registry: new ToolRegistry(defaultTools),
      stream: new RecordingStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      system: "test",
      cwd: dir,
      maxTurns: 2,
      signal: new AbortController().signal,
      onConfirm: async () => false,
    }
    const outcome = await runAgent(config)
    expect(outcome.reason).toBe("completed")

    const path = join(dir, "resume.json")
    await saveSession(path, {
      sessionId: "c5-resume",
      messages: outcome.messages,
      reason: outcome.reason,
      turns: outcome.turns,
    })
    const loaded = await loadSession(path)
    expect(loaded).not.toBeNull()
    const last = loaded?.messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(
      last?.content.some((b) => b.type === "text" && b.text === "the genuinely final answer"),
    ).toBe(true)
  })
})
