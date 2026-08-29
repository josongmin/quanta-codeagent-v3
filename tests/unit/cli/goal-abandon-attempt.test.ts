/**
 * ★ HELLGATE (P0-3) — the operator can free a STUCK attributed attempt.
 *
 * MEASURED DEFECT (2026-08-30 doc↔code audit): a durable `beginAttempt` that
 * never settled (a crash, or a settlement whose persistence failed) leaves
 * `attempts.started` set. From there `replace` and `clear` are refused with
 * `attempt-in-flight` (`policy.ts`), so the goal can be neither edited nor
 * deleted. The authority ships the designed escape hatch — an `abandonAttempt`
 * mutation the USER may issue — but `grep 'kind: "abandonAttempt"' src` found
 * only the type declaration: NO surface ever produced it. The escape hatch was
 * unreachable, so a stuck goal was permanent.
 */

import { describe, expect, test } from "bun:test"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import { buildGoalControl } from "@/apps/cli/slash/objective"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { createObjectiveAuthority, createObjectiveCapabilities } from "@/objective"

const harness = () => {
  let sequence = 0
  const authority = createObjectiveAuthority({ idFactory: () => `goal-${++sequence}` })
  const out: string[] = []
  const err: string[] = []
  const control = buildGoalControl(authority, "thread")
  const ctx: SlashContext = {
    cwd: "/tmp",
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    objectiveEditor: control,
    now: () => 10_000,
  }
  return { authority, ctx, out, err }
}

/** Leave a durable started attempt behind, exactly as a crash between
 *  `beginAttempt` and settlement does. */
const stickAnAttempt = (authority: ReturnType<typeof createObjectiveAuthority>): void => {
  const domain = authority.readDomain("thread")
  const result = createObjectiveCapabilities(authority).system.commit("thread", {
    kind: "beginAttempt",
    attempt: {
      objectiveId: domain.state?.objective.objectiveId ?? "",
      attemptId: "stuck-1",
      provenance: "autonomous-continuation",
      executionMode: "background",
      startedRevision: domain.revision,
    },
  })
  if (!result.ok) throw new Error("probe could not begin an attempt")
}

describe("P0-3 — a stuck attempt does not lock the goal forever", () => {
  test("the lock is real: with a started attempt, edit and clear are refused", async () => {
    const h = harness()
    await goalCmd.run(["ship the thing"], h.ctx)
    stickAnAttempt(h.authority)
    expect(h.authority.get("thread")?.attempts.started?.attemptId).toBe("stuck-1")
    expect(await goalCmd.run(["edit", "something else"], h.ctx)).toBe(1)
    expect(await goalCmd.run(["clear"], h.ctx)).toBe(1)
    expect(h.err.join("")).toContain("attempt-in-flight")
    expect(h.authority.get("thread")?.goal).toBe("ship the thing")
  })

  test("`/goal abandon` frees it, and edit/clear work again", async () => {
    const h = harness()
    await goalCmd.run(["ship the thing"], h.ctx)
    stickAnAttempt(h.authority)
    expect(await goalCmd.run(["abandon"], h.ctx)).toBe(0)
    expect(h.authority.get("thread")?.attempts.started).toBeUndefined()
    // The BUDGET the started attempt reserved is NOT refunded — the turn really
    // ran; abandoning only releases the lock.
    expect(h.authority.get("thread")?.budget.turnsUsed).toBe(1)
    expect(await goalCmd.run(["edit", "something else"], h.ctx)).toBe(0)
    expect(h.authority.get("thread")?.goal).toBe("something else")
  })

  test("abandon with nothing stuck is a typed no-op, not a lie", async () => {
    const h = harness()
    await goalCmd.run(["ship the thing"], h.ctx)
    expect(h.authority.get("thread")?.attempts.started).toBeUndefined()
    expect(await goalCmd.run(["abandon"], h.ctx)).toBe(0)
    expect(h.out.join("")).toContain("no attempt")
    expect(h.authority.get("thread")?.attempts.started).toBeUndefined()
  })

  test("abandon without a goal is refused", async () => {
    const h = harness()
    expect(await goalCmd.run(["abandon"], h.ctx)).toBe(1)
  })
})
