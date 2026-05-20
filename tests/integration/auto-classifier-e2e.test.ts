import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ClassifierPort, PermissionContext } from "@/permission"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * GAP 5 — `permission.mode === "auto"` routing a NON-readonly tool through the
 * REAL gate chain: features.ts (builds the session `AutoModeClassifier`) →
 * loop.ts (threads it) → dispatch.ts `runGates` → policy.ts `evaluateAuto` →
 * `AutoModeClassifier` 2-stage orchestration → the injected `ClassifierPort`.
 *
 * The port the session classifier wraps is `createAutoClassifierPort({ llm:
 * config.llm })`, i.e. it is driven entirely by `config.llm`. We make that a
 * DETERMINISTIC MOCK by branching on the StreamInput: a classifier request
 * (its `system` carries the threat taxonomy + a `<transcript>` user message) gets
 * a scripted XML verdict; a normal model turn gets the model script. No real
 * network, fully deterministic.
 *
 * Classifier verdict protocol (auto-classifier.ts#parseDecision):
 *   allow → `<block>no</block>`
 *   block → `<block>yes</block><reason>…</reason>`
 * 2-stage (classifier.ts): a clear stage-1 "allow" short-circuits to allow; a
 * stage-1 block escalates to stage-2 (thinking) which here also blocks ⇒ deny.
 */

const xml = (s: string): StreamEvent[] => [
  { type: "text_delta", delta: s },
  { type: "message_stop", stop_reason: "end_turn" },
]
const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const isClassifierReq = (input: StreamInput): boolean => {
  const sys = input.system
  const sysText = typeof sys === "string" ? sys : (sys ?? []).map((b) => b.text).join("")
  return sysText.includes("security monitor for autonomous AI coding agents")
}

/**
 * Routes classifier requests to `verdict()` and model turns to a positional
 * model script. Counts classifier invocations so a test can assert the port
 * was (or was NOT) consulted.
 */
class AutoLLM implements LLMPort {
  readonly model = "auto-test-model"
  classifierCalls = 0
  modelCalls = 0
  constructor(
    private readonly modelScript: StreamEvent[][],
    private readonly verdict: () => StreamEvent[],
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (isClassifierReq(input)) {
      this.classifierCalls += 1
      for (const e of this.verdict()) yield e
      return
    }
    const next = this.modelScript.shift() ?? []
    this.modelCalls += 1
    for (const e of next) yield e
  }
}

/** Truthy stub so policy.ts passes the canonical taxonomy as the classifier system
 *  prompt. The actual port used is the features-built llm-backed one — this
 *  only selects the systemPrompt string. */
const stubPort: ClassifierPort = async () => ({ verdict: "allow", reason: "stub" })

const autoPerm = (): PermissionContext => ({ mode: "auto", classify: stubPort })

describe("GAP 5 — auto-mode classifier on a non-readonly tool via runGates", () => {
  let dir: string
  const mk = () => {
    dir = mkdtempSync(join(tmpdir(), "auto-cls-"))
    return dir
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  test("allow verdict ⇒ non-readonly tool RUNS, then model completes", async () => {
    const d = mk()
    const file = join(d, "out.txt")
    const llm = new AutoLLM(
      [toolUse("w1", "write", { path: file, content: "hi" }), text("written ok")],
      () => xml("<block>no</block>"), // stage-1 clear allow ⇒ short-circuit allow
    )
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          permission: autoPerm(),
          cwd: d,
          maxTurns: 4,
        }),
      ),
      15_000,
      "auto-allow",
    )
    expect(out.reason).toBe("completed")
    expect(llm.classifierCalls).toBe(1) // fast stage allowed, no stage-2
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") expect(tr[0].is_error).toBeUndefined()
    expect(await Bun.file(file).text()).toBe("hi")
    cleanup()
  })

  test("block verdict ⇒ deny tool_result, model recovers and completes", async () => {
    const d = mk()
    const file = join(d, "blocked.txt")
    const llm = new AutoLLM(
      [toolUse("w1", "write", { path: file, content: "nope" }), text("recovered after deny")],
      // stage-1 block → escalate → stage-2 also blocks ⇒ deny.
      () => xml("<block>yes</block><reason>policy says no</reason>"),
    )
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          permission: autoPerm(),
          cwd: d,
          maxTurns: 4,
        }),
      ),
      15_000,
      "auto-block",
    )
    expect(out.reason).toBe("completed")
    expect(llm.classifierCalls).toBe(2) // fast(block) then thinking(block)
    expect(await Bun.file(file).exists()).toBe(false)
    const denied = out.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result" && b.content.includes("Permission denied")),
    )
    expect(denied).toHaveLength(1)
    if (denied[0]?.type === "tool_result") {
      expect(denied[0].is_error).toBe(true)
      expect(denied[0].content).toContain("policy says no")
    }
    cleanup()
  })

  test("HARD_DENY (rm -rf /) beats the classifier — port NOT consulted", async () => {
    const d = mk()
    const llm = new AutoLLM(
      [toolUse("b1", "bash", { command: "rm -rf /" }), text("recovered after hard deny")],
      // Would ALLOW if ever consulted — proves HARD_DENY wins before the port.
      () => xml("<block>no</block>"),
    )
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          permission: autoPerm(),
          cwd: d,
          maxTurns: 4,
        }),
      ),
      15_000,
      "auto-harddeny",
    )
    expect(out.reason).toBe("completed")
    expect(llm.classifierCalls).toBe(0) // hardDeny short-circuits before the port
    const denied = out.messages.flatMap((m) =>
      m.content.filter(
        (b) => b.type === "tool_result" && b.content.includes("Blocked dangerous command"),
      ),
    )
    expect(denied).toHaveLength(1)
    cleanup()
  })

  test("readonly tool short-circuits BEFORE the port (port not called)", async () => {
    const d = mk()
    const file = join(d, "r.txt")
    await Bun.write(file, "payload")
    const llm = new AutoLLM([toolUse("r1", "read", { path: file }), text("done reading")], () =>
      xml("<block>yes</block><reason>would block if consulted</reason>"),
    )
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          permission: autoPerm(),
          cwd: d,
          maxTurns: 4,
        }),
      ),
      15_000,
      "auto-readonly",
    )
    expect(out.reason).toBe("completed")
    expect(llm.classifierCalls).toBe(0) // isReadOnly allow precedes the port
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") {
      expect(tr[0].is_error).toBeUndefined()
      expect(tr[0].content).toContain("payload")
    }
    cleanup()
  })
})
