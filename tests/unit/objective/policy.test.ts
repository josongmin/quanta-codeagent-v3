/**
 * GOAL-02 hellgate — exhaustive actor × mutation policy + transition table.
 *
 * Definition, completion and terminal-state authority live behind ONE table the
 * authority consults after normalization and before commit. Every rejection is
 * a stable typed code; surfaces render it and never re-implement the policy.
 */

import { describe, expect, test } from "bun:test"
import {
  assertMutationPolicyComplete,
  type BlockerDependencyResolverPort,
  createObjectiveAuthority,
  MUTATION_POLICY,
  OBJECTIVE_ACTORS,
  OBJECTIVE_OPERATION_KINDS,
  type ObjectiveActor,
  type ObjectiveAuthority,
  type ObjectiveMutation,
  STRICT_VERIFIER_EXECUTION_POSTURE,
} from "@/objective"

const blockerResolver: BlockerDependencyResolverPort = {
  resolve: ({ attemptId, target }) => ({
    kind: "resolved",
    dependencyId: `run:exec:${target.ref}`,
    occurrenceEvidenceId: `occ:${target.ref}:${attemptId}`,
  }),
}

const authority = (gateOn = false): ObjectiveAuthority =>
  createObjectiveAuthority({
    now: () => 7,
    gateOn,
    confirmationAvailable: true,
    blockerDependencyResolver: blockerResolver,
  })

const run = (
  auth: ObjectiveAuthority,
  actor: ObjectiveActor,
  mutation: ObjectiveMutation,
  threadId = "t",
  admitted = true,
) => auth.commit(auth.prepare({ threadId, actor, mutation }), { admitted })

const reason = (res: ReturnType<ObjectiveAuthority["commit"]>): string =>
  res.ok ? "ok" : res.reason

const seed = (auth: ObjectiveAuthority, criteria: readonly string[] = ["c"]) =>
  run(auth, "user", { kind: "create", definition: { goal: "g", successCriteria: criteria } })

const firstCriterion = (auth: ObjectiveAuthority, threadId = "t"): string =>
  auth.get(threadId)?.successCriteria[0]?.id ?? "missing"

/** GOAL P0-A — a model blocker observation is attributed to the attempt the
 *  HOST has in flight, so the scenario needs one. */
const enterAttempt = (auth: ObjectiveAuthority, attemptId: string, threadId = "t"): void => {
  const objective = auth.get(threadId)
  if (objective === null) throw new Error("no objective")
  if (objective.attempts.started !== undefined) {
    run(auth, "system", { kind: "abandonAttempt" }, threadId)
  }
  run(
    auth,
    "system",
    {
      kind: "beginAttempt",
      attempt: {
        objectiveId: objective.objectiveId,
        attemptId,
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: auth.readDomain(threadId).revision,
      },
    },
    threadId,
  )
}

describe("GOAL-02 — the policy table is exhaustive", () => {
  test("every mutation kind × actor cell exists and the validator accepts the live table", () => {
    for (const kind of OBJECTIVE_OPERATION_KINDS) {
      for (const actor of OBJECTIVE_ACTORS) {
        expect(MUTATION_POLICY[kind]?.[actor]).toBeDefined()
      }
    }
    expect(() => assertMutationPolicyComplete(MUTATION_POLICY)).not.toThrow()
  })

  test("an injected missing cell fails module validation (drift guard has teeth)", () => {
    const broken = structuredClone(MUTATION_POLICY) as Record<string, Record<string, unknown>>
    delete broken.markCriterion?.model
    expect(() => assertMutationPolicyComplete(broken as typeof MUTATION_POLICY)).toThrow(
      /markCriterion.*model/,
    )
    const missingKind = structuredClone(MUTATION_POLICY) as Record<string, unknown>
    delete missingKind.clear
    expect(() => assertMutationPolicyComplete(missingKind as typeof MUTATION_POLICY)).toThrow(
      /clear/,
    )
  })

  test("the table is the SSOT for the load-bearing cells", () => {
    expect(MUTATION_POLICY.markCriterion.model).toEqual({ deny: "manual-attestation-required" })
    expect(MUTATION_POLICY.markCriterion.user).toBe("allow")
    expect(MUTATION_POLICY.replace.model).toEqual({ deny: "definition-change-forbidden" })
    expect(MUTATION_POLICY.clearBlocker.model).toEqual({ deny: "actor-forbidden" })
    expect(MUTATION_POLICY.settleAttempt.user).toEqual({ deny: "actor-forbidden" })
    expect(MUTATION_POLICY.markCriterionVerified.verifier).toBe("allow")
    expect(MUTATION_POLICY.create.model).toBe("approval")
  })
})

describe("GOAL-02 — completion is a deterministic projection of trusted evidence", () => {
  test("a zero-criteria objective cannot become completed through any actor/mutation pair", () => {
    const auth = authority()
    seed(auth, [])
    const before = auth.readDomain("t").revision
    for (const actor of OBJECTIVE_ACTORS) {
      run(auth, actor, { kind: "setExplicitStatus", status: "active" })
      run(auth, actor, { kind: "setNextActions", actions: ["x"] })
    }
    expect(auth.get("t")?.status).toBe("active")
    expect(auth.readDomain("t").validationContract).toBe("missing")
    expect(auth.readDomain("t").revision).toBeGreaterThanOrEqual(before)
  })

  test("model marking the last manual criterion met is denied; user completes; user reopens", () => {
    const auth = authority(false)
    seed(auth)
    const cid = firstCriterion(auth)
    const objectiveId = auth.get("t")?.objectiveId
    const denied = run(auth, "model", { kind: "markCriterion", criterionId: cid, met: true })
    expect(reason(denied)).toBe("manual-attestation-required")
    expect(auth.get("t")?.status).toBe("active")
    for (const actor of ["continuation", "verifier"] as const) {
      expect(
        reason(run(auth, actor, { kind: "markCriterion", criterionId: cid, met: true })),
      ).not.toBe("ok")
    }
    expect(reason(run(auth, "user", { kind: "markCriterion", criterionId: cid, met: true }))).toBe(
      "ok",
    )
    expect(auth.get("t")?.status).toBe("completed")
    expect(auth.get("t")?.successCriteria[0]?.completion?.source).toBe("manual")
    expect(reason(run(auth, "user", { kind: "markCriterion", criterionId: cid, met: false }))).toBe(
      "ok",
    )
    expect(auth.get("t")?.status).toBe("active")
    expect(auth.get("t")?.objectiveId).toBe(objectiveId)
  })

  test("a manual receipt attested by a non-trusted actor never counts as completion (derivation)", () => {
    // GOAL-01 left gate-off model self-marks in the store; GOAL-02's derivation
    // trusts only user/system attestations, so a legacy model receipt is inert.
    const auth = authority(false)
    seed(auth)
    const cid = firstCriterion(auth)
    // Plant a model-attested completion through restore (the only remaining path).
    const prior = auth.readDomain("t")
    const priorState = prior.state
    if (priorState === null) throw new Error("seed failed")
    const forged = {
      ...prior,
      state: {
        ...priorState,
        objective: {
          ...priorState.objective,
          successCriteria: priorState.objective.successCriteria.map((c) =>
            c.kind === "manual"
              ? {
                  ...c,
                  met: true,
                  completion: {
                    source: "manual" as const,
                    objectiveId: priorState.objective.objectiveId,
                    actor: "model" as const,
                    objectiveRevision: prior.revision,
                    verifiedAt: 1,
                  },
                }
              : c,
          ),
        },
      },
    }
    expect(auth.restore(forged, prior.revision).ok).toBe(true)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(true)
    expect(auth.get("t")?.status).toBe("active")
    expect(cid).toBe(firstCriterion(auth))
  })

  test("checked completion comes only from a verifier receipt; manual marking is refused for every actor", () => {
    const auth = authority()
    run(auth, "user", {
      kind: "create",
      definition: {
        goal: "g",
        criteria: [
          {
            text: "tests",
            check: { kind: "command", argv: ["x"], timeoutMs: 1, successExitCodes: [0] },
          },
        ],
      },
    })
    const c = auth.get("t")?.successCriteria[0]
    const cid = c?.id ?? ""
    const checkId = c?.kind === "checked" ? c.check.id : ""
    for (const actor of OBJECTIVE_ACTORS) {
      expect(
        reason(run(auth, actor, { kind: "markCriterion", criterionId: cid, met: true })),
      ).not.toBe("ok")
    }
    expect(auth.readDomain("t").validationContract).toBe("checked")
    const receipt = {
      source: "verifier" as const,
      objectiveId: auth.get("t")?.objectiveId ?? "",
      checkId,
      objectiveRevision: auth.readDomain("t").revision,
      sourceDigest: "sha256:d",
      executionPosture: STRICT_VERIFIER_EXECUTION_POSTURE,
      verifierResult: { exitCode: 0, passed: true },
      verifiedAt: 2,
    }
    expect(
      reason(run(auth, "user", { kind: "markCriterionVerified", criterionId: cid, receipt })),
    ).toBe("actor-forbidden")
    const ok = run(auth, "verifier", {
      kind: "markCriterionVerified",
      criterionId: cid,
      receipt: { ...receipt, objectiveRevision: auth.readDomain("t").revision },
    })
    expect(reason(ok)).toBe("ok")
    expect(auth.get("t")?.status).toBe("completed")
  })
})

describe("GOAL-02 — definition ownership and terminal state", () => {
  test("gate-off model create is denied; gate-on model create is an approval proposal", () => {
    const off = authority(false)
    const denied = run(off, "model", { kind: "create", definition: { goal: "g" } })
    expect(reason(denied)).toBe("actor-forbidden")
    expect(off.get("t")).toBeNull()
    const on = authority(true)
    const prepared = on.prepare({
      threadId: "t",
      actor: "model",
      mutation: { kind: "create", definition: { goal: "g" } },
    })
    expect(prepared.approvalRequired).toBe(true)
    expect(reason(on.commit(prepared, { admitted: false }))).toBe("approval-required")
    expect(on.get("t")).toBeNull()
    expect(reason(on.commit(prepared, { admitted: true }))).toBe("ok")
  })

  test("replace / clear / amendBudget / setExplicitStatus are user-or-system only", () => {
    const auth = authority()
    seed(auth)
    for (const actor of ["model", "continuation", "verifier"] as const) {
      expect(reason(run(auth, actor, { kind: "replace", definition: { goal: "x" } }))).toBe(
        "definition-change-forbidden",
      )
      expect(reason(run(auth, actor, { kind: "clear" }))).toBe("definition-change-forbidden")
      expect(reason(run(auth, actor, { kind: "amendBudget", budget: { maxTurns: 3 } }))).toBe(
        "definition-change-forbidden",
      )
      expect(reason(run(auth, actor, { kind: "setExplicitStatus", status: "paused" }))).toBe(
        "actor-forbidden",
      )
    }
    expect(auth.get("t")?.goal).toBe("g")
    expect(reason(run(auth, "system", { kind: "amendBudget", budget: { maxTurns: 3 } }))).toBe("ok")
    expect(reason(run(auth, "user", { kind: "setExplicitStatus", status: "paused" }))).toBe("ok")
  })

  test("model blocker observations require three attributed attempts and can never clear the committed blocker", () => {
    const auth = authority()
    seed(auth)
    for (const attemptId of ["a1", "a2", "a3"]) {
      enterAttempt(auth, attemptId)
      expect(
        reason(
          run(auth, "model", {
            kind: "addBlocker",
            reason: "r",
            waitingOn: "tool",
            target: { kind: "tool", ref: "operator" },
          }),
        ),
      ).toBe("ok")
    }
    const bid = auth.get("t")?.blockers[0]?.id ?? ""
    expect(reason(run(auth, "model", { kind: "clearBlocker", blockerId: bid }))).toBe(
      "actor-forbidden",
    )
    expect(reason(run(auth, "continuation", { kind: "setNextActions", actions: ["n"] }))).toBe("ok")
    expect(reason(run(auth, "verifier", { kind: "setNextActions", actions: ["n"] }))).toBe(
      "actor-forbidden",
    )
    expect(reason(run(auth, "user", { kind: "clearBlocker", blockerId: bid }))).toBe("ok")
    expect(auth.get("t")?.blockers).toEqual([])
  })

  test("completed: model mutations are terminal-denied; user criterion correction is allowed", () => {
    const auth = authority()
    seed(auth)
    const cid = firstCriterion(auth)
    run(auth, "user", { kind: "markCriterion", criterionId: cid, met: true })
    expect(auth.get("t")?.status).toBe("completed")
    expect(reason(run(auth, "model", { kind: "setNextActions", actions: ["more"] }))).toBe(
      "terminal-objective",
    )
    expect(reason(run(auth, "model", { kind: "addBlocker", reason: "r", waitingOn: "user" }))).toBe(
      "terminal-objective",
    )
    expect(reason(run(auth, "user", { kind: "markCriterion", criterionId: cid, met: false }))).toBe(
      "ok",
    )
    expect(auth.get("t")?.status).toBe("active")
  })

  test("blocked / budget-limited / usage-limited cannot be escaped via explicit active", () => {
    const blocked = authority()
    seed(blocked)
    run(blocked, "user", { kind: "setExplicitStatus", status: "paused" })
    run(blocked, "user", { kind: "addBlocker", reason: "r", waitingOn: "user" })
    expect(reason(run(blocked, "user", { kind: "setExplicitStatus", status: "active" }))).toBe(
      "invalid-transition",
    )
    expect(blocked.readDomain("t").state?.explicitStatus).toBe("paused")

    const limited = createObjectiveAuthority({ now: () => 7, enforceBudget: true })
    run(limited, "user", { kind: "create", definition: { goal: "g", budget: { maxTurns: 1 } } })
    run(limited, "system", {
      kind: "settleAttempt",
      settlement: {
        objectiveId: limited.get("t")?.objectiveId ?? "",
        attemptId: "a1",
        startedRevision: 1,
        tokensUsed: 0,
        turnsUsed: 1,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 1,
      },
    })
    expect(limited.get("t")?.status).toBe("budget_limited")
    expect(reason(run(limited, "user", { kind: "setExplicitStatus", status: "active" }))).toBe(
      "invalid-transition",
    )

    const usage = createObjectiveAuthority({ now: () => 7, enforceBudget: true })
    run(usage, "user", { kind: "create", definition: { goal: "g" } })
    run(usage, "system", { kind: "markUsageLimited", untilEpochMs: 10_000 })
    expect(usage.get("t")?.status).toBe("usage_limited")
    expect(reason(run(usage, "user", { kind: "setExplicitStatus", status: "active" }))).toBe(
      "invalid-transition",
    )
    // Pausing is always allowed (it never resurrects anything).
    expect(reason(run(usage, "user", { kind: "setExplicitStatus", status: "paused" }))).toBe("ok")
  })

  test("system-fixed kinds (settleAttempt / markUsageLimited / restore) are denied to every other actor", () => {
    const auth = authority()
    seed(auth)
    const prior = auth.readDomain("t")
    for (const actor of ["model", "user", "continuation", "verifier"] as const) {
      expect(reason(run(auth, actor, { kind: "markUsageLimited", untilEpochMs: 10 }))).toBe(
        "actor-forbidden",
      )
      expect(reason(run(auth, actor, { kind: "restore", snapshot: prior }))).toBe("actor-forbidden")
    }
    expect(reason(run(auth, "system", { kind: "markUsageLimited", untilEpochMs: 10 }))).toBe("ok")
  })

  test("red-on-injection witness: the model manual-completion cell is what blocks completion", () => {
    // The derivation would complete the objective if the policy let the model
    // attest; this pins that the TABLE cell — not an accident elsewhere — holds.
    const auth = authority()
    seed(auth)
    const cid = firstCriterion(auth)
    expect(MUTATION_POLICY.markCriterion.model).not.toBe("allow")
    expect(reason(run(auth, "model", { kind: "markCriterion", criterionId: cid, met: true }))).toBe(
      "manual-attestation-required",
    )
    expect(auth.get("t")?.status).toBe("active")
  })
})
