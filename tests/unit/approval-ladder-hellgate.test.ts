/**
 * HELLGATE — approval-ladder named-posture SSOT (T03 / feature 03-guardian).
 *
 * Pins the Codex collaboration-mode matrix mapping EXACTLY (UC3): every named
 * rung resolves to the precise `{sandbox, approvalPolicy, reviewer}` triple, and
 * the SSOT is the SINGLE place that mapping lives.
 *
 * RED-ON-INJECTION pillars:
 *   - `guardian-approvals` is the ONLY rung that hands the reviewer to the agent.
 *     A regression that flips ANY other rung to `agent` (silent auto-approval of
 *     a posture the operator believes is human-gated) is caught.
 *   - `parseApprovalLadderName` fails CLOSED: empty / unknown / `custom` → no rung
 *     (never a silent widen to a permissive posture).
 *   - The table is FROZEN: a consumer cannot mutate a shared rung in place.
 */

import { describe, expect, test } from "bun:test"
import {
  APPROVAL_LADDER,
  APPROVAL_LADDER_NAMES,
  parseApprovalLadderName,
} from "@/permission/approval-ladder"

describe("approval ladder SSOT — exact Codex matrix (UC3)", () => {
  test("each named rung maps to its exact {sandbox, approvalPolicy, reviewer}", () => {
    expect(APPROVAL_LADDER["read-only"]).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "read-only" },
    })
    expect(APPROVAL_LADDER.auto).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspace-write" },
    })
    expect(APPROVAL_LADDER.granular).toEqual({
      approvalPolicy: "always",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspace-write" },
    })
    expect(APPROVAL_LADDER["guardian-approvals"]).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "agent",
      sandboxPolicy: { type: "workspace-write" },
    })
    expect(APPROVAL_LADDER["full-access"]).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "danger-full-access" },
    })
  })

  test("read-only rung refuses writes; full-access never prompts", () => {
    expect(APPROVAL_LADDER["read-only"].sandboxPolicy.type).toBe("read-only")
    expect(APPROVAL_LADDER["full-access"].approvalPolicy).toBe("never")
  })

  test("guardian-approvals is the ONLY agent-reviewer rung (red-on-injection)", () => {
    const agentRungs = (Object.keys(APPROVAL_LADDER) as (keyof typeof APPROVAL_LADDER)[]).filter(
      (k) => APPROVAL_LADDER[k].approvalsReviewer === "agent",
    )
    expect(agentRungs).toEqual(["guardian-approvals"])
  })

  test("table is exhaustive over names except `custom`", () => {
    const tableKeys = Object.keys(APPROVAL_LADDER).sort()
    const expected = APPROVAL_LADDER_NAMES.filter((n) => n !== "custom").sort()
    expect(tableKeys).toEqual([...expected])
    expect(tableKeys).not.toContain("custom")
  })

  test("rungs are frozen — a consumer cannot mutate the shared posture", () => {
    expect(Object.isFrozen(APPROVAL_LADDER)).toBe(true)
    expect(Object.isFrozen(APPROVAL_LADDER["guardian-approvals"])).toBe(true)
    expect(() => {
      // @ts-expect-error — deliberate mutation attempt on a frozen rung
      APPROVAL_LADDER["read-only"].approvalsReviewer = "agent"
    }).toThrow()
    // The shared rung is unchanged after the (rejected) mutation.
    expect(APPROVAL_LADDER["read-only"].approvalsReviewer).toBe("user")
  })
})

describe("parseApprovalLadderName — fail closed", () => {
  test("accepts the five concrete rungs", () => {
    for (const name of [
      "read-only",
      "auto",
      "granular",
      "guardian-approvals",
      "full-access",
    ] as const) {
      expect(parseApprovalLadderName(name)).toBe(name)
    }
  })

  test("rejects custom / unknown / empty / undefined to undefined (no silent widen)", () => {
    expect(parseApprovalLadderName("custom")).toBeUndefined()
    expect(parseApprovalLadderName("bogus")).toBeUndefined()
    expect(parseApprovalLadderName("")).toBeUndefined()
    expect(parseApprovalLadderName(undefined)).toBeUndefined()
    // case sensitive — a near-miss spelling never resolves to a permissive rung
    expect(parseApprovalLadderName("Full-Access")).toBeUndefined()
    expect(parseApprovalLadderName("guardian")).toBeUndefined()
  })
})
