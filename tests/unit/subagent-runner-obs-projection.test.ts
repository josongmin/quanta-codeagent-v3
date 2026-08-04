import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { runAgent } from "../../src/agent/loop"
import { createSubagentRunner } from "../../src/agent/subagent-runner"
import {
  newSubagentObsAccumulator,
  projectSubagentObs,
  tappedStream,
} from "../../src/agent/subagent-runner-obs-projection"
import type { AgentConfig, AgentOutcome } from "../../src/agent/types"
import type { isGitRepo, withWorktree } from "../../src/runtime/worktree"
import { __resetRuntimeConfig } from "../../src/shared/runtime-config"
import type { AgentEvent } from "../../src/stream"
import { TaskRegistry } from "../../src/subagent"
import type { SubagentRequest } from "../../src/subagent/types"
import { ToolRegistry } from "../../src/tool"

// ---------------------------------------------------------------------------
// Fixtures — a structurally valid parent config + a fake `run` that emits the
// EXACT AgentEvents the real loop emits (`usage`, `tool_call`,
// `model_route_changed`) onto `config.stream`. When the projection gate is ON
// the runner wraps that stream with the pass-through tap, so these emits are
// what the projection reads. This is the FRONT DOOR: through the real
// `createSubagentRunner`, not the projector unit directly.
// ---------------------------------------------------------------------------

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { model: "gpt-5", stream: async function* () {} } as any,
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 17,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (over: Partial<AgentOutcome> = {}): AgentOutcome => ({
  reason: "completed",
  turns: 3,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "the answer" }] },
  ],
  ...over,
})

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

/** Fake `runAgent` that emits `events` onto the child config's stream (the tap,
 *  when ON) before returning `result`. Captures each config it saw. */
const emittingRun = (
  events: readonly AgentEvent[],
  result: AgentOutcome = outcome(),
): { run: typeof runAgent; seen: AgentConfig[] } => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    for (const e of events) c.stream.emit(e)
    return result
  }) as typeof runAgent
  return { run, seen }
}

const usage = (inputTokens: number, outputTokens: number, model = "gpt-5"): AgentEvent => ({
  type: "usage",
  inputTokens,
  outputTokens,
  model,
})

const toolCall = (name: string): AgentEvent => ({
  type: "tool_call",
  id: `${name}-1`,
  name,
  input: {},
})

const routeChanged = (fromModel: string, toModel: string): AgentEvent => ({
  type: "model_route_changed",
  fromModel,
  toModel,
  reason: "provider_error",
  routeKind: "fallback",
  at: 0,
})

// ---------------------------------------------------------------------------
// RED (gate ON): a completed subagent that spent tokens / used ≥2 models / ran
// in an owned worktree MUST surface the projected fields on its result. Before
// the projection wiring existed these assertions all fail.
// ---------------------------------------------------------------------------

describe("RFC11-1 subagent-runner obs projection — FRONT DOOR (gate ON)", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.QUANTA_SUBAGENT_OBS
    process.env.QUANTA_SUBAGENT_OBS = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.QUANTA_SUBAGENT_OBS
    else process.env.QUANTA_SUBAGENT_OBS = saved
    __resetRuntimeConfig()
  })

  test("token-spending run surfaces totalTokens + usage breakdown + totalToolUseCount", async () => {
    const { run } = emittingRun([usage(100, 40), toolCall("read"), usage(50, 10), toolCall("bash")])
    const runner = createSubagentRunner(parentConfig(), { run })
    const r = await runner(req())
    // totalTokens = (100+40) + (50+10) = 200; usage folds each bucket.
    expect(r.totalTokens).toBe(200)
    expect(r.usage).toEqual({ inputTokens: 150, outputTokens: 50 })
    expect(r.totalToolUseCount).toBe(2)
    // frameCount aliases turns.
    expect(r.frameCount).toBe(3)
    // totalDurationMs is always measured on a real run (a number, not stored).
    expect(typeof r.totalDurationMs).toBe("number")
  })

  test("a run with a route transition ⇒ modelsUsed carries BOTH models", async () => {
    const { run } = emittingRun([usage(10, 5, "gpt-5"), routeChanged("gpt-5", "claude-opus-4-8")])
    const runner = createSubagentRunner(parentConfig(), { run })
    const r = await runner(req())
    expect(r.modelsUsed).toBeDefined()
    // resolved model (gpt-5) unioned with the route models; distinct set.
    expect(new Set(r.modelsUsed)).toEqual(new Set(["gpt-5", "claude-opus-4-8"]))
  })

  test("no route transition ⇒ modelsUsed is exactly [resolvedModel]", async () => {
    const { run } = emittingRun([usage(10, 5)])
    const runner = createSubagentRunner(parentConfig(), { run })
    const r = await runner(req())
    expect(r.modelsUsed).toEqual(["gpt-5"])
  })

  test("owned-worktree run ⇒ worktreeBranch is set from the withWorktree info", async () => {
    const { run } = emittingRun([usage(10, 5)])
    const gitProbe = (async () => true) as typeof isGitRepo
    // Fake worktree wrapper mirrors the real `{ value, info }` shape, returning a
    // branch the projection surfaces (RFC-06 owned-worktree analogue).
    const wt = (async (_id: string, _repo: string, fn: (p: string) => Promise<AgentOutcome>) => ({
      value: await fn("/repo/.claude/worktrees/agent-child"),
      info: {
        worktreePath: "/repo/.claude/worktrees/agent-child",
        branch: "worktree-child",
        removed: false,
      },
    })) as unknown as typeof withWorktree
    const runner = createSubagentRunner(parentConfig(), {
      run,
      isGitRepo: gitProbe,
      withWorktree: wt,
    })
    const r = await runner(req({ isolation: "worktree" }))
    expect(r.worktreeBranch).toBe("worktree-child")
  })

  test("non-isolated run ⇒ worktreeBranch is OMITTED (not undefined literal)", async () => {
    const { run } = emittingRun([usage(10, 5)])
    const runner = createSubagentRunner(parentConfig(), { run })
    const r = await runner(req())
    expect("worktreeBranch" in r).toBe(false)
  })

  test("PROJECTED not STORED — the tap forwards every event to the parent stream verbatim", async () => {
    // The child stream is the parent stream (buildChildBase). A gate-ON run must
    // still deliver every event to the parent sink (the tap is a pure observer).
    const forwarded: AgentEvent[] = []
    const parent = parentConfig({ stream: { emit: (e) => forwarded.push(e) } })
    const events = [usage(10, 5), toolCall("read"), routeChanged("gpt-5", "claude-opus-4-8")]
    const { run } = emittingRun(events)
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    expect(forwarded).toEqual(events)
  })
})

// ---------------------------------------------------------------------------
// Gate OFF: byte-identical result. The projection fields are ENTIRELY absent —
// no frameCount, no totalDurationMs, nothing — even on a run that emitted usage /
// route / tool events. This is the default-OFF byte-identical contract.
// ---------------------------------------------------------------------------

describe("RFC11-1 subagent-runner obs projection — gate OFF byte-identical", () => {
  beforeEach(() => {
    delete process.env.QUANTA_SUBAGENT_OBS
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("gate OFF ⇒ result is EXACTLY {ok,finalText,turns,messages} — every projected field absent", async () => {
    const { run } = emittingRun([
      usage(100, 40),
      toolCall("read"),
      routeChanged("gpt-5", "claude-opus-4-8"),
    ])
    const runner = createSubagentRunner(parentConfig(), { run })
    const r = await runner(req())
    // Byte-identical: the exact legacy shape, no extra keys.
    expect(Object.keys(r).sort()).toEqual(["finalText", "messages", "ok", "turns"])
    expect(r.frameCount).toBeUndefined()
    expect(r.totalTokens).toBeUndefined()
    expect(r.totalDurationMs).toBeUndefined()
    expect(r.modelsUsed).toBeUndefined()
    expect(r.totalToolUseCount).toBeUndefined()
  })

  test("gate OFF ⇒ owned-worktree run STILL surfaces no worktreeBranch (byte-identical)", async () => {
    const { run } = emittingRun([usage(10, 5)])
    const gitProbe = (async () => true) as typeof isGitRepo
    const wt = (async (_id: string, _repo: string, fn: (p: string) => Promise<AgentOutcome>) => ({
      value: await fn("/repo/.claude/worktrees/agent-child"),
      info: { worktreePath: "/x", branch: "worktree-child", removed: false },
    })) as unknown as typeof withWorktree
    const runner = createSubagentRunner(parentConfig(), {
      run,
      isGitRepo: gitProbe,
      withWorktree: wt,
    })
    const r = await runner(req({ isolation: "worktree" }))
    expect("worktreeBranch" in r).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TaskRecord (jul-15 lineage) projection site — the projected fields must flow
// onto `TaskRecord.result` via `lineage.settle → registry.complete`. Gate ON ⇒
// present; gate OFF ⇒ the record's result is byte-identical.
// ---------------------------------------------------------------------------

/** Wire a foreground lineage: a `subagent.taskRegistry` + `onSubagentEvent`
 *  (both required for the runner to register + settle a `TaskRecord`). */
const lineageParent = (registry: TaskRegistry): AgentConfig =>
  parentConfig({
    subagent: { maxDepth: 3, taskRegistry: registry },
    // biome-ignore lint/suspicious/noExplicitAny: sink is inert for this test
    onSubagentEvent: (() => {}) as any,
  } as Partial<AgentConfig>)

describe("RFC11-1 — projection lands on TaskRecord.result (lineage)", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.QUANTA_SUBAGENT_OBS
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.QUANTA_SUBAGENT_OBS
    else process.env.QUANTA_SUBAGENT_OBS = saved
    __resetRuntimeConfig()
  })

  test("gate ON ⇒ TaskRecord.result carries the projected fields", async () => {
    process.env.QUANTA_SUBAGENT_OBS = "1"
    __resetRuntimeConfig()
    const registry = new TaskRegistry()
    const { run } = emittingRun([usage(100, 40), toolCall("read")])
    const runner = createSubagentRunner(lineageParent(registry), { run })
    await runner(req())
    const rec = registry.list()[0]
    expect(rec?.status).toBe("completed")
    expect(rec?.result?.totalTokens).toBe(140)
    expect(rec?.result?.totalToolUseCount).toBe(1)
    expect(rec?.result?.frameCount).toBe(3)
    expect(rec?.result?.modelsUsed).toEqual(["gpt-5"])
  })

  test("gate OFF ⇒ TaskRecord.result is byte-identical (no projected keys)", async () => {
    delete process.env.QUANTA_SUBAGENT_OBS
    __resetRuntimeConfig()
    const registry = new TaskRegistry()
    const { run } = emittingRun([usage(100, 40), toolCall("read")])
    const runner = createSubagentRunner(lineageParent(registry), { run })
    await runner(req())
    const rec = registry.list()[0]
    expect(rec?.result).toBeDefined()
    expect(Object.keys(rec?.result ?? {}).sort()).toEqual(["finalText", "messages", "ok", "turns"])
  })
})

// ---------------------------------------------------------------------------
// Pure projector unit — anti-vacuum: assert the FUNCTION shapes the fields, and
// omits when empty. Complements the front-door tests (which prove the WIRING).
// ---------------------------------------------------------------------------

describe("projectSubagentObs — pure shaping + omission", () => {
  test("empty accumulator + no resolved model + no branch ⇒ only frameCount + totalDurationMs", () => {
    const p = projectSubagentObs({
      turns: 5,
      resolvedModel: undefined,
      worktreeBranch: undefined,
      durationMs: 42,
      acc: newSubagentObsAccumulator(),
    })
    expect(p).toEqual({ frameCount: 5, totalDurationMs: 42 })
  })

  test("resolvedModel present but empty ⇒ modelsUsed omitted", () => {
    const p = projectSubagentObs({
      turns: 1,
      resolvedModel: "",
      worktreeBranch: undefined,
      durationMs: 1,
      acc: newSubagentObsAccumulator(),
    })
    expect("modelsUsed" in p).toBe(false)
  })

  test("usage with a reasoning split ⇒ usage.reasoningTokens present; absent split ⇒ omitted", () => {
    const withReasoning = newSubagentObsAccumulator()
    withReasoning.sawUsage = true
    withReasoning.inputTokens = 10
    withReasoning.outputTokens = 20
    withReasoning.reasoningTokens = 7
    const p1 = projectSubagentObs({
      turns: 1,
      resolvedModel: "m",
      worktreeBranch: undefined,
      durationMs: 1,
      acc: withReasoning,
    })
    expect(p1.usage).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 7 })

    const noReasoning = newSubagentObsAccumulator()
    noReasoning.sawUsage = true
    noReasoning.inputTokens = 10
    noReasoning.outputTokens = 20
    const p2 = projectSubagentObs({
      turns: 1,
      resolvedModel: "m",
      worktreeBranch: undefined,
      durationMs: 1,
      acc: noReasoning,
    })
    expect(p2.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect("reasoningTokens" in (p2.usage ?? {})).toBe(false)
  })

  test("tap accumulator folds usage/tool/route; ignores unrelated events", () => {
    const acc = newSubagentObsAccumulator()
    const sink = tappedStream({ emit: () => {} }, acc)
    sink.emit(usage(100, 40))
    sink.emit(usage(50, 10))
    sink.emit(toolCall("read"))
    sink.emit(routeChanged("a", "b"))
    sink.emit({ type: "turn_start", turn: 1 })
    sink.emit({ type: "done", reason: "completed", turns: 1 })
    expect(acc.inputTokens).toBe(150)
    expect(acc.outputTokens).toBe(50)
    expect(acc.toolCalls).toBe(1)
    expect([...acc.models].sort()).toEqual(["a", "b"])
    expect(acc.sawUsage).toBe(true)
  })
})
