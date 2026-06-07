import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import { createInMemoryPlanStore } from "@/agent/plan/state"
import type { Message } from "@/llm"
import {
  cfg,
  eventsOf,
  FakeLLM,
  findEvent,
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
    expect(findEvent(stream, "mode_changed")).toEqual({
      type: "mode_changed",
      from: "plan",
      to: "default",
      reason: "plan_exit_approved",
    })
    const snapshot = findEvent(stream, "plan_snapshot")
    expect(snapshot?.type).toBe("plan_snapshot")
    if (snapshot?.type === "plan_snapshot") {
      expect(snapshot.plan.name).toBe("Ship approved patch")
      expect(snapshot.plan.todos).toHaveLength(1)
    }
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
})
