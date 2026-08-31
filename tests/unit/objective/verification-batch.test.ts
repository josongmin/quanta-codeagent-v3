/**
 * GOAL-03 hellgate — the verifier's batch commit and invalidation.
 *
 * The authority re-validates generation / revision / criterion / check identity
 * and RECOMPUTES `passed` from the immutable `successExitCodes`; a forged verdict
 * cannot complete anything, and only the verifier actor may drive either kind.
 */

import { describe, expect, test } from "bun:test"
import {
  type CommitRejection,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  LEGACY_UNKNOWN_VERIFIER_POSTURE,
  type ObjectiveAuthority,
  STRICT_VERIFIER_EXECUTION_POSTURE,
  type VerificationBatch,
  type VerificationBatchResult,
} from "@/objective"

const setup = (): {
  auth: ObjectiveAuthority
  caps: ReturnType<typeof createObjectiveCapabilities>
  ids: { criterionId: string; checkId: string }[]
} => {
  const auth = createObjectiveAuthority({ now: () => 5 })
  auth.create("t", {
    goal: "g",
    criteria: [
      {
        text: "unit",
        check: { kind: "command", argv: ["a"], timeoutMs: 1, successExitCodes: [0] },
      },
      {
        text: "lint",
        check: { kind: "command", argv: ["b"], timeoutMs: 1, successExitCodes: [0, 2] },
      },
      { text: "manual" },
    ],
  })
  const ids = (auth.get("t")?.successCriteria ?? []).flatMap((c) =>
    c.kind === "checked" ? [{ criterionId: c.id, checkId: c.check.id }] : [],
  )
  return { auth, caps: createObjectiveCapabilities(auth), ids }
}

const result = (
  id: { criterionId: string; checkId: string },
  over: Partial<VerificationBatchResult> = {},
): VerificationBatchResult => ({
  criterionId: id.criterionId,
  checkId: id.checkId,
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  stdoutDigest: "sha256:o",
  stderrDigest: "sha256:e",
  ...over,
})

const batchFor = (
  auth: ObjectiveAuthority,
  results: readonly VerificationBatchResult[],
  over: Partial<VerificationBatch> = {},
): VerificationBatch => ({
  objectiveId: auth.get("t")?.objectiveId ?? "",
  expectedRevision: auth.readDomain("t").revision,
  sourceDigest: "sha256:src",
  verifiedAt: 9,
  executionPosture: STRICT_VERIFIER_EXECUTION_POSTURE,
  results,
  ...over,
})

describe("GOAL-03 — applyVerificationBatch", () => {
  test("passed is recomputed from exit code + successExitCodes; a forged verdict field is ignored", () => {
    const { auth, caps, ids } = setup()
    const [unit, lint] = ids
    if (!unit || !lint) throw new Error("fixture")
    const batch = batchFor(auth, [
      { ...result(unit, { exitCode: 1 }), passed: true } as unknown as VerificationBatchResult,
      result(lint, { exitCode: 2 }),
    ])
    const res = caps.verifier.commit("t", { kind: "applyVerificationBatch", batch })
    expect(res.ok).toBe(true)
    const crit = auth.get("t")?.successCriteria ?? []
    expect(crit[0]?.met).toBe(false)
    expect(crit[0]?.completion).toBeUndefined()
    expect(crit[1]?.met).toBe(true)
    expect(crit[1]?.completion?.source).toBe("verifier")
    if (crit[1]?.completion?.source === "verifier") {
      expect(crit[1].completion.sourceDigest).toBe("sha256:src")
      expect(crit[1].completion.objectiveId).toBe(auth.get("t")?.objectiveId ?? "")
      expect(crit[1].completion.checkId).toBe(lint.checkId)
    }
    expect(auth.get("t")?.status).toBe("active") // manual criterion + failed unit remain
  })

  test("a timed-out run never passes even with a 'success' exit code", () => {
    const { auth, caps, ids } = setup()
    const [unit] = ids
    if (!unit) throw new Error("fixture")
    const res = caps.verifier.commit("t", {
      kind: "applyVerificationBatch",
      batch: batchFor(auth, [result(unit, { exitCode: 0, timedOut: true })]),
    })
    expect(res.ok).toBe(true)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("wrong objectiveId / checkId / criterionId or stale revision rejects the WHOLE batch", () => {
    const { auth, caps, ids } = setup()
    const [unit, lint] = ids
    if (!unit || !lint) throw new Error("fixture")
    const rev = auth.readDomain("t").revision
    const cases: { batch: VerificationBatch; reason: CommitRejection }[] = [
      {
        batch: batchFor(auth, [result(unit)], { objectiveId: "other" }),
        reason: "objective-mismatch",
      },
      { batch: batchFor(auth, [result(unit)], { expectedRevision: rev - 1 }), reason: "stale" },
      {
        batch: batchFor(auth, [result(unit), result({ ...lint, checkId: "forged" })]),
        reason: "invalid",
      },
      {
        batch: batchFor(auth, [result({ criterionId: "nope", checkId: unit.checkId })]),
        reason: "invalid",
      },
      { batch: batchFor(auth, [result(unit)], { sourceDigest: "" }), reason: "invalid" },
      {
        batch: batchFor(auth, [result(unit)], {
          executionPosture: LEGACY_UNKNOWN_VERIFIER_POSTURE,
        }),
        reason: "invalid",
      },
    ]
    for (const { batch, reason } of cases) {
      const res = caps.verifier.commit("t", { kind: "applyVerificationBatch", batch })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe(reason)
      expect(auth.get("t")?.successCriteria.every((c) => !c.met)).toBe(true)
      expect(auth.readDomain("t").revision).toBe(rev)
    }
  })

  test("only the verifier actor may commit a batch or an invalidation", () => {
    const { auth, ids } = setup()
    const [unit] = ids
    if (!unit) throw new Error("fixture")
    for (const actor of ["user", "model", "continuation", "system"] as const) {
      const res = auth.commit(
        auth.prepare({
          threadId: "t",
          actor,
          mutation: { kind: "applyVerificationBatch", batch: batchFor(auth, [result(unit)]) },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("actor-forbidden")
      const inv = auth.commit(
        auth.prepare({
          threadId: "t",
          actor,
          mutation: {
            kind: "invalidateVerification",
            objectiveId: auth.get("t")?.objectiveId ?? "",
            checkIds: [unit.checkId],
            reason: "stale-source",
          },
        }),
        { admitted: true },
      )
      expect(inv.ok).toBe(false)
    }
  })

  test("invalidateVerification drops only the named checks' completion and is a no-op when nothing was verified", () => {
    const { auth, caps, ids } = setup()
    const [unit, lint] = ids
    if (!unit || !lint) throw new Error("fixture")
    caps.verifier.commit("t", {
      kind: "applyVerificationBatch",
      batch: batchFor(auth, [result(unit), result(lint)]),
    })
    expect(auth.get("t")?.successCriteria.filter((c) => c.met).length).toBe(2)
    const rev = auth.readDomain("t").revision
    const objectiveId = auth.get("t")?.objectiveId ?? ""
    const inv = caps.verifier.commit("t", {
      kind: "invalidateVerification",
      objectiveId,
      checkIds: [unit.checkId],
      reason: "stale-source",
      observedSourceDigest: "sha256:changed",
    })
    expect(inv.ok).toBe(true)
    expect(auth.readDomain("t").revision).toBe(rev + 1)
    const crit = auth.get("t")?.successCriteria ?? []
    expect(crit[0]?.met).toBe(false)
    expect(crit[1]?.met).toBe(true)
    const again = caps.verifier.commit("t", {
      kind: "invalidateVerification",
      objectiveId,
      checkIds: [unit.checkId],
      reason: "stale-source",
    })
    expect(again.ok).toBe(false) // nothing left to invalidate ⇒ no revision churn
    expect(auth.readDomain("t").revision).toBe(rev + 1)
    const wrongGen = caps.verifier.commit("t", {
      kind: "invalidateVerification",
      objectiveId: "other",
      checkIds: [lint.checkId],
      reason: "stale-source",
    })
    expect(wrongGen.ok).toBe(false)
    expect(crit[1]?.met).toBe(true)
  })

  test("all checked criteria passing derives completed only when the manual one is user-attested too", () => {
    const { auth, caps, ids } = setup()
    const [unit, lint] = ids
    if (!unit || !lint) throw new Error("fixture")
    caps.verifier.commit("t", {
      kind: "applyVerificationBatch",
      batch: batchFor(auth, [result(unit), result(lint)]),
    })
    expect(auth.get("t")?.status).toBe("active")
    const manual = auth.get("t")?.successCriteria.find((c) => c.kind === "manual")
    expect(
      caps.user.commit("t", { kind: "markCriterion", criterionId: manual?.id ?? "", met: true }).ok,
    ).toBe(true)
    expect(auth.get("t")?.status).toBe("completed")
  })
})
