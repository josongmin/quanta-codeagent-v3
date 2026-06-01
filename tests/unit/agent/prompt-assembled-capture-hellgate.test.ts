/**
 * Track D hellgate — runtime → REPL context wire, the loop CAPTURE side.
 *
 * Pins:
 *  - Default-OFF: when `onPromptAssembled` is ABSENT the loop performs NO
 *    capture (the hook is never called — there is no other observable, which is
 *    exactly the byte-identical contract) and the AgentOutcome shape is
 *    unchanged. Regression anchor for the assembly path.
 *  - When PRESENT, the hook fires ONCE per turn with a snapshot whose
 *    reconstructed sections sum to the breakdown total computed by the loop's
 *    OWN estimator (`buildUsageBreakdownDefault`). The captured `model` is the
 *    configured model id.
 *  - A THROWING observer never crashes the turn (observation-only, like
 *    `onProgress`): the turn still completes and an `error` event is emitted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import {
  buildUsageBreakdownDefault,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
} from "@/agent/context/usage-breakdown"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class FakeLLM implements LLMPort {
  calls = 0
  readonly model = "test-model"
  private readonly script: StreamEvent[]
  constructor(script: StreamEvent[]) {
    this.script = script
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    for (const e of this.script) yield e
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const done: StreamEvent[] = [
  { type: "text_delta", delta: "ok" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new NullStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "system-prompt-body",
  cwd: "/tmp",
  maxTurns: 4,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permRoot: string | null = null
let dir: string

beforeEach(() => {
  permRoot = mkdtempSync(join(tmpdir(), "prompt-capture-perm-"))
  process.env.QUANTA_PERMISSION_STATE = join(permRoot, "permission-state.json")
  dir = mkdtempSync(join(tmpdir(), "prompt-capture-"))
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permRoot !== null) rmSync(permRoot, { recursive: true, force: true })
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  permRoot = null
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("Track D loop capture — default-OFF byte-identical", () => {
  test("absent onPromptAssembled ⇒ outcome completes, no capture observable", async () => {
    const llm = new FakeLLM(done)
    const outcome = await runAgent(baseCfg({ llm, cwd: dir }))
    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(1)
    expect(Array.isArray(outcome.messages)).toBe(true)
  })

  test("present hook fires once per turn with a non-empty snapshot", async () => {
    const llm = new FakeLLM(done)
    const captured: PromptAssembledSnapshot[] = []
    const outcome = await runAgent(
      baseCfg({ llm, cwd: dir, onPromptAssembled: (s) => captured.push(s) }),
    )
    expect(outcome.reason).toBe("completed")
    expect(captured.length).toBe(1)
    const snap = captured[0]
    expect(snap).toBeDefined()
    if (snap === undefined) return
    expect(snap.system.length).toBeGreaterThan(0)
    expect(snap.model).toBe("test-model")
    // A single-`system`-string config takes the single_block layout.
    expect(snap.layout).toBe("single_block")
  })

  test("captured snapshot's sections sum to the breakdown total (loop's own estimator)", async () => {
    const llm = new FakeLLM(done)
    let snap: PromptAssembledSnapshot | undefined
    await runAgent(baseCfg({ llm, cwd: dir, onPromptAssembled: (s) => (snap = s) }))
    expect(snap).toBeDefined()
    if (snap === undefined) return
    const breakdown = buildUsageBreakdownDefault(snapshotToBreakdownInput(snap))
    const sum = breakdown.segments.reduce((a, s) => a + s.tokens, 0)
    expect(breakdown.total).toBe(sum)
    expect(breakdown.total).toBeGreaterThan(0)
    // The base system body ("system-prompt-body") bills to System.
    expect(breakdown.segments.some((s) => s.id === "System")).toBe(true)
  })

  test("throwing observer never crashes the turn; an error event is emitted", async () => {
    const llm = new FakeLLM(done)
    const stream = new NullStream()
    const outcome = await runAgent(
      baseCfg({
        llm,
        cwd: dir,
        stream,
        onPromptAssembled: () => {
          throw new Error("boom-observer")
        },
      }),
    )
    expect(outcome.reason).toBe("completed")
    expect(
      stream.events.some(
        (e) =>
          e.type === "error" &&
          /onPromptAssembled observer threw.*boom-observer/.test(
            (e as { message: string }).message,
          ),
      ),
    ).toBe(true)
  })
})
