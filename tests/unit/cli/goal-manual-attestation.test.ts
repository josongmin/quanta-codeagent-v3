/**
 * ★ HELLGATE (P0-2) — a manual-only goal must be COMPLETABLE.
 *
 * MEASURED DEFECT (2026-08-30 doc↔code audit): the authority allows a USER
 * `markCriterion` attestation (`policy.ts` row `markCriterion | user: allow`)
 * and `completionSatisfied` requires EVERY criterion satisfied — but no surface
 * ever produced that mutation (`grep 'kind: "markCriterion"' src` outside the
 * objective slice → 0). `/goal criterion add` therefore minted a stopping
 * contract that nothing could ever satisfy: the model's own `met:true` is
 * refused (`manual-attestation-required`), and the operator had no verb. The
 * renderer even prescribes `criterion add` as the remedy for "validation
 * contract missing", so following the product's own advice created a goal that
 * pursues until its budget or hard cap runs out.
 */

import { describe, expect, test } from "bun:test"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import { buildGoalControl } from "@/apps/cli/slash/objective"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { createObjectiveAuthority } from "@/objective"

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

const criterionIds = (h: ReturnType<typeof harness>): string[] =>
  (h.authority.get("thread")?.successCriteria ?? []).map((c) => c.id)

describe("P0-2 — the operator can attest a manual criterion", () => {
  test("add → done: the criterion is met with trusted user evidence and the goal completes", async () => {
    const h = harness()
    await goalCmd.run(["ship the thing"], h.ctx)
    await goalCmd.run(["criterion", "add", "docs", "are", "written"], h.ctx)
    const [id] = criterionIds(h)
    expect(id).toBeDefined()
    expect(h.authority.get("thread")?.status).toBe("active")

    expect(await goalCmd.run(["criterion", "done", "1"], h.ctx)).toBe(0)
    const criterion = h.authority.get("thread")?.successCriteria[0]
    expect(criterion?.met).toBe(true)
    expect(criterion?.completion?.source).toBe("manual")
    expect((criterion?.completion as { actor?: string } | undefined)?.actor).toBe("user")
    // The stopping contract is now satisfiable AND satisfied.
    expect(h.authority.get("thread")?.status).toBe("completed")
  })

  test("`criterion done` accepts the criterion id as well as the 1-based index", async () => {
    const h = harness()
    await goalCmd.run(["ship"], h.ctx)
    await goalCmd.run(["criterion", "add", "first"], h.ctx)
    await goalCmd.run(["criterion", "add", "second"], h.ctx)
    const ids = criterionIds(h)
    expect(await goalCmd.run(["criterion", "done", ids[1] as string], h.ctx)).toBe(0)
    const criteria = h.authority.get("thread")?.successCriteria ?? []
    expect(criteria[0]?.met).toBe(false)
    expect(criteria[1]?.met).toBe(true)
    // One met of two ⇒ NOT complete: attestation is per criterion, not a bypass.
    expect(h.authority.get("thread")?.status).toBe("active")
  })

  test("a bad selector is a typed refusal, not a silent no-op", async () => {
    const h = harness()
    await goalCmd.run(["ship"], h.ctx)
    await goalCmd.run(["criterion", "add", "only one"], h.ctx)
    expect(await goalCmd.run(["criterion", "done"], h.ctx)).toBe(1)
    expect(await goalCmd.run(["criterion", "done", "7"], h.ctx)).toBe(1)
    expect(await goalCmd.run(["criterion", "done", "no-such-id"], h.ctx)).toBe(1)
    expect(h.authority.get("thread")?.successCriteria[0]?.met).toBe(false)
    expect(h.err.join("")).toContain("criterion")
  })

  test("a CHECKED criterion cannot be hand-waved: attestation is refused there", async () => {
    const h = harness()
    await goalCmd.run(["ship"], h.ctx)
    await goalCmd.run(["check", "add", "tests", "pass", "--", "true"], h.ctx)
    expect(await goalCmd.run(["criterion", "done", "1"], h.ctx)).toBe(1)
    expect(h.authority.get("thread")?.successCriteria[0]?.met).toBe(false)
    expect(h.authority.get("thread")?.status).toBe("active")
    // The operator is told WHY (a checked criterion is verifier-owned), not
    // just handed the authority's generic completion refusal.
    expect(h.err.join("")).toContain("checked-criterion-needs-verify")
  })
})
