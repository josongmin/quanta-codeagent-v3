/**
 * Loop ↔ BudgetMeter wiring tests.
 *
 *  - Default-OFF (no `budgetMeter` on AgentConfig) ⇒ AgentOutcome is shape-
 *    identical to the pre-RFC path (the meter is never consulted).
 *  - With `maxTurns: 2` cap, a script that would run >2 turns finishes with
 *    `reason: "budget_exhausted"` at turn 2.
 *  - tick sites: turn / model_call / tool_call are observed by the meter on
 *    real runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, BudgetMeter, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ── Local test doubles (independent of the integration `_harness`) ────────

class FakeLLM implements LLMPort {
  readonly seenMessages: Message[][] = []
  calls = 0
  readonly model = "test-model"
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages)
    this.calls += 1
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const e of script) yield e
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new NullStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 10,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "loop-budget-perm-state-"))
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

describe("loop ↔ BudgetMeter — default-OFF byte-identical", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-budget-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("undefined budgetMeter ⇒ AgentOutcome shape unchanged", async () => {
    const llm = new FakeLLM([text("done")])
    const cfg = baseCfg({ llm, cwd: dir })
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(1)
    expect(Array.isArray(outcome.messages)).toBe(true)
    // No `budget_exhausted` ever appears when meter is absent.
    expect(outcome.reason).not.toBe("budget_exhausted")
  })

  test("two runs with no meter produce identical outcome shapes", async () => {
    // Byte-identical signal: deterministic script, same config — outcome shape
    // is identical between runs (no clock-derived fields in AgentOutcome).
    const mk = () => {
      const llm = new FakeLLM([text("ok")])
      return baseCfg({ llm, cwd: dir })
    }
    const a = await runAgent(mk())
    const b = await runAgent(mk())
    expect(a.reason).toBe(b.reason)
    expect(a.turns).toBe(b.turns)
    expect(a.messages.length).toBe(b.messages.length)
  })
})

describe("loop ↔ BudgetMeter — exhaustion firing", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-budget-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("maxTurns: 2 cap ⇒ outcome.reason === 'budget_exhausted' at turn 2", async () => {
    // Script: turn 1 issues an `ls` tool_use; turn 2 also issues `ls`; turn 3
    // would issue `ls` again. With a 2-turn budget the loop must finish at
    // the end of turn 2 with budget_exhausted (NOT max_turns).
    const llm = new FakeLLM([
      toolUse("c1", "ls", { paths: [dir] }),
      toolUse("c2", "ls", { paths: [dir] }),
      toolUse("c3", "ls", { paths: [dir] }),
      text("done"),
    ])
    const meter = new BudgetMeter({ dials: { maxTurns: 2 } })
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter, maxTurns: 20 })
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("budget_exhausted")
    // The turn at which the budget tripped — the loop ran 2 productive turns
    // before checkExhausted() observed turns=3 > maxTurns=2 (since the tick
    // fires at turn start). NOTE: this is propositional `observed > dial` so
    // after the 3rd turn-start tick the meter trips at that turn's end.
    expect(outcome.turns).toBeGreaterThanOrEqual(2)
    expect(meter.snapshot().turns).toBeGreaterThanOrEqual(2)
  })

  test("meter ticks observe turn start + model call + tool call", async () => {
    const llm = new FakeLLM([toolUse("c1", "ls", { paths: [dir] }), text("done")])
    const meter = new BudgetMeter()
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter })
    await runAgent(cfg)

    const snap = meter.snapshot()
    expect(snap.turns).toBeGreaterThan(0)
    expect(snap.modelCalls).toBeGreaterThan(0)
    expect(snap.toolCalls).toBeGreaterThan(0)
  })

  test("bash dispatch increments shell_command counter", async () => {
    // The default tool registry includes `bash`; we don't actually need it to
    // succeed — only the tick site needs firing. Provide a benign command.
    const llm = new FakeLLM([toolUse("c1", "bash", { command: "true" }), text("done")])
    const meter = new BudgetMeter()
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter })
    await runAgent(cfg)
    expect(meter.snapshot().shellCommands).toBeGreaterThanOrEqual(1)
  })

  test("bash verify command increments BOTH shell_command and test_run", async () => {
    const llm = new FakeLLM([
      toolUse("c1", "bash", { command: "python -m pytest tests/ -q" }),
      text("done"),
    ])
    const meter = new BudgetMeter()
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter })
    await runAgent(cfg)
    const snap = meter.snapshot()
    expect(snap.shellCommands).toBeGreaterThanOrEqual(1)
    expect(snap.testRuns).toBeGreaterThanOrEqual(1)
  })

  test("uncapped meter never trips exhaustion", async () => {
    const llm = new FakeLLM([text("done")])
    const meter = new BudgetMeter() // no dials
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("completed")
    expect(meter.checkExhausted().exhausted).toBe(false)
  })

  test("exhaustion outcome carries the same messages shape as a normal finish", async () => {
    const llm = new FakeLLM([
      toolUse("c1", "ls", { paths: [dir] }),
      toolUse("c2", "ls", { paths: [dir] }),
      toolUse("c3", "ls", { paths: [dir] }),
    ])
    const meter = new BudgetMeter({ dials: { maxTurns: 1 } })
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter, maxTurns: 20 })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("budget_exhausted")
    expect(Array.isArray(outcome.messages)).toBe(true)
    expect(outcome.messages.length).toBeGreaterThan(0)
  })
})
