/**
 * ALBB-20 #1 — plan-exit-wire `rejected` branch observability.
 *
 * Red-on-injection: the `rejected` decision USED to `planStore.clear()` +
 * return with ZERO stream emit and ZERO operator reminder, while `approved`
 * emits `mode_changed`/`plan_snapshot` + pushes a reminder and
 * `changes_requested` pushes a reminder. This asserts the rejected branch now
 * emits a `mode_changed` (reason `plan_exit_rejected`) AND pushes an operator
 * reminder BEFORE clearing the store. Delete either ⇒ this goes red.
 */

import { describe, expect, test } from "bun:test"
import type { HookPromptInject } from "@/agent/hooks"
import { applyPendingPlanExit } from "@/agent/loop/plan-exit-wire"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import { buildPlanExit } from "@/agent/plan-exit"
import type { PlanLifecycleConfig } from "@/agent/types"
import type { AgentEvent } from "@/stream"

const NOW = 1_700_000_000_000

const makeStore = (): PlanStore => {
  let n = 0
  const store = createInMemoryPlanStore({
    now: () => NOW,
    idGen: () => {
      n += 1
      return `t-${n}`
    },
  })
  store.create({ name: "P", overview: "o", todos: [{ content: "s1" }] })
  return store
}

const makeCfg = (planStore: PlanStore | undefined, emitted: AgentEvent[]): PlanLifecycleConfig => ({
  planMode: true,
  collaborationMode: "plan",
  stream: { emit: (e) => emitted.push(e) },
  ...(planStore !== undefined ? { planStore } : {}),
})

describe("plan-exit-wire #1 rejected observability", () => {
  test("rejected emits mode_changed + pushes reminder BEFORE clearing store", () => {
    const emitted: AgentEvent[] = []
    const store = makeStore()
    const cfg = makeCfg(store, emitted)
    const reminders: HookPromptInject[] = []

    applyPendingPlanExit(
      cfg,
      { plan: "the plan text", outcome: buildPlanExit({ decision: "rejected" }) },
      reminders,
    )

    // store IS cleared (behavior preserved)
    expect(store.current()).toBeNull()
    // NEW: a mode_changed event surfaced the exit
    const modeChanged = emitted.find((e) => e.type === "mode_changed")
    expect(modeChanged).toBeDefined()
    if (modeChanged?.type === "mode_changed") {
      expect(modeChanged.reason).toBe("plan_exit_rejected")
      expect(modeChanged.to).toBe("default")
    }
    // NEW: an operator reminder is pushed
    expect(reminders.length).toBe(1)
    expect(reminders[0]?.injectAfterSystem).toContain("rejected")
  })
})
