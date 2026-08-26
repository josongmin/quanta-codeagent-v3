/**
 * GOAL-08 rail 15 (CLI) — `/goal work` is composed to enqueue a prompt whose
 * goalContinuation meta carries `user-requested-goal-work` provenance, the
 * live objective revision, a `user-work:` attempt key and the wake activity
 * epoch. Wiring proof on the REAL `buildGoalSlashSlot` composer — a forged
 * autonomous provenance here would let operator work eat the hard cap.
 */

import { describe, expect, test } from "bun:test"
import type { SessionSetupResult } from "@/apps/cli/repl/session-setup"
import type { SurfaceCoreState } from "@/apps/cli/repl/surface-compose/core-state"
import { buildGoalSlashSlot } from "@/apps/cli/repl/surface-compose/dispatch-compose"
import { createObjectiveAuthority } from "@/objective"

const compose = (opts: { active: boolean }) => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  if (opts.active) authority.create("t", { goal: "ship", successCriteria: ["c"] })
  const pushed: unknown[] = []
  const core = {
    objectiveStore: authority,
    goalWakeSlot: {
      current: { activityEpoch: () => 7 },
      enqueueWork: (input: unknown) => {
        pushed.push(input)
      },
    },
  } as unknown as SurfaceCoreState
  const slot = buildGoalSlashSlot({ sessionId: "t" } as unknown as SessionSetupResult, core)
  return { authority, pushed, slot }
}

describe("GOAL-08 rail 15 — /goal work composes user-requested provenance", () => {
  test("active goal: enqueues user-requested-goal-work with live revision + epoch", () => {
    const { authority, pushed, slot } = compose({ active: true })
    expect(slot?.enqueueWork?.("fix the flake")).toBe(true)
    expect(pushed).toHaveLength(1)
    const meta = (pushed[0] as { goalContinuation: Record<string, unknown> }).goalContinuation
    expect(meta.provenance).toBe("user-requested-goal-work")
    expect(meta.threadId).toBe("t")
    expect(meta.objectiveRevision).toBe(authority.readDomain("t").revision)
    expect(String(meta.attemptKey)).toMatch(/^user-work:/)
    expect(meta.activityEpoch).toBe(7)
    expect((pushed[0] as { text: string }).text).toBe("fix the flake")
  })

  test("no active goal: refuses (false) and enqueues nothing", () => {
    const { pushed, slot } = compose({ active: false })
    expect(slot?.enqueueWork?.("anything")).toBe(false)
    expect(pushed).toHaveLength(0)
  })
})
