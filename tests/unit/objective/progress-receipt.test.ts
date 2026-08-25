import { describe, expect, test } from "bun:test"
import {
  asObjectiveAuthority,
  createObjectiveAuthority,
  MAX_PROGRESS_RECEIPTS,
  MAX_PROGRESS_REF_LENGTH,
  MAX_PROGRESS_REFS,
  normalizeProgressReceipt,
  type ProgressReceipt,
} from "@/objective"
import { objectiveIdOf } from "./v2-helpers"

const receipt = (over: Partial<ProgressReceipt> = {}): ProgressReceipt => ({
  objectiveId: "obj-1",
  attemptKey: "attempt-1",
  objectiveRevisionBefore: 1,
  objectiveRevisionAfter: 1,
  turnOutcome: "completed",
  criterionTransitions: [],
  verifierReceiptRefs: [],
  remainingCriterionIds: [],
  recordedAt: 1,
  ...over,
})

describe("objective progress receipt boundary", () => {
  test("rejects malformed outcomes, backwards revisions, and oversized identity", () => {
    expect(normalizeProgressReceipt(null)).toBeNull()
    expect(normalizeProgressReceipt({ ...receipt(), turnOutcome: "success" })).toBeNull()
    expect(
      normalizeProgressReceipt(receipt({ objectiveRevisionBefore: 2, objectiveRevisionAfter: 1 })),
    ).toBeNull()
    expect(
      normalizeProgressReceipt(receipt({ attemptKey: "x".repeat(MAX_PROGRESS_REF_LENGTH + 1) })),
    ).toBeNull()
    // GOAL-01: a receipt is bound to a generation — no objectiveId ⇒ malformed.
    expect(normalizeProgressReceipt({ ...receipt(), objectiveId: "" })).toBeNull()
    expect(normalizeProgressReceipt({ ...receipt(), objectiveId: undefined })).toBeNull()
  })

  test("caps reference counts and drops oversized reference elements", () => {
    const normalized = normalizeProgressReceipt(
      receipt({
        criterionTransitions: [
          ...Array.from({ length: MAX_PROGRESS_REFS + 5 }, (_, i) => `c-${i}`),
          "x".repeat(MAX_PROGRESS_REF_LENGTH + 1),
        ],
      }),
    )
    expect(normalized?.criterionTransitions).toHaveLength(MAX_PROGRESS_REFS)
    expect(normalized?.criterionTransitions).not.toContain("x".repeat(MAX_PROGRESS_REF_LENGTH + 1))
  })

  test("rejects stale append revisions and retains only the newest bounded window", () => {
    const authority = asObjectiveAuthority(createObjectiveAuthority())
    authority.create("t", { goal: "ship" })
    const objectiveId = objectiveIdOf(authority, "t")
    const revision = authority.readDomain("t").revision
    expect(
      authority.recordProgressReceipt(
        "t",
        receipt({
          objectiveId,
          objectiveRevisionBefore: revision - 1,
          objectiveRevisionAfter: revision - 1,
        }),
      ),
    ).toBe(false)
    for (let i = 0; i < MAX_PROGRESS_RECEIPTS + 3; i++) {
      expect(
        authority.recordProgressReceipt(
          "t",
          receipt({
            objectiveId,
            attemptKey: `attempt-${i}`,
            objectiveRevisionBefore: revision,
            objectiveRevisionAfter: revision,
            recordedAt: i,
          }),
        ),
      ).toBe(true)
    }
    const receipts = authority.readDomain("t").progressReceipts ?? []
    expect(receipts).toHaveLength(MAX_PROGRESS_RECEIPTS)
    expect(receipts[0]?.attemptKey).toBe("attempt-3")
  })

  test("rejects a duplicate attempt key without consuming the bounded window", () => {
    const authority = createObjectiveAuthority()
    authority.create("t", { goal: "ship" })
    const revision = authority.readDomain("t").revision
    const first = receipt({
      objectiveId: objectiveIdOf(authority, "t"),
      attemptKey: "same-attempt",
      objectiveRevisionBefore: revision,
      objectiveRevisionAfter: revision,
    })
    expect(authority.recordProgressReceipt("t", first)).toBe(true)
    expect(authority.recordProgressReceipt("t", { ...first, recordedAt: 2 })).toBe(false)
    expect(authority.readDomain("t").progressReceipts).toHaveLength(1)
  })

  test("GOAL-01: a receipt bound to a generation that is not live is rejected", () => {
    const authority = createObjectiveAuthority()
    authority.create("t", { goal: "ship" })
    const stale = objectiveIdOf(authority, "t")
    // A foreign generation id never attaches.
    expect(
      authority.recordProgressReceipt(
        "t",
        receipt({
          objectiveId: "some-other-objective",
          objectiveRevisionBefore: authority.readDomain("t").revision,
          objectiveRevisionAfter: authority.readDomain("t").revision,
        }),
      ),
    ).toBe(false)
    // After a `replace` the previous generation's id is stale on this thread.
    authority.replace("t", { goal: "ship v2" })
    expect(objectiveIdOf(authority, "t")).not.toBe(stale)
    const revision = authority.readDomain("t").revision
    expect(
      authority.recordProgressReceipt(
        "t",
        receipt({
          objectiveId: stale,
          objectiveRevisionBefore: revision,
          objectiveRevisionAfter: revision,
        }),
      ),
    ).toBe(false)
    expect(authority.readDomain("t").progressReceipts ?? []).toHaveLength(0)
    // The live generation still records.
    expect(
      authority.recordProgressReceipt(
        "t",
        receipt({
          objectiveId: objectiveIdOf(authority, "t"),
          objectiveRevisionBefore: revision,
          objectiveRevisionAfter: revision,
        }),
      ),
    ).toBe(true)
  })
})
