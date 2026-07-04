import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { StreamEvent, StreamInput } from "@/llm"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { ToolRegistry } from "@/tool"

type LLMPort = import("@/llm").LLMPort

class StreamingStubLLM implements LLMPort {
  readonly model = "stub-model"

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "po" }
    yield { type: "text_delta", delta: "ng" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("web-daemon runtime factory", () => {
  test("interactive turn assembler preserves the runtime turn stream override", async () => {
    const abort = new AbortController()
    const base = {
      llm: new StreamingStubLLM(),
      registry: new ToolRegistry([]),
      stream: new StdoutStream(),
      permission: { mode: "default" as const },
      messages: [],
      system: "system",
      cwd: "/tmp/quanta-web-daemon",
      maxTurns: 8,
      signal: abort.signal,
    }

    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler: buildInteractiveTurnAssembler(),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const session = await runtime.createSession({ cwd: base.cwd, permissionMode: "default" })

    const seen: string[] = []
    const off = session.subscribe((event) => {
      seen.push(event.type)
    })

    await session.input.append("ping")
    const turn = await session.turn.run()

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.state.updated",
      "turn.llm.request",
      "turn.output.delta",
      "turn.output.delta",
      "turn.completed",
      "session.state.updated",
    ])
    expect(seen).toContain("turn.llm.request")
    expect(seen).toContain("turn.output.delta")
    expect((await session.snapshot()).state.lastAssistantText).toBe("pong")

    off()
    await session.close()
    await runtime.close()
  })

  // SECURITY GUARD (jun-10): the daemon's `session.permission.set` can switch to
  // `bypass`/`acceptEdits` (allow-capable modes). Those are only SAFE if the HITL
  // gate is enabled, so `hand-off-required` ⇒ DENY and `always-confirm` ⇒ ask
  // EVEN under bypass (CLI parity). This pins that the production base sets it —
  // the permission e2e suites mirror this flag, so if it were removed they would
  // pass falsely while the real daemon blanket-allowed every tool under bypass.
  test("the production runtime base ENABLES the HITL gate (bypass cannot blanket-allow)", () => {
    const src = readFileSync(join(import.meta.dir, "../../../../src/apps/web-daemon/runtime-factory.ts"), "utf8")
    expect(src).toMatch(/hitl:\s*\{\s*enabled:\s*true\s*\}/)
  })

  test("the production runtime base publishes the interactive prompt surface profile", () => {
    const src = readFileSync(join(import.meta.dir, "../../../../src/apps/web-daemon/runtime-factory.ts"), "utf8")
    expect(src).toMatch(/promptSurfaceProfile:\s*promptSurfaceProfileForRunMode\("interactive"\)/)
  })
})
