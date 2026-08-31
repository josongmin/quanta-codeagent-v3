import { describe, expect, test } from "bun:test"
import { renderGoalDomain } from "@/apps/cli/slash/goal-render"
import { createObjectiveAuthority, STRICT_VERIFIER_EXECUTION_POSTURE } from "@/objective"

describe("goal status renderer", () => {
  test("renders verifier source and checkpoint only from authority evidence", () => {
    const authority = createObjectiveAuthority({ now: () => 1_000, idFactory: () => "goal-id" })
    authority.commit(
      authority.prepare({
        threadId: "t",
        actor: "user",
        mutation: {
          kind: "create",
          definition: {
            goal: "ship",
            criteria: [
              {
                text: "tests pass",
                check: {
                  kind: "command",
                  argv: ["bun", "test"],
                  timeoutMs: 10,
                  successExitCodes: [0],
                },
              },
            ],
          },
        },
      }),
      { admitted: true },
    )
    const criterion = authority.get("t")?.successCriteria[0]
    const revision = authority.readDomain("t").revision
    if (criterion?.kind !== "checked") throw new Error("checked criterion missing")
    authority.commit(
      authority.prepare({
        threadId: "t",
        actor: "verifier",
        mutation: {
          kind: "applyVerificationBatch",
          batch: {
            objectiveId: "goal-id",
            expectedRevision: revision,
            sourceDigest: "sha256:old",
            verifiedAt: 1,
            executionPosture: STRICT_VERIFIER_EXECUTION_POSTURE,
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
        },
      }),
      { admitted: true },
    )
    const currentRevision = authority.readDomain("t").revision
    expect(
      authority.recordProgressReceipt("t", {
        objectiveId: "goal-id",
        attemptKey: "attempt-1",
        objectiveRevisionBefore: currentRevision,
        objectiveRevisionAfter: currentRevision,
        turnOutcome: "completed",
        criterionTransitions: [criterion.id],
        verifierReceiptRefs: [criterion.check.id],
        remainingCriterionIds: [],
        recordedAt: 1_000,
      }),
    ).toBe(true)

    const text = renderGoalDomain(authority.readDomain("t"), 61_000)
    expect(text).toContain("source: sha256:old")
    expect(text).toContain("last verified: 1m ago")
    expect(text).toContain(`checkpoint: rev ${currentRevision} · 1 receipts`)
  })

  test("GOAL-05 rail 12 — checkpoint/last-verified are DERIVED, with no separate storage", () => {
    const authority = createObjectiveAuthority({ now: () => 1_000, idFactory: () => "goal-2" })
    authority.create("t", { goal: "ship", successCriteria: ["manual only"] })
    // No receipts, no verifier evidence yet ⇒ both fields must read as absent,
    // not as a stale stored value.
    const empty = renderGoalDomain(authority.readDomain("t"), 2_000)
    expect(empty).toContain("checkpoint: none")
    expect(empty).toContain("last verified: never")
    expect(empty).toContain("source: unverified")

    // A receipt is the ONLY input for the checkpoint line: adding one moves it.
    const revision = authority.readDomain("t").revision
    expect(
      authority.recordProgressReceipt("t", {
        objectiveId: "goal-2",
        attemptKey: "attempt-9",
        objectiveRevisionBefore: revision,
        objectiveRevisionAfter: revision,
        turnOutcome: "completed",
        criterionTransitions: [],
        verifierReceiptRefs: [],
        remainingCriterionIds: [],
        recordedAt: 1_500,
      }),
    ).toBe(true)
    const withReceipt = renderGoalDomain(authority.readDomain("t"), 2_000)
    expect(withReceipt).toContain(`checkpoint: rev ${revision} · 1 receipts`)
    // Still never verified: a progress receipt is NOT verifier evidence.
    expect(withReceipt).toContain("last verified: never")
    expect(withReceipt).toContain("source: unverified")
  })
})
