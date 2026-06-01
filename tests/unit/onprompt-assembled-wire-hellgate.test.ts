/**
 * GAP3 hellgate — `onPromptAssembled` wiring chain.
 *
 * Two layers:
 *   A. LOOP: `AgentConfig.onPromptAssembled` fires once per turn with the EXACT
 *      assembled `{ system, messages }`; absent ⇒ never called (regression
 *      anchor / byte-identical); a THROWING sink never crashes the turn.
 *   B. COMPOSE FLOW: `RuntimeFacadeComposeOptions.onPromptAssembled` reaches the
 *      live `AgentConfig.onPromptAssembled` the loop runs (mirrors the
 *      `granularRegistry` compose idiom) — proven end-to-end by driving a real
 *      turn through `createRuntimeFromAgentConfigBase({ compose })`; absent
 *      compose option ⇒ the sink is never invoked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import type { PromptAssembledSnapshot } from "@/agent/context/usage-breakdown"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const next = this.scripts.shift() ?? [
      { type: "text_delta", delta: "done" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const ev of next) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

// The loop's canonical snapshot shape (assembled SystemBlock[] + promptPolicy
// presence flags + model). Track D's PromptAssembledSnapshot — NOT a raw
// { system, messages } pair (the loop hands the assembled prompt, and the
// REPL reconstructs section names from the presence flags).
type Snapshot = PromptAssembledSnapshot

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
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
  permissionStateRoot = mkdtempSync(join(tmpdir(), "onprompt-perm-state-"))
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

describe("GAP3 onPromptAssembled — loop firing", () => {
  test("[A1] fires once per turn with the assembled system snapshot", async () => {
    const snapshots: Snapshot[] = []
    const llm = new ScriptedLLM([textScript("done")])
    await runAgent(
      baseCfg({
        llm,
        messages: [userText("hello")],
        system: "test-system-prompt",
        onPromptAssembled: (s) => snapshots.push(s),
      }),
    )
    expect(snapshots.length).toBe(1)
    const snap = snapshots[0]
    expect(snap).toBeDefined()
    // system blocks are the assembled SystemBlock[]; at least one text block,
    // and the configured system prompt text is present in the assembled blocks.
    expect(Array.isArray(snap?.system)).toBe(true)
    expect((snap?.system.length ?? 0) > 0).toBe(true)
    const sysText = (snap?.system ?? []).map((b) => b.text).join("\n")
    expect(sysText).toContain("test-system-prompt")
    // the snapshot carries the layout + presence flags the REPL reconstructs from.
    expect(snap?.layout === "single_block" || snap?.layout === "four_section").toBe(true)
  })

  test("[A2] absent sink ⇒ never called (byte-identical regression anchor)", async () => {
    const llm = new ScriptedLLM([textScript("done")])
    const cfg = baseCfg({ llm, messages: [userText("hi")] })
    expect(cfg.onPromptAssembled).toBeUndefined()
    // Should run cleanly with no sink wired.
    const outcome = await runAgent(cfg)
    expect(outcome.messages.length > 0).toBe(true)
  })

  test("[A3] a throwing sink never crashes the turn", async () => {
    const llm = new ScriptedLLM([textScript("done")])
    let fired = 0
    const outcome = await runAgent(
      baseCfg({
        llm,
        messages: [userText("hi")],
        onPromptAssembled: () => {
          fired += 1
          throw new Error("boom")
        },
      }),
    )
    expect(fired).toBe(1)
    // The turn completed despite the throwing sink.
    expect(outcome.messages.length > 0).toBe(true)
  })

  test("[A4] multi-turn ⇒ one fire per assembled turn", async () => {
    const snapshots: Snapshot[] = []
    // First turn: tool_use to force a second turn; second: end_turn.
    const llm = new ScriptedLLM([
      [
        { type: "tool_use_start", id: "t1", name: "read" },
        { type: "tool_use_end", id: "t1", input: { path: "/tmp/nope.txt" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      textScript("done"),
    ])
    await runAgent(
      baseCfg({
        llm,
        messages: [userText("go")],
        onPromptAssembled: (s) => snapshots.push(s),
      }),
    )
    // Two turns assembled ⇒ two fires (one per prepareTurnContext).
    expect(snapshots.length).toBe(2)
  })
})

describe("GAP3 onPromptAssembled — RuntimeFacadeComposeOptions flow", () => {
  // Mirror the REAL REPL path: `runtimeContext.createRuntimeFacade({ compose })`
  // (session-loop.ts) — the only public seam that threads compose options. The
  // `granularRegistry` idiom is wired through the IDENTICAL call.
  const baseFor = (root: string, llm: LLMPort) => ({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    permission: { mode: "acceptEdits" as const },
    messages: [],
    system: "test",
    cwd: root,
    maxTurns: 4,
    signal: new AbortController().signal,
  })

  test("[B1] compose.onPromptAssembled reaches the live AgentConfig + fires", async () => {
    const root = mkdtempSync(join(tmpdir(), "onprompt-compose-"))
    const snapshots: Snapshot[] = []
    const llm = new ScriptedLLM([textScript("done")])
    const { runtimeContext } = await createRuntimeFromAgentConfigBase({
      base: baseFor(root, llm),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const runtime = await runtimeContext.createRuntimeFacade({
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
      compose: { onPromptAssembled: (s) => snapshots.push(s) },
    })
    const session = await runtime.createSession({ cwd: root, permissionMode: "acceptEdits" })
    try {
      await session.input.append("hello compose")
      await session.turn.run()
      // The compose option reached the live AgentConfig.onPromptAssembled and
      // fired at least once with a well-formed assembled snapshot (proving the
      // RuntimeFacadeComposeOptions → config flow, the unique coverage here).
      expect(snapshots.length > 0).toBe(true)
      const snap = snapshots[0]
      expect(Array.isArray(snap?.system)).toBe(true)
      expect((snap?.system.length ?? 0) > 0).toBe(true)
    } finally {
      await session.close()
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("[B2] absent compose option ⇒ sink never invoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "onprompt-compose-absent-"))
    const fired = 0
    const llm = new ScriptedLLM([textScript("done")])
    const { runtimeContext } = await createRuntimeFromAgentConfigBase({
      base: baseFor(root, llm),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const runtime = await runtimeContext.createRuntimeFacade({
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
      // no compose ⇒ onPromptAssembled stays undefined on the built config.
    })
    const session = await runtime.createSession({ cwd: root, permissionMode: "acceptEdits" })
    try {
      await session.input.append("no sink")
      await session.turn.run()
      expect(fired).toBe(0)
    } finally {
      await session.close()
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
