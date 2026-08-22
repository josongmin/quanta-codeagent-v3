/**
 * E2E HELLGATE — feature H17: thread-goal BUDGET ENFORCEMENT, driven through
 * the REAL `runAgent` loop.
 *
 * The objective idle-continuation fires at the loop's compaction-recovery
 * sites: after a PTL-driven reactive compaction the loop re-issues
 * `config.objective.setNextActions(...)` to nudge the model back onto its
 * goal. H17 makes this a HARD GATE: when `QUANTA_OBJECTIVE_BUDGET_ENFORCE=1`
 * AND the active objective has exhausted its `ObjectiveBudget` (the store
 * derives `status === "budget_limited"`), the loop must NOT re-issue the
 * continuation — a budget-exhausted goal does not auto-resume.
 *
 * Proven here, end-to-end:
 *   1. Knob ON + budget exhausted ⇒ the reactive site does NOT call
 *      setNextActions (continuation suppressed) and the objective surfaces
 *      `budget_limited`.
 *   2. Knob OFF ⇒ the loop calls setNextActions exactly as today
 *      (byte-identical idle-continuation) and the status stays `active`.
 *   3. Knob ON but budget UNDER the cap ⇒ continuation still fires (the gate
 *      only suppresses the EXHAUSTED case).
 *
 * Harness mirrors `tests/unit/loop-reactive-compaction-emit-hellgate.test.ts`
 * (the canonical reactive-compaction driver): a scripted PTL throw → summary →
 * final-answer script forces exactly one reactive compaction per run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { Objective, ObjectivePort } from "@/objective"
import { createObjectiveStore } from "@/objective"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig, LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── House fakes (mirror loop-reactive-compaction-emit-hellgate) ──────────

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  calls = 0
  readonly model = "scripted-test-model"
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const e of step.events) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Wraps a real ObjectivePort, counting `setNextActions` invocations so the
 *  e2e can assert whether the loop's idle-continuation fired. */
class SpyObjectivePort implements ObjectivePort {
  setNextActionsCalls = 0
  lastNextActions: readonly string[] | undefined
  constructor(private readonly inner: ObjectivePort) {}
  set: ObjectivePort["set"] = (t, i) => this.inner.set(t, i)
  get: ObjectivePort["get"] = (t) => this.inner.get(t)
  updateStatus: ObjectivePort["updateStatus"] = (t, s) => this.inner.updateStatus(t, s)
  addBlocker: ObjectivePort["addBlocker"] = (t, b) => this.inner.addBlocker(t, b)
  clearBlocker: ObjectivePort["clearBlocker"] = (t, b) => this.inner.clearBlocker(t, b)
  setNextActions: ObjectivePort["setNextActions"] = (t, a) => {
    this.setNextActionsCalls += 1
    this.lastNextActions = a
    return this.inner.setNextActions(t, a)
  }
  markCriterion: ObjectivePort["markCriterion"] = (t, c, m) => this.inner.markCriterion(t, c, m)
  recordUsage: ObjectivePort["recordUsage"] = (t, u) => this.inner.recordUsage(t, u)
  markUsageLimited: ObjectivePort["markUsageLimited"] = (t, until) =>
    this.inner.markUsageLimited(t, until)
  list: ObjectivePort["list"] = () => this.inner.list()
  toSnapshot: ObjectivePort["toSnapshot"] = () => this.inner.toSnapshot()
  fromSnapshot: ObjectivePort["fromSnapshot"] = (s) => this.inner.fromSnapshot(s)
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]
const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

const TID = "thread-e2e"

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
  sessionId: TID,
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** ≥2 trailing assistant turns + a summarizable prefix so `reactiveCompact`
 *  (default keepRecentTurns=2) finds a positive boundary and removes >0. */
const successHistory = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "first request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn one" }] },
  { role: "user", content: [{ type: "text", text: "second request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn two" }] },
  { role: "user", content: [{ type: "text", text: "third request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn three" }] },
  { role: "user", content: [{ type: "text", text: "current request" }] },
]

/** PTL throw → continuation summary → final answer ⇒ exactly one reactive
 *  compaction (which is the idle-continuation site). */
const oneReactiveScript = (): Step[] => [
  thr(new LLMError("400 prompt is too long for this model")),
  ev(text("<summary>resume from here</summary>")),
  ev(text("final answer after compaction")),
]

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
const originalEnforce = process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE
let permissionStateRoot: string | null = null

const setEnforce = (on: boolean): void => {
  if (on) process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = "1"
  else delete process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE
  __resetRuntimeConfig() // re-read the knob from env for this run
}

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "obj-budget-e2e-"))
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
  if (originalEnforce === undefined) delete process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE
  else process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = originalEnforce
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("E2E [H17] — budget enforcement gates the idle-continuation", () => {
  test("(1) knob ON + budget exhausted ⇒ continuation SUPPRESSED + budget_limited", async () => {
    setEnforce(true)
    const port = new SpyObjectivePort(createObjectiveStore({ enforceBudget: true }))
    port.set(TID, { goal: "do the work", budget: { maxTokens: 100 } })
    port.recordUsage(TID, { tokens: 200 }) // exhaust BEFORE the run
    const pre = port.get(TID) as Objective
    expect(pre.status).toBe("budget_limited") // store derived it

    const out = await withTimeout(
      runAgent(
        cfg({
          llm: new ScriptedLLM(oneReactiveScript()),
          stream: new RecordingStream(),
          messages: successHistory(),
          maxTurns: 2,
          objective: port,
        }),
      ),
      20_000,
      "e2e-enforce-suppress",
    )
    expect(out.reason).toBe("completed")
    // The reactive compaction ran (recovery `compact` emitted) but the
    // continuation nudge was suppressed by the H17 gate.
    expect(port.setNextActionsCalls).toBe(0)
    expect(port.get(TID)?.status).toBe("budget_limited")
  })

  test("(2) knob OFF ⇒ idle-continuation fires (byte-identical to today)", async () => {
    setEnforce(false)
    // Even an enforcing store stays informational at the loop gate when the
    // knob is OFF — but to model "today" precisely we use a default store.
    const port = new SpyObjectivePort(createObjectiveStore())
    port.set(TID, { goal: "do the work", budget: { maxTokens: 100 } })
    port.recordUsage(TID, { tokens: 200 }) // "over" the informational cap
    expect(port.get(TID)?.status).toBe("active") // never limited (knob OFF)

    const out = await withTimeout(
      runAgent(
        cfg({
          llm: new ScriptedLLM(oneReactiveScript()),
          stream: new RecordingStream(),
          messages: successHistory(),
          maxTurns: 2,
          objective: port,
        }),
      ),
      20_000,
      "e2e-off-continues",
    )
    expect(out.reason).toBe("completed")
    // Continuation fired exactly as the pre-H17 loop would.
    expect(port.setNextActionsCalls).toBeGreaterThanOrEqual(1)
    expect(port.get(TID)?.status).toBe("active")
  })

  test("(3) knob ON but UNDER the cap ⇒ continuation still fires", async () => {
    setEnforce(true)
    const port = new SpyObjectivePort(createObjectiveStore({ enforceBudget: true }))
    port.set(TID, { goal: "do the work", budget: { maxTokens: 10_000 } })
    port.recordUsage(TID, { tokens: 50 }) // well under the cap
    expect(port.get(TID)?.status).toBe("active")

    const out = await withTimeout(
      runAgent(
        cfg({
          llm: new ScriptedLLM(oneReactiveScript()),
          stream: new RecordingStream(),
          messages: successHistory(),
          maxTurns: 2,
          objective: port,
        }),
      ),
      20_000,
      "e2e-under-continues",
    )
    expect(out.reason).toBe("completed")
    expect(port.setNextActionsCalls).toBeGreaterThanOrEqual(1)
    expect(port.get(TID)?.status).toBe("active")
  })
})
