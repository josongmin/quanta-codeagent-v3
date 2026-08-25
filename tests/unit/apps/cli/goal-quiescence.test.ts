/**
 * GOAL-06 — the CLI quiescence projection is pure, fail-closed, and names the
 * FIRST busy probe in a fixed precedence so the renderer's reason is stable.
 */

import { describe, expect, test } from "bun:test"
import { type GoalQuiescenceProbes, projectGoalQuiescence } from "@/apps/cli/repl/goal-quiescence"
import type { GoalBusyReason } from "@/objective"

const quiet = (): GoalQuiescenceProbes => ({
  turnActive: () => false,
  planModeActive: () => false,
  queuedInputPending: () => false,
  mailboxInputPending: () => false,
  isEphemeral: () => false,
})

describe("GOAL-06 — goal quiescence projection", () => {
  test("all probes quiet ⇒ quiescent; optional probes absent are quiet", () => {
    expect(projectGoalQuiescence(quiet())).toEqual({ quiescent: true })
  })

  test("each live store names its own typed reason", () => {
    const yes = () => true
    const cases: [(p: GoalQuiescenceProbes) => GoalQuiescenceProbes, GoalBusyReason][] = [
      [(p) => ({ ...p, isEphemeral: yes }), "ephemeral"],
      [(p) => ({ ...p, closing: yes }), "closing"],
      [(p) => ({ ...p, sessionSwitching: yes }), "session-switching"],
      [(p) => ({ ...p, turnActive: yes }), "turn-active"],
      [(p) => ({ ...p, backgroundTurnActive: yes }), "background-turn"],
      [(p) => ({ ...p, approvalPending: yes }), "approval-pending"],
      [(p) => ({ ...p, planModeActive: yes }), "plan-mode"],
      [(p) => ({ ...p, queuedInputPending: yes }), "queued-input"],
      [(p) => ({ ...p, mailboxInputPending: yes }), "mailbox-input"],
      [(p) => ({ ...p, draftPending: yes }), "draft-pending"],
      [(p) => ({ ...p, notIdle: yes }), "not-idle"],
    ]
    for (const [over, reason] of cases) {
      expect(projectGoalQuiescence(over(quiet()))).toEqual({ quiescent: false, reason })
    }
  })

  test("fixed precedence: the earliest busy probe wins (turn-active over plan-mode over draft)", () => {
    expect(
      projectGoalQuiescence({
        ...quiet(),
        draftPending: () => true,
        planModeActive: () => true,
        turnActive: () => true,
      }),
    ).toEqual({ quiescent: false, reason: "turn-active" })
    expect(
      projectGoalQuiescence({ ...quiet(), draftPending: () => true, planModeActive: () => true }),
    ).toEqual({ quiescent: false, reason: "plan-mode" })
  })

  test("a throwing probe is BUSY (fail-closed), attributed to that probe", () => {
    expect(
      projectGoalQuiescence({
        ...quiet(),
        queuedInputPending: () => {
          throw new Error("store gone")
        },
      }),
    ).toEqual({ quiescent: false, reason: "queued-input" })
  })
})
