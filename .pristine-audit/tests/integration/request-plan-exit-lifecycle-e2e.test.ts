import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import { defaultFocusChainTracker } from "@/agent/focus-chain"
import { createInMemoryPlanStore } from "@/agent/plan/state"
import type { Message } from "@/llm"
import {
  cfg,
  eventsOf,
  FakeLLM,
  findEvent,
  multiToolUse,
  RecordingStream,
  text,
  toolUse,
  withTimeout,
} from "./_harness"

const toolResultTexts = (messages: readonly Message[]): string[] =>
  messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === "tool_result" ? [block.content] : [])),
  )

const messageTexts = (messages: readonly Message[]): string[] =>
  messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  )

const countTextMatches = (messages: readonly Message[], needle: string): number =>
  messageTexts(messages).filter((text) => text.includes(needle)).length

describe("request_plan_exit lifecycle e2e", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-exit-lifecycle-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("approved exits plan mode for the next turn, emits mode_changed, and allows a later write", async () => {
    const file = join(dir, "approved.txt")
    const planStore = createInMemoryPlanStore({ now: () => 1 })
    const created = planStore.create({
      name: "Ship approved patch",
      overview: "Create a plan, get approval, then edit.",
      todos: [{ content: "write the file" }],
    })
    expect(created.ok).toBe(true)
    const llm = new FakeLLM([
      toolUse("pe1", "request_plan_exit", { plan: `1. Write ${file}` }),
      toolUse("w1", "write", { path: file, content: "ok" }),
      text("done"),
    ])
    const stream = new RecordingStream()

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          cwd: dir,
          planMode: true,
          planStore,
          planExitPort: { request: async () => ({ decision: "approved" as const }) },
          maxTurns: 6,
        }),
      ),
      10_000,
      "plan-exit-approved",
    )

    expect(outcome.reason).toBe("completed")
    expect(readFileSync(file, "utf8")).toBe("ok")
    expect(findEvent(stream, "mode_changed")).toMatchObject({
      type: "mode_changed",
      from: "plan",
      to: "default",
      fromAgentMode: "plan",
      toAgentMode: "default",
      reason: "plan_exit_approved",
    })
    const snapshot = findEvent(stream, "plan_snapshot")
    expect(snapshot?.type).toBe("plan_snapshot")
    if (snapshot?.type === "plan_snapshot") {
      expect(snapshot.plan.name).toBe("Ship approved patch")
      expect(snapshot.plan.todos).toHaveLength(1)
    }
    expect(planStore.current()).toBeNull()
  })

  test("rejected clears the active PlanStore before the next turn", async () => {
    const planStore = createInMemoryPlanStore({ now: () => 1 })
    const created = planStore.create({
      name: "Rejected plan",
      overview: "Should be cleared after rejection.",
      todos: [{ content: "never do this" }],
    })
    expect(created.ok).toBe(true)
    const llm = new FakeLLM([
      toolUse("pe1", "request_plan_exit", { plan: "1. Do the bad thing" }),
      toolUse("cur1", "current_plan", {}),
      text("done"),
    ])

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: dir,
          planMode: true,
          planStore,
          planExitPort: { request: async () => ({ decision: "rejected" as const }) },
          maxTurns: 6,
        }),
      ),
      10_000,
      "plan-exit-rejected",
    )

    expect(outcome.reason).toBe("completed")
    expect(planStore.current()).toBeNull()
    expect(toolResultTexts(outcome.messages).some((text) => text.includes("No active plan."))).toBe(
      true,
    )
  })

  test("changes_requested keeps plan mode active and seeds the next turn with feedback", async () => {
    const blocked = join(dir, "blocked.txt")
    const feedback = "Tighten step 2 and keep the rollback explicit."
    const stream = new RecordingStream()
    const llm = new FakeLLM([
      toolUse("pe1", "request_plan_exit", { plan: "1. write blocked.txt" }),
      toolUse("w1", "write", { path: blocked, content: "nope" }),
      text("done"),
    ])

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          cwd: dir,
          planMode: true,
          planExitPort: {
            request: async () => ({ decision: "changes_requested" as const, feedback }),
          },
          maxTurns: 5,
        }),
      ),
      10_000,
      "plan-exit-changes-requested",
    )

    expect(outcome.reason).toBe("completed")
    expect(existsSync(blocked)).toBe(false)
    expect(
      toolResultTexts(outcome.messages).some((text) =>
        text.includes(`Changes requested: ${feedback}`),
      ),
    ).toBe(true)
    expect(toolResultTexts(outcome.messages).some((text) => text.includes("blocked in plan"))).toBe(
      true,
    )
    const secondTurnTexts = messageTexts(llm.seenMessages[1] ?? [])
    expect(
      secondTurnTexts.some(
        (text) => text.includes("Operator feedback on the active plan:") && text.includes(feedback),
      ),
    ).toBe(true)
    expect(eventsOf(stream, "mode_changed")).toHaveLength(0)
  })

  test("multiple same-turn request_plan_exit calls follow the final decision at the turn boundary", async () => {
    const file = join(dir, "last-approved.txt")
    const planStore = createInMemoryPlanStore({ now: () => 1 })
    const created = planStore.create({
      name: "Final approval wins",
      overview: "Earlier rejected result must not clear the final approved plan.",
      todos: [{ content: "write the file" }],
    })
    expect(created.ok).toBe(true)
    let calls = 0
    const llm = new FakeLLM([
      multiToolUse([
        { id: "pe1", name: "request_plan_exit", input: { plan: "1. reject this draft" } },
        { id: "pe2", name: "request_plan_exit", input: { plan: `1. Write ${file}` } },
      ]),
      toolUse("w1", "write", { path: file, content: "ok" }),
      text("done"),
    ])
    const stream = new RecordingStream()

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          cwd: dir,
          planMode: true,
          planStore,
          planExitPort: {
            request: async () =>
              calls++ === 0 ? { decision: "rejected" as const } : { decision: "approved" as const },
          },
          maxTurns: 6,
        }),
      ),
      10_000,
      "plan-exit-multi-same-turn",
    )

    expect(outcome.reason).toBe("completed")
    expect(readFileSync(file, "utf8")).toBe("ok")
    expect(planStore.current()).toBeNull()
    expect(toolResultTexts(outcome.messages)).toContain(
      "Plan REJECTED. Do not proceed; stop or propose a different approach.",
    )
    expect(toolResultTexts(outcome.messages)).toContain(
      "Plan APPROVED. The operator accepted — proceed with the plan in subsequent turns.",
    )
    expect(eventsOf(stream, "mode_changed")).toEqual([
      expect.objectContaining({
        type: "mode_changed",
        from: "plan",
        to: "default",
        fromAgentMode: "plan",
        toAgentMode: "default",
        reason: "plan_exit_approved",
      }),
    ])
  })

  test("approved exit drops the live plan so focus-chain reinjection stops on the next turn", async () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 1 })
    const planStore = createInMemoryPlanStore({ now: () => 1 })
    expect(
      planStore.create({
        name: "Ship approved patch",
        overview: "Plan should not leak into execution turns after approval.",
        todos: [{ content: "write the file" }],
      }).ok,
    ).toBe(true)
    const llm = new FakeLLM([
      toolUse("pe1", "request_plan_exit", { plan: "1. Write the file" }),
      text("done"),
    ])

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: dir,
          planMode: true,
          planStore,
          planExitPort: { request: async () => ({ decision: "approved" as const }) },
          focusChain: { tracker, reinjectEveryN: 1 },
          maxTurns: 4,
        }),
      ),
      10_000,
      "plan-exit-approved-clears-focus-chain",
    )

    expect(outcome.reason).toBe("completed")
    expect(planStore.current()).toBeNull()
    expect(tracker.snapshotTodos()).toEqual([])
    const focusHeading = "## Focus Chain — Todos"
    const firstTurnFocusCount = countTextMatches(llm.seenMessages[0] ?? [], focusHeading)
    const secondTurnFocusCount = countTextMatches(llm.seenMessages[1] ?? [], focusHeading)
    expect(firstTurnFocusCount).toBe(1)
    expect(secondTurnFocusCount).toBe(firstTurnFocusCount)
  })

  test("approved exit seeds the next turn from the frozen structured snapshot, not the free-form request text", async () => {
    const planStore = createInMemoryPlanStore({ now: () => 1 })
    expect(
      planStore.create({
        name: "Structured approved plan",
        overview: "Execute the structured todo list.",
        todos: [{ content: "real structured step" }],
      }).ok,
    ).toBe(true)
    const llm = new FakeLLM([
      toolUse("pe1", "request_plan_exit", {
        plan: "WRONG FREEFORM PLAN\n\n1. do something else entirely",
      }),
      text("done"),
    ])

    const outcome = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: dir,
          planMode: true,
          planStore,
          planExitPort: { request: async () => ({ decision: "approved" as const }) },
          maxTurns: 4,
        }),
      ),
      10_000,
      "plan-exit-approved-structured-reminder",
    )

    expect(outcome.reason).toBe("completed")
    const secondTurnTexts = messageTexts(llm.seenMessages[1] ?? [])
    const approvedReminder = secondTurnTexts.find((text) =>
      text.includes("Approved plan is now executable."),
    )
    expect(approvedReminder).toBeDefined()
    expect(approvedReminder).toContain("# Structured approved plan")
    expect(approvedReminder).toContain("Execute the structured todo list.")
    expect(approvedReminder).toContain("real structured step")
    expect(approvedReminder).not.toContain("WRONG FREEFORM PLAN")
  })
})
