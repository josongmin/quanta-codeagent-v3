/**
 * GOAL-05A — the goal renderer is a PURE projection of read-port data
 * (`ObjectiveDomainSnapshot`): goal, derived status, revision, short id,
 * validation contract + evidence counts, remaining criteria, next actions,
 * typed blockers, budget + autonomous counter, last attributed outcome + age,
 * and checkpoint/source-digest status. Rail 10: no attempt key, no claim
 * internals, no predicted status — the report only ever says what the
 * authority already says.
 */

import { describe, expect, test } from "bun:test"
import { buildGoalReport, renderGoalReport, shortObjectiveId } from "@/apps/cli/goal/goal-render"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveDomainSnapshot,
} from "@/objective"
import { settleTurns, settleUsage } from "../objective/v2-helpers"

const NOW = 1_000_000

const seeded = () => {
  const authority = createObjectiveAuthority({ now: () => NOW - 120_000 })
  authority.create("t", {
    goal: "ship the feature",
    successCriteria: ["manual one", "manual two"],
    criteria: [
      {
        text: "unit tests pass",
        check: { kind: "command", argv: ["bun", "test"], timeoutMs: 1000, successExitCodes: [0] },
      },
    ],
    budget: { maxTurns: 10, maxTokens: 5000 },
  })
  const caps = createObjectiveCapabilities(authority)
  return { authority, caps }
}

describe("GOAL-05A — goal report (read-port projection)", () => {
  test("no objective ⇒ null report", () => {
    const authority = createObjectiveAuthority({ now: () => NOW })
    expect(buildGoalReport(authority.readDomain("t"), NOW)).toBeNull()
  })

  test("projects definition, contract, counts, remaining work, budget and revision from the read port only", () => {
    const { authority, caps } = seeded()
    const first = authority.get("t")?.successCriteria[0]?.id ?? ""
    expect(caps.user.commit("t", { kind: "markCriterion", criterionId: first, met: true }).ok).toBe(
      true,
    )
    caps.user.commit("t", { kind: "setNextActions", actions: ["run the suite", "open the PR"] })
    caps.user.commit("t", { kind: "addBlocker", reason: "waiting on review", waitingOn: "user" })
    settleTurns(authority, "t", 2)
    settleUsage(authority, "t", { tokens: 321 })
    const domain = authority.readDomain("t")
    const report = buildGoalReport(domain, NOW)
    expect(report).not.toBeNull()
    if (report === null) return
    expect(report.goal).toBe("ship the feature")
    expect(report.status).toBe("blocked") // derived by the authority, never predicted here
    expect(report.revision).toBe(domain.revision)
    expect(report.objectiveId).toBe(domain.state?.objective.objectiveId ?? "")
    expect(report.shortId).toBe(shortObjectiveId(report.objectiveId))
    expect(report.validationContract).toBe("checked")
    expect(report.counts).toEqual({
      total: 3,
      manualMet: 1,
      verified: 0,
      checkedUnverified: 1,
      remaining: 2,
    })
    expect(report.remaining.map((c) => c.text)).toEqual(["manual two", "unit tests pass"])
    expect(report.remaining[1]?.kind).toBe("checked")
    expect(report.remaining[1]?.checkId).toBeDefined()
    expect(report.nextActions).toEqual(["run the suite", "open the PR"])
    expect(report.blockers).toEqual([
      { reason: "waiting on review", waitingOn: "user", ageMs: expect.any(Number) },
    ])
    expect(report.budget).toEqual({
      tokensUsed: 321,
      maxTokens: 5000,
      turnsUsed: 2,
      maxTurns: 10,
      autonomousTurnsStarted: 0,
    })
    expect(report.lastAttempt?.outcome).toBe("completed")
    expect(report.lastAttempt?.ageMs).toBeGreaterThanOrEqual(0)
    expect(report.checkpoint).toEqual({ receipts: 3, sourceDigest: "absent" })
  })

  test("rail 10 — the rendered text carries no attempt key and no raw objective id", () => {
    const { authority } = seeded()
    settleUsage(authority, "t", { tokens: 1, turns: 1 })
    const domain = authority.readDomain("t")
    const receipt = domain.progressReceipts?.[0]
    expect(receipt?.attemptKey).toBeDefined()
    const report = buildGoalReport(domain, NOW)
    const text = renderGoalReport(report)
    expect(text).toContain("ship the feature")
    expect(text).toContain("status: active")
    expect(text).toContain(`rev ${domain.revision}`)
    expect(text).toContain(report?.shortId ?? "?")
    expect(text).not.toContain(receipt?.attemptKey ?? "<none>")
    expect(text).not.toContain(report?.objectiveId ?? "<none>")
    expect(text).toContain("last attempt: completed")
  })

  test("counts trust RECEIPTS, not the `met` flag: a synthetic checked+met criterion without a verifier receipt is not verified", () => {
    const snapshot: ObjectiveDomainSnapshot = {
      threadId: "t",
      revision: 3,
      validationContract: "checked",
      state: {
        explicitStatus: "active",
        objective: {
          objectiveId: "obj-synthetic",
          threadId: "t",
          goal: "g",
          createdBy: "user",
          successCriteria: [
            {
              kind: "checked",
              id: "c1",
              text: "chk",
              met: true, // no receipt ⇒ NOT trusted evidence
              check: {
                id: "k1",
                kind: "command",
                argv: ["true"],
                timeoutMs: 1,
                successExitCodes: [0],
                cwdPolicy: "thread",
              },
            },
            { kind: "manual", id: "c2", text: "m", met: true }, // no receipt either
          ],
          status: "active",
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: [],
          nextActions: [],
          attempts: { autonomousTurnsStarted: 0 },
          createdAt: 0,
          updatedAt: 0,
        },
      },
    }
    const report = buildGoalReport(snapshot, NOW)
    expect(report?.counts).toEqual({
      total: 2,
      manualMet: 0,
      verified: 0,
      checkedUnverified: 0,
      remaining: 0,
    })
  })

  test("a missing validation contract renders the add-criterion guidance (wake-ineligible)", () => {
    const authority = createObjectiveAuthority({ now: () => NOW })
    authority.create("t", { goal: "bare goal" })
    const text = renderGoalReport(buildGoalReport(authority.readDomain("t"), NOW))
    expect(text).toContain("contract: missing")
    expect(text).toMatch(/\/goal criterion add|\/goal check add/)
  })

  test("null report renders the no-goal hint", () => {
    expect(renderGoalReport(null)).toContain("No goal set")
  })
})
