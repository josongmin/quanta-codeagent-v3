import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildFakeBootstrapDeps, buildFakeRuntime, RecordingStream } from "@/apps/headless"
import { openHeadlessRuntimeSession } from "@/apps/headless/session-bridge"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { defaultTools } from "@/tool"

const root = mkdtempSync(join(tmpdir(), "headless-bootstrap-ports-"))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

const finishText = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const driftPatch = [
  "*** Begin Patch",
  "*** Update File: f.txt",
  "@@",
  " unrelated context",
  "-not-present",
  "+replacement",
  "*** End Patch",
].join("\n")

const fixedPatch = [
  "*** Begin Patch",
  "*** Update File: f.txt",
  "@@",
  "-beta",
  "+BETA",
  "*** End Patch",
].join("\n")

const lastUserText = (messages: readonly Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== "user") continue
    for (const block of message.content) {
      if (block.type === "text") return block.text
    }
  }
  return ""
}

class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0

  constructor(
    readonly model: string,
    private readonly scripts: StreamEvent[][],
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const next = this.scripts[Math.min(this.calls - 1, this.scripts.length - 1)]
    if (next === undefined) throw new Error("script exhausted")
    for (const event of next) yield event
  }
}

class FastApplyBootstrapLLM implements LLMPort {
  readonly model = "headless-fake"
  sideConversationCalls = 0
  mainCalls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const prompt = lastUserText(input.messages)
    if (prompt.startsWith("Re-emit the following change as a single V4A patch")) {
      this.sideConversationCalls += 1
      yield { type: "text_delta", delta: fixedPatch }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    this.mainCalls += 1
    if (this.mainCalls === 1) {
      yield { type: "tool_use_start", id: "apply-1", name: "apply_patch" }
      yield { type: "tool_use_end", id: "apply-1", input: { patch: driftPatch } }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const withEnvValue = async (
  key: "QUANTA_FAST_APPLY" | "QUANTA_EFFORT_AUTO",
  value: "on" | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  __resetRuntimeConfig()
  try {
    await run()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
    __resetRuntimeConfig()
  }
}

const openHeadlessBridge = async (args: {
  cwd: string
  llm: LLMPort
  stream: RecordingStream
  tools?: typeof defaultTools
}) =>
  openHeadlessRuntimeSession({
    input: {
      prompt: "go",
      cwd: args.cwd,
    },
    deps: buildFakeBootstrapDeps(args.llm, args.stream, args.tools ?? []),
    runtime: buildFakeRuntime({ cwd: args.cwd }),
    stream: args.stream,
  })

describe("headless bootstrap optional-port wire", () => {
  test("QUANTA_FAST_APPLY=on rescues anchor drift through createRuntimeFromBootstrap", async () => {
    await withEnvValue("QUANTA_FAST_APPLY", "on", async () => {
      const cwd = join(root, "fast-apply")
      mkdirSync(cwd, { recursive: true })
      writeFileSync(join(cwd, "f.txt"), "alpha\nbeta\n")
      const llm = new FastApplyBootstrapLLM()
      const stream = new RecordingStream()
      const bridge = await openHeadlessBridge({ cwd, llm, stream, tools: defaultTools })
      try {
        await bridge.session.input.append("patch the file", undefined, {
          signal: bridge.boot.abort.signal,
        })
        await bridge.session.turn.run(undefined, { signal: bridge.boot.abort.signal })
        expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
        expect(llm.sideConversationCalls).toBe(1)
      } finally {
        await bridge.session.close()
        await bridge.runtimeFacade.close()
      }
    })
  })

  test("QUANTA_EFFORT_AUTO=on escalates the first bootstrap turn to max thinking", async () => {
    await withEnvValue("QUANTA_EFFORT_AUTO", "on", async () => {
      const cwd = join(root, "effort-auto")
      mkdirSync(cwd, { recursive: true })
      const llm = new RecordingLLM("headless-fake", [finishText("done")])
      const stream = new RecordingStream()
      const bridge = await openHeadlessBridge({ cwd, llm, stream })
      try {
        await bridge.session.input.append("ultrathink this through", undefined, {
          signal: bridge.boot.abort.signal,
        })
        await bridge.session.turn.run(undefined, { signal: bridge.boot.abort.signal })
        expect(llm.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 64000 })
      } finally {
        await bridge.session.close()
        await bridge.runtimeFacade.close()
      }
    })
  })
})
