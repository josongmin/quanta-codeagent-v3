import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig, GlobRule } from "@/agent"
import { HookBus, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Tool, ToolContext } from "@/tool"
import { ToolRegistry } from "@/tool"

/**
 * End-to-end loop closure for the two Cursor-gap absorptions, driven through
 * the REAL `runAgent` loop with a scripted LLM (no provider). These prove the
 * loop WIRING — not just the unit seams:
 *   - Feature A (glob rules): a configured `globRules` + matching `changedPaths`
 *     lands the rule body in the actual `StreamInput` the LLM receives.
 *   - Feature B (hooks updatedInput): a `pre_tool_use` rewrite is the input the
 *     tool actually executes, observed both at the tool and in the transcript.
 */

/** Records every StreamInput it receives; replays scripts in order (FakeLLM
 *  pattern duplicated locally on purpose — no cross-test imports). */
class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const ev of next ?? this.last) yield ev
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

/** Echo tool: records the input it RECEIVED and reflects it into its output, so
 *  a test can prove which input actually executed. */
const echoTool = (sink: { received: unknown[] }): Tool => ({
  name: "echo",
  description: "echo test tool",
  inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: (input: unknown, _ctx: ToolContext) =>
    (async function* () {
      sink.received.push(input)
      yield {
        type: "result" as const,
        result: { ok: true, output: `executed:${(input as { path: string }).path}` },
      }
    })(),
})

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry([]),
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

/** Concatenate every text block of every user message in a StreamInput — the
 *  per-turn dynamic context rides as a trailing `<system-reminder>` user msg. */
const userText = (input: StreamInput | undefined): string =>
  (input?.messages ?? [])
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
    .join("\n")

const tsRule: GlobRule = {
  sourcePath: "/repo/.cursor/rules/ts.mdc",
  globs: ["*.ts"],
  alwaysApply: false,
  body: "GLOB-RULE-TS-BODY",
}
const alwaysRule: GlobRule = {
  sourcePath: "/repo/.cursor/rules/always.mdc",
  globs: [],
  alwaysApply: true,
  body: "GLOB-RULE-ALWAYS-BODY",
}

describe("Feature A — glob rules reach the LLM through runAgent", () => {
  test("a matching changedPath injects the rule body into the LLM request", async () => {
    const llm = new RecordingLLM([textScript("done")])
    await runAgent(cfg({ llm, globRules: { rules: [tsRule], changedPaths: ["src/a.ts"] } }))
    expect(userText(llm.inputs[0])).toContain("GLOB-RULE-TS-BODY")
  })

  test("a non-matching changedPath does NOT inject the glob rule", async () => {
    const llm = new RecordingLLM([textScript("done")])
    await runAgent(cfg({ llm, globRules: { rules: [tsRule], changedPaths: ["README.md"] } }))
    expect(userText(llm.inputs[0])).not.toContain("GLOB-RULE-TS-BODY")
  })

  test("an alwaysApply rule rides regardless of changedPaths", async () => {
    const llm = new RecordingLLM([textScript("done")])
    await runAgent(cfg({ llm, globRules: { rules: [alwaysRule], changedPaths: [] } }))
    expect(userText(llm.inputs[0])).toContain("GLOB-RULE-ALWAYS-BODY")
  })

  test("absent globRules ⇒ no File-scoped rules section (byte-identical default)", async () => {
    const llm = new RecordingLLM([textScript("done")])
    await runAgent(cfg({ llm }))
    expect(userText(llm.inputs[0])).not.toContain("File-scoped rules")
  })
})

describe("Feature B — pre_tool_use updatedInput rewrites the executed input through runAgent", () => {
  test("the tool receives the REWRITTEN input, and the transcript reflects it", async () => {
    const sink = { received: [] as unknown[] }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", (e) =>
      e.name === "echo" ? { updatedInput: { path: "rewritten" } } : undefined,
    )
    const llm = new RecordingLLM([
      toolUseScript("t1", "echo", { path: "original" }),
      textScript("done"),
    ])
    const out = await runAgent(
      cfg({
        llm,
        registry: new ToolRegistry([echoTool(sink)]),
        hooks,
      }),
    )
    // 1. the tool actually executed the mutated input
    expect(sink.received).toEqual([{ path: "rewritten" }])
    // 2. the tool_result in the transcript reflects the rewrite
    const transcript = JSON.stringify(out.messages)
    expect(transcript).toContain("executed:rewritten")
    expect(transcript).not.toContain("executed:original")
  })

  test("without a hook the original input executes (byte-identical default)", async () => {
    const sink = { received: [] as unknown[] }
    const llm = new RecordingLLM([
      toolUseScript("t1", "echo", { path: "original" }),
      textScript("done"),
    ])
    await runAgent(cfg({ llm, registry: new ToolRegistry([echoTool(sink)]) }))
    expect(sink.received).toEqual([{ path: "original" }])
  })

  test("a denying hook blocks execution entirely (tool never runs)", async () => {
    const sink = { received: [] as unknown[] }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked by policy" }))
    const llm = new RecordingLLM([
      toolUseScript("t1", "echo", { path: "original" }),
      textScript("done"),
    ])
    const out = await runAgent(cfg({ llm, registry: new ToolRegistry([echoTool(sink)]), hooks }))
    expect(sink.received).toEqual([])
    expect(JSON.stringify(out.messages)).toContain("Hook denied: blocked by policy")
  })
})
