import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  type ObjectiveActor,
  type ObjectiveAuthority,
  type ObjectiveMutation,
} from "@/objective"
import {
  buildObjectiveAuthority,
  encodeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"

const seed = (authority: ObjectiveAuthority, checked = false): void => {
  authority.create("t", {
    goal: "ship",
    ...(checked
      ? {
          criteria: [
            {
              text: "tests pass",
              check: {
                kind: "command" as const,
                argv: ["bun", "test"],
                timeoutMs: 1_000,
                successExitCodes: [0],
              },
            },
          ],
        }
      : {}),
  })
}

const commit = (
  authority: ObjectiveAuthority,
  actor: ObjectiveActor,
  mutation: ObjectiveMutation,
) => authority.commit(authority.prepare({ threadId: "t", actor, mutation }), { admitted: true })

const observe = (
  authority: ObjectiveAuthority,
  attemptId: string,
  ref = "approval:deploy",
  waitingOn: "user" | "tool" = "user",
) =>
  commit(authority, "model", {
    kind: "addBlocker",
    reason: "deployment approval is pending",
    waitingOn,
    target: { kind: waitingOn === "user" ? "approval" : "tool", ref },
    attemptId,
  })

describe("GOAL-09 blocker observation authority", () => {
  test("duplicate calls from one attempt do not satisfy the three-attempt threshold", () => {
    const authority = createObjectiveAuthority()
    seed(authority)
    expect(observe(authority, "attempt-1").ok).toBe(true)
    for (let i = 0; i < 9; i += 1) expect(observe(authority, "attempt-1").ok).toBe(false)

    const objective = authority.get("t")
    expect(objective?.status).toBe("active")
    expect(objective?.blockers).toEqual([])
    expect(objective?.blockerObservations).toHaveLength(1)
    expect(objective?.blockerObservations[0]?.distinctAttemptIds).toEqual(["attempt-1"])
  })

  test("two distinct attempts remain active; the third promotes exactly one blocker", () => {
    const authority = createObjectiveAuthority()
    seed(authority)
    expect(observe(authority, "attempt-1").ok).toBe(true)
    expect(observe(authority, "attempt-2").ok).toBe(true)
    expect(authority.get("t")).toMatchObject({ status: "active", blockers: [] })
    expect(authority.get("t")?.blockerObservations[0]?.distinctAttemptIds).toEqual([
      "attempt-1",
      "attempt-2",
    ])

    expect(observe(authority, "attempt-3").ok).toBe(true)
    expect(authority.get("t")).toMatchObject({ status: "blocked" })
    expect(authority.get("t")?.blockers).toHaveLength(1)
    expect(authority.get("t")?.blockerObservations).toEqual([])
  })

  test("waitingOn and typed target changes create independent observations", () => {
    const authority = createObjectiveAuthority()
    seed(authority)
    observe(authority, "a", "approval:one")
    observe(authority, "b", "approval:two")
    observe(authority, "c", "tool:one", "tool")
    expect(authority.get("t")?.blockerObservations).toHaveLength(3)
    expect(
      authority.get("t")?.blockerObservations.map((item) => item.distinctAttemptIds.length),
    ).toEqual([1, 1, 1])
  })

  test("user and system blockers remain immediate", () => {
    for (const actor of ["user", "system"] as const) {
      const authority = createObjectiveAuthority()
      seed(authority)
      expect(
        commit(authority, actor, {
          kind: "addBlocker",
          reason: "operator declared stop",
          waitingOn: "user",
        }).ok,
      ).toBe(true)
      expect(authority.get("t")?.status).toBe("blocked")
      expect(authority.get("t")?.blockerObservations).toEqual([])
    }
  })

  test("observation retention is capped at eight and evicts the oldest", () => {
    let now = 1
    const authority = createObjectiveAuthority({ now: () => now++ })
    seed(authority)
    for (let i = 0; i < 9; i += 1) observe(authority, `attempt-${i}`, `dependency-${i}`)
    const observations = authority.get("t")?.blockerObservations ?? []
    expect(observations).toHaveLength(8)
    expect(observations.some((item) => item.dependencyRef.includes("dependency-0"))).toBe(false)
    expect(observations.some((item) => item.dependencyRef.includes("dependency-8"))).toBe(true)
  })

  test("observations survive persistence and legacy snapshots restore an empty list", () => {
    const authority = buildObjectiveAuthority() as ObjectiveAuthority
    seed(authority)
    observe(authority, "attempt-1")
    observe(authority, "attempt-2")
    const snapshot = encodeObjectiveSnapshot(authority)
    const reopened = buildObjectiveAuthority({ restoreFrom: snapshot }) as ObjectiveAuthority
    expect(reopened.get("t")?.blockerObservations[0]?.distinctAttemptIds).toEqual([
      "attempt-1",
      "attempt-2",
    ])

    const legacy = {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({
        ...thread,
        objective:
          thread.objective === null
            ? null
            : (({ blockerObservations: _, ...body }) => body)(thread.objective),
      })),
    }
    expect(
      (buildObjectiveAuthority({ restoreFrom: legacy }) as ObjectiveAuthority).get("t")
        ?.blockerObservations,
    ).toEqual([])
  })

  test("new verifier evidence clears pending observations", () => {
    const authority = createObjectiveAuthority()
    seed(authority, true)
    observe(authority, "attempt-1")
    observe(authority, "attempt-2")
    const domain = authority.readDomain("t")
    const criterion = domain.state?.objective.successCriteria[0]
    if (criterion?.kind !== "checked") throw new Error("checked criterion missing")

    const result = commit(authority, "verifier", {
      kind: "applyVerificationBatch",
      batch: {
        objectiveId: domain.state?.objective.objectiveId ?? "",
        expectedRevision: domain.revision,
        sourceDigest: "sha256:current",
        verifiedAt: 1,
        results: [
          {
            criterionId: criterion.id,
            checkId: criterion.check.id,
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            stdoutDigest: "sha256:stdout",
            stderrDigest: "sha256:stderr",
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(authority.get("t")?.blockerObservations).toEqual([])
  })

  test("settlement clears observations when the attempt gained criterion progress", () => {
    const authority = createObjectiveAuthority()
    authority.create("t", { goal: "ship", successCriteria: ["done"] })
    observe(authority, "attempt-1")
    observe(authority, "attempt-2")
    const started = authority.readDomain("t")
    const criterionId = authority.get("t")?.successCriteria[0]?.id ?? ""
    expect(
      commit(authority, "system", {
        kind: "markCriterion",
        criterionId,
        met: true,
      }).ok,
    ).toBe(true)

    const result = commit(authority, "system", {
      kind: "settleAttempt",
      settlement: {
        objectiveId: started.state?.objective.objectiveId ?? "",
        attemptId: "settlement-attempt",
        startedRevision: started.revision,
        tokensUsed: 1,
        turnsUsed: 1,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 100,
      },
    })
    expect(result.ok).toBe(true)
    expect(authority.get("t")?.blockerObservations).toEqual([])
  })

  test("model observations fail closed without host attempt or typed target", () => {
    const authority = createObjectiveAuthority()
    seed(authority)
    expect(
      commit(authority, "model", {
        kind: "addBlocker",
        reason: "unattributed",
        waitingOn: "user",
      }),
    ).toMatchObject({ ok: false, reason: "invalid" })
    expect(authority.get("t")?.blockerObservations).toEqual([])
  })
})
