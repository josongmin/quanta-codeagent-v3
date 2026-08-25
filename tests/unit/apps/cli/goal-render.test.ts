import { describe, expect, test } from "bun:test"
import { renderGoalDomain } from "@/apps/cli/slash/goal-render"
import { createObjectiveAuthority } from "@/objective"

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
})
