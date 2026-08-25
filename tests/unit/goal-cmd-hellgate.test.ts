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
  let mutations = 0
  const control = buildGoalControl(authority, "thread", () => mutations++)
  const ctx: SlashContext = {
    cwd: "/tmp",
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    objectiveEditor: control,
    now: () => 10_000,
  }
  return { authority, control, ctx, out, err, mutations: () => mutations }
}

describe("/goal v2 authority facade", () => {
  test("create is one CAS commit and a second bare create cannot replace it", async () => {
    const h = harness()
    expect(await goalCmd.run(["first"], h.ctx)).toBe(0)
    const id = h.authority.get("thread")?.objectiveId
    expect(h.mutations()).toBe(1)
    expect(await goalCmd.run(["second"], h.ctx)).toBe(1)
    expect(h.authority.get("thread")?.objectiveId).toBe(id)
    expect(h.err.join("")).toContain("use '/goal edit <text>'")
  })

  test("edit mints a new generation and clears validation evidence", async () => {
    const h = harness()
    await goalCmd.run(["first"], h.ctx)
    await goalCmd.run(["criterion", "add", "accepted"], h.ctx)
    const priorId = h.authority.get("thread")?.objectiveId
    expect(await goalCmd.run(["edit", "second"], h.ctx)).toBe(0)
    expect(h.authority.get("thread")?.objectiveId).not.toBe(priorId)
    expect(h.authority.get("thread")?.successCriteria).toHaveLength(0)
  })

  test("clear deletes the domain and stop remains a pause alias", async () => {
    const h = harness()
    await goalCmd.run(["first"], h.ctx)
    expect(await goalCmd.run(["stop"], h.ctx)).toBe(0)
    expect(h.authority.get("thread")?.status).toBe("paused")
    expect(await goalCmd.run(["clear"], h.ctx)).toBe(0)
    expect(h.authority.readDomain("thread").state).toBeNull()
  })

  test("criterion and argv check additions replace identity with the declared contract", async () => {
    const h = harness()
    await goalCmd.run(["first"], h.ctx)
    await goalCmd.run(["criterion", "add", "operator", "accepts"], h.ctx)
    expect(h.authority.get("thread")?.successCriteria[0]?.kind).toBe("manual")
    const manualId = h.authority.get("thread")?.objectiveId
    await goalCmd.run(["check", "add", "tests", "pass", "--", "bun", "test", "x"], h.ctx)
    const objective = h.authority.get("thread")
    expect(objective?.objectiveId).not.toBe(manualId)
    const checked = objective?.successCriteria[1]
    expect(checked?.kind).toBe("checked")
    if (checked?.kind === "checked") expect(checked.check.argv).toEqual(["bun", "test", "x"])
  })

  test("budget amend preserves objective identity", async () => {
    const h = harness()
    await goalCmd.run(["first"], h.ctx)
    const id = h.authority.get("thread")?.objectiveId
    expect(await goalCmd.run(["budget", "--max-turns=4", "--max-tokens=900"], h.ctx)).toBe(0)
    expect(h.authority.get("thread")?.objectiveId).toBe(id)
    expect(h.authority.get("thread")?.budget).toMatchObject({ maxTurns: 4, maxTokens: 900 })
  })

  test("completed objective resume is refused with status-specific guidance", async () => {
    const h = harness()
    await goalCmd.run(["first"], h.ctx)
    await goalCmd.run(["criterion", "add", "accepted"], h.ctx)
    const criterionId = h.authority.get("thread")?.successCriteria[0]?.id ?? ""
    h.authority.commit(
      h.authority.prepare({
        threadId: "thread",
        actor: "user",
        mutation: { kind: "markCriterion", criterionId, met: true },
      }),
      { admitted: true },
    )
    expect(await goalCmd.run(["resume"], h.ctx)).toBe(1)
    expect(h.err.join("")).toContain("completed goal")
  })

  test("show exposes a missing validation contract; verify fails closed without host port", async () => {
    const h = harness()
    await goalCmd.run(["first"], h.ctx)
    h.out.length = 0
    expect(await goalCmd.run([], h.ctx)).toBe(0)
    expect(h.out.join("")).toContain("validation contract missing")
    expect(await goalCmd.run(["verify"], h.ctx)).toBe(1)
    expect(h.err.join("")).toContain("verifier-unavailable")
  })
})
