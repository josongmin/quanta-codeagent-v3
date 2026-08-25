/**
 * GOAL-02 hellgate — the pure completion contract + validation-contract
 * derivation, independent of the authority plumbing.
 */

import { describe, expect, test } from "bun:test"
import {
  completionSatisfied,
  type Objective,
  type SuccessCriterion,
  validationContractOf,
} from "@/objective"

const OBJ = "obj-1"

const manual = (
  met: boolean,
  actor?: "user" | "system" | "model" | "continuation",
): SuccessCriterion => ({
  kind: "manual",
  id: `m-${actor ?? "none"}-${met}`,
  text: "manual",
  met,
  ...(met && actor !== undefined
    ? {
        completion: {
          source: "manual" as const,
          objectiveId: OBJ,
          actor,
          objectiveRevision: 1,
          verifiedAt: 1,
        },
      }
    : {}),
})

const checked = (
  met: boolean,
  over: Partial<{ checkId: string; passed: boolean; objectiveId: string }> = {},
): SuccessCriterion => ({
  kind: "checked",
  id: "c-1",
  text: "checked",
  met,
  check: {
    id: "chk-1",
    kind: "command",
    argv: ["x"],
    cwdPolicy: "thread",
    timeoutMs: 1,
    successExitCodes: [0],
  },
  ...(met
    ? {
        completion: {
          source: "verifier" as const,
          objectiveId: over.objectiveId ?? OBJ,
          checkId: over.checkId ?? "chk-1",
          objectiveRevision: 1,
          sourceDigest: "sha256:d",
          verifierResult: { exitCode: 0, passed: over.passed ?? true },
          verifiedAt: 1,
        },
      }
    : {}),
})

const objective = (criteria: readonly SuccessCriterion[], blockers = 0): Objective => ({
  objectiveId: OBJ,
  threadId: "t",
  goal: "g",
  createdBy: "user",
  successCriteria: criteria,
  status: "active",
  budget: { tokensUsed: 0, turnsUsed: 0 },
  blockers: Array.from({ length: blockers }, (_, i) => ({
    id: `b${i}`,
    reason: "r",
    waitingOn: "user" as const,
    since: 1,
  })),
  nextActions: [],
  createdAt: 1,
  updatedAt: 1,
})

describe("GOAL-02 — completionSatisfied", () => {
  test("zero criteria is never completed", () => {
    expect(completionSatisfied(objective([]))).toBe(false)
  })
  test("a manual criterion completes only with a user/system attestation", () => {
    expect(completionSatisfied(objective([manual(true, "user")]))).toBe(true)
    expect(completionSatisfied(objective([manual(true, "system")]))).toBe(true)
    expect(completionSatisfied(objective([manual(true, "model")]))).toBe(false)
    expect(completionSatisfied(objective([manual(true, "continuation")]))).toBe(false)
    expect(completionSatisfied(objective([manual(true)]))).toBe(false) // met with no receipt
    expect(completionSatisfied(objective([manual(false)]))).toBe(false)
  })
  test("a checked criterion completes only with a passing verifier receipt bound to its check and generation", () => {
    expect(completionSatisfied(objective([checked(true)]))).toBe(true)
    expect(completionSatisfied(objective([checked(true, { passed: false })]))).toBe(false)
    expect(completionSatisfied(objective([checked(true, { checkId: "other" })]))).toBe(false)
    expect(completionSatisfied(objective([checked(true, { objectiveId: "stale" })]))).toBe(false)
    expect(completionSatisfied(objective([checked(false)]))).toBe(false)
  })
  test("every criterion must be satisfied and no blocker may be open", () => {
    expect(completionSatisfied(objective([manual(true, "user"), checked(true)]))).toBe(true)
    expect(completionSatisfied(objective([manual(true, "user"), checked(false)]))).toBe(false)
    expect(completionSatisfied(objective([manual(true, "user")], 1))).toBe(false)
  })
})

describe("GOAL-02 — validationContractOf", () => {
  test("missing / manual-only / checked", () => {
    expect(validationContractOf(objective([]))).toBe("missing")
    expect(validationContractOf(objective([manual(false)]))).toBe("manual-only")
    expect(validationContractOf(objective([manual(false), checked(false)]))).toBe("checked")
    expect(validationContractOf(objective([checked(false)]))).toBe("checked")
  })
})
