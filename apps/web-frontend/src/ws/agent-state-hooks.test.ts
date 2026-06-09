import { describe, expect, it } from "vitest"
import { EMPTY_AGENT_STATE } from "../components/AgentStatePanel"
import type {
  AgentStateMessage,
  AgentStatePlan,
  AgentStateTodo,
  ContextCompactedMessage,
  ModeChangedMessage,
  PlanCreatedMessage,
  PlanInputRequestedMessage,
  PlanInputResolvedMessage,
  PlanSnapshotMessage,
  PlanUpdatedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
} from "../types/protocol"
import {
  type AgentStateSource,
  agentStateReducer,
  EMPTY_FULL_AGENT_STATE,
  isContextCompactedMsg,
  isModeChangedMsg,
  isPlanCreatedMsg,
  isPlanInputRequestedMsg,
  isPlanInputResolvedMsg,
  isPlanSnapshotMsg,
  isPlanUpdatedMsg,
  isRatelimitSnapshotMsg,
  isToolProgressMsg,
} from "./agent-state-hooks"

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const samplePlan = (over: Partial<AgentStatePlan> = {}): AgentStatePlan => ({
  id: "p1",
  name: "Plan",
  version: 1,
  todos: [
    { id: "t1", title: "first", status: "pending" },
    { id: "t2", title: "second", status: "in_progress" },
  ],
  ...over,
})

const planCreated = (plan = samplePlan()): PlanCreatedMessage => ({
  kind: "plan.created",
  plan,
  emittedAt: 0,
})

const planSnapshot = (plan = samplePlan()): PlanSnapshotMessage => ({
  kind: "plan.snapshot",
  plan,
  emittedAt: 0,
})

const planUpdated = (delta: PlanUpdatedMessage["delta"], version: number): PlanUpdatedMessage => ({
  kind: "plan.updated",
  delta,
  version,
  emittedAt: 0,
})

const modeChanged = (to: ModeChangedMessage["to"]): ModeChangedMessage => ({
  kind: "mode.changed",
  from: "default",
  to,
  emittedAt: 0,
})

const toolProgress = (toolCallId: string, message: string): ToolProgressMessage => ({
  kind: "tool.progress",
  toolCallId,
  toolName: "Bash",
  message,
  emittedAt: 0,
})

const compacted = (summary: string, tokens: number): ContextCompactedMessage => ({
  kind: "context.compacted",
  fromTurnId: "a",
  toTurnId: "b",
  summary,
  ts: 0,
  tokens,
  emittedAt: 0,
})

const ratelimit = (requestsRemaining: number): RatelimitSnapshotMessage => ({
  kind: "ratelimit.snapshot",
  requestsRemaining,
  observedAt: 0,
  emittedAt: 0,
})

const inputRequested = (promptId: string): PlanInputRequestedMessage => ({
  kind: "plan.input.requested",
  promptId,
  prompt: "Proceed?",
  emittedAt: 0,
})

const inputResolved = (promptId: string): PlanInputResolvedMessage => ({
  kind: "plan.input.resolved",
  promptId,
  decision: "answer",
  emittedAt: 0,
})

/** Reduce a sequence of frames from the empty baseline. */
const reduceAll = (msgs: readonly AgentStateMessage[]) =>
  msgs.reduce((s, msg) => agentStateReducer(s, { type: "message", msg }), EMPTY_FULL_AGENT_STATE)

/* ------------------------------------------------------------------ */
/* Per-kind predicates — the load-bearing routing the reducer switches  */
/* on. Mirrors `canvas-hooks.test.ts`: test the helpers directly so a    */
/* drift narrows here, not in a copy.                                   */
/* ------------------------------------------------------------------ */

describe("agent-state kind filters", () => {
  it("each predicate narrows exactly its own kind", () => {
    const cases: [(m: AgentStateMessage) => boolean, AgentStateMessage][] = [
      [isPlanCreatedMsg, planCreated()],
      [isPlanSnapshotMsg, planSnapshot()],
      [isPlanUpdatedMsg, planUpdated({ kind: "plan_renamed", toName: "x" }, 2)],
      [isPlanInputRequestedMsg, inputRequested("q1")],
      [isPlanInputResolvedMsg, inputResolved("q1")],
      [isModeChangedMsg, modeChanged("plan")],
      [isToolProgressMsg, toolProgress("c1", "hi")],
      [isContextCompactedMsg, compacted("s", 1)],
      [isRatelimitSnapshotMsg, ratelimit(5)],
    ]
    // Every predicate matches its own fixture and rejects all others.
    for (const [pred, own] of cases) {
      expect(pred(own)).toBe(true)
      for (const [, other] of cases) {
        if (other.kind !== own.kind) expect(pred(other)).toBe(false)
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/* Empty baseline                                                      */
/* ------------------------------------------------------------------ */

describe("agentStateReducer — empty baseline", () => {
  it("EMPTY_FULL_AGENT_STATE extends EMPTY_AGENT_STATE with plan:null", () => {
    expect(EMPTY_FULL_AGENT_STATE.plan).toBeNull()
    expect(EMPTY_FULL_AGENT_STATE.mode).toBe(EMPTY_AGENT_STATE.mode)
    expect(EMPTY_FULL_AGENT_STATE.toolProgress.size).toBe(0)
    expect(EMPTY_FULL_AGENT_STATE.compaction).toBeNull()
    expect(EMPTY_FULL_AGENT_STATE.ratelimit).toBeNull()
    expect(EMPTY_FULL_AGENT_STATE.planPrompt).toBeNull()
  })

  it("reset returns the empty baseline", () => {
    const dirty = agentStateReducer(EMPTY_FULL_AGENT_STATE, {
      type: "message",
      msg: modeChanged("plan"),
    })
    expect(agentStateReducer(dirty, { type: "reset" })).toBe(EMPTY_FULL_AGENT_STATE)
  })

  it("an unrecognised kind is a no-op (state by reference)", () => {
    const bogus = { kind: "totally.unknown", emittedAt: 0 } as unknown as AgentStateMessage
    expect(agentStateReducer(EMPTY_FULL_AGENT_STATE, { type: "message", msg: bogus })).toBe(
      EMPTY_FULL_AGENT_STATE,
    )
  })
})

/* ------------------------------------------------------------------ */
/* Per-kind folds (latest-wins)                                        */
/* ------------------------------------------------------------------ */

describe("agentStateReducer — mode.changed", () => {
  it("latest mode wins", () => {
    const s = reduceAll([modeChanged("plan"), modeChanged("default")])
    expect(s.mode).toBe("default")
  })
})

describe("agentStateReducer — tool.progress", () => {
  it("latest-wins per toolCallId, keeps distinct calls", () => {
    const s = reduceAll([
      toolProgress("c1", "step 1"),
      toolProgress("c2", "other"),
      toolProgress("c1", "step 2"),
    ])
    expect(s.toolProgress.size).toBe(2)
    expect(s.toolProgress.get("c1")?.message).toBe("step 2")
    expect(s.toolProgress.get("c2")?.message).toBe("other")
  })

  it("preserves insertion order", () => {
    const s = reduceAll([toolProgress("c1", "a"), toolProgress("c2", "b")])
    expect([...s.toolProgress.keys()]).toEqual(["c1", "c2"])
  })
})

describe("agentStateReducer — context.compacted", () => {
  it("projects to the {summary,tokens} marker, latest-wins", () => {
    const s = reduceAll([compacted("old", 1), compacted("new", 9)])
    expect(s.compaction).toEqual({ summary: "new", tokens: 9 })
  })
})

describe("agentStateReducer — ratelimit.snapshot", () => {
  it("latest snapshot wins", () => {
    const s = reduceAll([ratelimit(10), ratelimit(3)])
    expect(s.ratelimit?.requestsRemaining).toBe(3)
  })
})

describe("agentStateReducer — plan.input lifecycle", () => {
  it("requested sets the prompt; matching resolve clears it", () => {
    const s = reduceAll([inputRequested("q1"), inputResolved("q1")])
    expect(s.planPrompt).toBeNull()
  })

  it("a stale resolve (different promptId) does NOT clear a fresh prompt", () => {
    const s = reduceAll([inputRequested("q2"), inputResolved("q1")])
    expect(s.planPrompt?.promptId).toBe("q2")
  })

  it("a resolve with no outstanding prompt is a no-op", () => {
    const s = reduceAll([inputResolved("q1")])
    expect(s.planPrompt).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Plan axis (snapshot + delta fold)                                   */
/* ------------------------------------------------------------------ */

describe("agentStateReducer — plan snapshot + delta", () => {
  it("plan.created seeds the live plan", () => {
    const s = reduceAll([planCreated()])
    expect(s.plan?.id).toBe("p1")
    expect(s.plan?.todos).toHaveLength(2)
  })

  it("plan.snapshot replaces the plan wholesale", () => {
    const s = reduceAll([
      planCreated(),
      planSnapshot(samplePlan({ name: "Fresh", todos: [], version: 7 })),
    ])
    expect(s.plan?.name).toBe("Fresh")
    expect(s.plan?.todos).toHaveLength(0)
    expect(s.plan?.version).toBe(7)
  })

  it("plan.updated folds a delta onto the live plan and bumps version", () => {
    const s = reduceAll([
      planCreated(),
      planUpdated({ kind: "todo_status_changed", todoId: "t1", toStatus: "completed" }, 2),
    ])
    expect(s.plan?.version).toBe(2)
    expect(s.plan?.todos.find((t: AgentStateTodo) => t.id === "t1")?.status).toBe("completed")
  })

  it("plan.updated before any snapshot is a no-op (plan stays null)", () => {
    const s = reduceAll([planUpdated({ kind: "plan_renamed", toName: "x" }, 2)])
    expect(s.plan).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Source routing — proves a source feeds frames into the fold. A tiny  */
/* manual harness (no React renderer; test env is `node`). Mirrors the  */
/* CanvasSource routing block in `canvas-hooks.test.ts`.                */
/* ------------------------------------------------------------------ */

describe("AgentStateSource routing", () => {
  const makeSource = () => {
    let handler: ((m: AgentStateMessage) => void) | null = null
    const source: AgentStateSource = {
      subscribe(h) {
        handler = h
        return () => {
          handler = null
        }
      },
    }
    return { source, emit: (m: AgentStateMessage) => handler?.(m) }
  }

  it("an empty source leaves the empty baseline view", () => {
    const { source } = makeSource()
    let state = EMPTY_FULL_AGENT_STATE
    const off = source.subscribe((msg) => {
      state = agentStateReducer(state, { type: "message", msg })
    })
    off()
    expect(state).toBe(EMPTY_FULL_AGENT_STATE)
  })

  it("routes a mixed frame sequence into every axis", () => {
    const { source, emit } = makeSource()
    let state = EMPTY_FULL_AGENT_STATE
    const off = source.subscribe((msg) => {
      state = agentStateReducer(state, { type: "message", msg })
    })
    emit(modeChanged("plan"))
    emit(toolProgress("c1", "working"))
    emit(compacted("done", 42))
    emit(ratelimit(7))
    emit(inputRequested("q1"))
    emit(planCreated())
    off()
    expect(state.mode).toBe("plan")
    expect(state.toolProgress.get("c1")?.message).toBe("working")
    expect(state.compaction).toEqual({ summary: "done", tokens: 42 })
    expect(state.ratelimit?.requestsRemaining).toBe(7)
    expect(state.planPrompt?.promptId).toBe("q1")
    expect(state.plan?.id).toBe("p1")
  })
})
