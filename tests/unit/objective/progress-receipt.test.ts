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

const receipt = (over: Partial<ProgressReceipt> = {}): ProgressReceipt => ({
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
    authority.set("t", { goal: "ship" })
    const revision = authority.readDomain("t").revision
    expect(
      authority.recordProgressReceipt(
        "t",
        receipt({
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
    authority.set("t", { goal: "ship" })
    const revision = authority.readDomain("t").revision
    const first = receipt({
      attemptKey: "same-attempt",
      objectiveRevisionBefore: revision,
      objectiveRevisionAfter: revision,
    })
    expect(authority.recordProgressReceipt("t", first)).toBe(true)
    expect(authority.recordProgressReceipt("t", { ...first, recordedAt: 2 })).toBe(false)
    expect(authority.readDomain("t").progressReceipts).toHaveLength(1)
  })
})
