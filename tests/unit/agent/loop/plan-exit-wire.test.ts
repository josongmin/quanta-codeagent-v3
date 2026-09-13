/**
 * ALBB-20 #1 — plan-exit-wire `rejected` branch observability, and the posture it keeps.
 *
 * Red-on-injection: the `rejected` decision USED to `planStore.clear()` + return with
 * ZERO operator reminder, while `approved` and `changes_requested` push one. This asserts
 * the rejected branch pushes a reminder BEFORE clearing the store.
 *
 * The ALBB-20 fix also switched the session to default mode and emitted `mode_changed`
 * (reason `plan_exit_rejected`), and this file asserted exactly that. Default mode admits
 * writes, so a rejection unlocked them (round-9 audit, reproduced in
 * `tests/integration/request-plan-exit-lifecycle-e2e.test.ts`). The arm now asserts the
 * mode does not move and no `mode_changed` is emitted.
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
  test("rejected pushes a reminder, clears the store, and stays in plan mode", () => {
    const emitted: AgentEvent[] = []
    const store = makeStore()
    const cfg = makeCfg(store, emitted)
    const reminders: HookPromptInject[] = []

    applyPendingPlanExit(
      cfg,
      { plan: "the plan text", outcome: buildPlanExit({ decision: "rejected" }) },
      reminders,
    )

    expect(store.current()).toBeNull()
    expect(cfg.collaborationMode).toBe("plan")
    expect(cfg.planMode).toBe(true)
    expect(emitted.filter((e) => e.type === "mode_changed")).toEqual([])
    expect(reminders.length).toBe(1)
    expect(reminders[0]?.injectAfterSystem).toContain("rejected")
    expect(reminders[0]?.injectAfterSystem).toContain("Plan mode stays active")
  })

  test("PAIRED CONTROL: the same config under approved does leave plan mode", () => {
    const emitted: AgentEvent[] = []
    const cfg = makeCfg(makeStore(), emitted)
    applyPendingPlanExit(
      cfg,
      { plan: "the plan text", outcome: buildPlanExit({ decision: "approved" }) },
      [],
    )
    expect(cfg.collaborationMode).toBe("default")
    expect(emitted.filter((e) => e.type === "mode_changed")).toHaveLength(1)
  })
})
