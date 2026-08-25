/**
 * GOAL-02 hellgate — actor-fixed objective capabilities.
 *
 * Composition mints narrow command capabilities with the actor bound; ordinary
 * consumers never receive the raw authority. A capability cannot be talked into
 * another actor's mutation by constructing a raw command.
 */

import { describe, expect, test } from "bun:test"
import {
  asObjectiveReadPort,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveMutation,
} from "@/objective"

const setup = (gateOn = false) => {
  const authority = createObjectiveAuthority({ now: () => 3, gateOn, confirmationAvailable: true })
  return { authority, caps: createObjectiveCapabilities(authority) }
}

describe("GOAL-02 — capabilities", () => {
  test("the read port exposes reads only", () => {
    const { authority } = setup()
    const read = asObjectiveReadPort(authority)
    expect(Object.keys(read).sort()).toEqual(["get", "list", "readDomain"])
    expect(read.get("t")).toBeNull()
  })

  test("user capability creates / replaces / clears; model capability cannot", () => {
    const { caps } = setup()
    expect(caps.user.commit("t", { kind: "create", definition: { goal: "g" } }).ok).toBe(true)
    const first = caps.read.get("t")?.objectiveId
    const forged = caps.model.commit("t", {
      kind: "replace",
      definition: { goal: "x" },
    } as unknown as Parameters<typeof caps.model.commit>[1])
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.reason).toBe("definition-change-forbidden")
    expect(caps.read.get("t")?.objectiveId).toBe(first)
    expect(caps.user.commit("t", { kind: "clear" }).ok).toBe(true)
    expect(caps.read.get("t")).toBeNull()
  })

  test("model capability: a forged system mutation is refused at the authority (not just the type)", () => {
    const { caps } = setup()
    caps.user.commit("t", { kind: "create", definition: { goal: "g" } })
    const settle: ObjectiveMutation = {
      kind: "settleAttempt",
      settlement: {
        objectiveId: caps.read.get("t")?.objectiveId ?? "",
        attemptId: "x",
        startedRevision: 1,
        tokensUsed: 99,
        turnsUsed: 1,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 1,
      },
    }
    const res = caps.model.commit("t", settle as unknown as Parameters<typeof caps.model.commit>[1])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("actor-forbidden")
    expect(caps.read.get("t")?.budget.tokensUsed).toBe(0)
    expect(caps.system.commit("t", settle).ok).toBe(true)
    expect(caps.read.get("t")?.budget.tokensUsed).toBe(99)
  })

  test("model capability prepare/commit carries the gate-on approval round trip", () => {
    const { caps } = setup(true)
    const prepared = caps.model.prepare("t", { kind: "create", definition: { goal: "g" } })
    expect(prepared.approvalRequired).toBe(true)
    expect(prepared.commit({ admitted: false }).ok).toBe(false)
    expect(caps.read.get("t")).toBeNull()
    expect(prepared.commit({ admitted: true }).ok).toBe(true)
    expect(caps.read.get("t")?.createdBy).toBe("model")
  })

  test("verifier capability completes a checked criterion; user capability cannot", () => {
    const { caps } = setup()
    caps.user.commit("t", {
      kind: "create",
      definition: {
        goal: "g",
        criteria: [
          {
            text: "c",
            check: { kind: "command", argv: ["x"], timeoutMs: 1, successExitCodes: [0] },
          },
        ],
      },
    })
    const c = caps.read.get("t")?.successCriteria[0]
    const receipt = {
      source: "verifier" as const,
      objectiveId: caps.read.get("t")?.objectiveId ?? "",
      checkId: c?.kind === "checked" ? c.check.id : "",
      objectiveRevision: caps.read.readDomain("t").revision,
      sourceDigest: "sha256:d",
      verifierResult: { exitCode: 0, passed: true },
      verifiedAt: 1,
    }
    const viaUser = caps.user.commit("t", {
      kind: "markCriterionVerified",
      criterionId: c?.id ?? "",
      receipt,
    } as unknown as Parameters<typeof caps.user.commit>[1])
    expect(viaUser.ok).toBe(false)
    expect(
      caps.verifier.commit("t", {
        kind: "markCriterionVerified",
        criterionId: c?.id ?? "",
        receipt,
      }).ok,
    ).toBe(true)
    expect(caps.read.get("t")?.status).toBe("completed")
  })

  test("expectedRevision is honoured (stale commit is rejected without effect)", () => {
    const { caps } = setup()
    caps.user.commit("t", { kind: "create", definition: { goal: "g" } })
    const rev = caps.read.readDomain("t").revision
    caps.user.commit("t", { kind: "setNextActions", actions: ["winner"] })
    const stale = caps.user.commit(
      "t",
      { kind: "setNextActions", actions: ["loser"] },
      { expectedRevision: rev },
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe("stale")
    expect(caps.read.get("t")?.nextActions).toEqual(["winner"])
  })
})
