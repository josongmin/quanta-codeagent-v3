/**
 * UUX-2-21 Hellgate — brain-mode's approval posture is ONE named policy, not a
 * split-brain of inline lambdas.
 *
 * Ground truth (verified against the runtime, jul-10): brain-mode wires NO
 * `approvalProtocol.confirmSlot`, so:
 *   - `onConfirm` is the LIVE seam — the permission gate calls
 *     `AgentConfig.onConfirm` directly; DENY (false) is the active fail-closed
 *     posture (a deny is a normal tool_result; the loop continues, no deadlock).
 *   - `resolveApproval` is the DEFERRED protocol seam, structurally UNREACHABLE
 *     on this surface today (`RuntimeApprovalRequiredError` is thrown only by
 *     the protocol controller's `runOnConfirm`, which is installed only via a
 *     `confirmSlot`; without it `turn.approvalRequest` is always undefined).
 *     "approve" is deadlock INSURANCE mirroring headless (ADR-0303), required
 *     because the shared `runSessionTurn` driver takes the port unconditionally.
 *
 * The asymmetry (gate denies / deferred approves) is therefore INTENTIONAL and
 * pinned here as a paired control — bench score safety: this battery goes red
 * if either verb drifts.
 *
 *   §1 posture values — gateConfirm resolves DENY; deferred resolves "approve".
 *   §2 wiring pin — the module consumes the named policy at BOTH seams and no
 *      inline split-brain lambda remains (the UUX-2-21 bug shape).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BENCH_APPROVAL_POSTURE } from "./brain-approval-posture"

describe("UUX-2-21 §1 — BENCH_APPROVAL_POSTURE values (paired-control pin)", () => {
  test("gate-confirm (LIVE seam) DENIES: fail-closed, no operator on the box", async () => {
    const decision = await BENCH_APPROVAL_POSTURE.onConfirm({
      tool: "bash",
      input: { command: "rm -rf /" },
    } as never)
    expect(decision).toBe(false)
  })

  test("deferred approval (dead seam today) APPROVES: deadlock insurance, headless parity", async () => {
    const decision = await BENCH_APPROVAL_POSTURE.resolveApproval({
      approvalId: "a-1",
      reason: "tool bash requires approval",
      requestedAt: new Date().toISOString(),
    } as never)
    expect(decision).toBe("approve")
  })
})

describe("UUX-2-21 §2 — both seams consume the ONE policy (no inline split-brain)", () => {
  const source = readFileSync(join(import.meta.dir, "brain-mode.ts"), "utf8")

  test("brain-mode spells NO inline approval lambda (the drift shape this ticket fixed)", () => {
    // The exact split-brain literals UUX-2-21 found at ~:568/:610/:687/:857.
    // The verbs now live ONLY in `brain-approval-posture.ts`; brain-mode may
    // only REFERENCE the policy const.
    expect(source).not.toContain('resolveApproval: async () => "approve"')
    expect(source).not.toContain("onConfirm: async () => false")
  })

  test("both seams reference the named policy", () => {
    expect(source).toContain("onConfirm: BENCH_APPROVAL_POSTURE.onConfirm")
    expect(source).toContain("resolveApproval: BENCH_APPROVAL_POSTURE.resolveApproval")
    // All THREE runSessionTurn call sites ride the policy (main turn, oracle
    // loop, verify-gate follow-up) — count, so a new inline site cannot sneak in
    // beside the policy-consuming ones.
    const refs = source.match(/resolveApproval: BENCH_APPROVAL_POSTURE\.resolveApproval/g) ?? []
    expect(refs.length).toBe(3)
  })
})
