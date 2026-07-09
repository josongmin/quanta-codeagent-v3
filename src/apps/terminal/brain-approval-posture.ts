/**
 * UUX-2-21 — the bench (brain-mode) approval posture: ONE named policy consumed
 * by BOTH approval seams, so the two verbs can never drift apart silently again
 * (the split-brain this ticket fixed: inline `onConfirm: async () => false` at
 * one brain-mode site vs `resolveApproval: async () => "approve"` at three
 * others).
 *
 * The asymmetry (gate DENIES / deferred APPROVES) is INTENTIONAL for bench —
 * verified against the runtime topology, not assumed:
 *
 *  - `onConfirm` — the GATE-CONFIRM (LIVE) seam. Brain-mode wires NO
 *    `approvalProtocol.confirmSlot` (its `createRuntimeFromBootstrap` call
 *    passes no `approvalProtocol` overlay), so the permission gate calls
 *    `AgentConfig.onConfirm` DIRECTLY. No operator is on the box ⇒ fail-closed
 *    DENY: the ask lands as a normal denied tool_result and the loop continues
 *    (a deny never blocks, so there is no deadlock risk on this verb). Keeps
 *    the bench agent inside its sanctioned tool surface — bench score safety.
 *
 *  - `resolveApproval` — the DEFERRED-approval protocol seam, which on THIS
 *    surface is structurally UNREACHABLE today: `RuntimeApprovalRequiredError`
 *    is thrown only by the protocol controller's `runOnConfirm`, which is
 *    installed only via a `confirmSlot` ⇒ `turn.approvalRequest` is always
 *    undefined here. The shared `runSessionTurn` driver takes the port
 *    unconditionally, so a value is required; "approve" mirrors headless
 *    (ADR-0303) as DEADLOCK INSURANCE only — if a future change ever wires the
 *    protocol, a pending approval must not hang a no-operator box run mid-bench.
 *
 *  ⚠ HAZARD (why this is pinned): wiring `approvalProtocol` on this surface
 *  would flip the EFFECTIVE posture from deny-all (gate) to approve-all
 *  (deferred). If that is ever done intentionally, revisit this const — the
 *  paired-control hellgate (`brain-approval-posture.test.ts`) pins both verbs
 *  AND pins that brain-mode spells no inline approval lambda of its own.
 */

import type { AgentConfig } from "@/agent"
import type { ApprovalResolver } from "@/runner/orchestrate/session-turn-driver"

export const BENCH_APPROVAL_POSTURE: {
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
  readonly resolveApproval: ApprovalResolver
} = {
  onConfirm: async () => false,
  resolveApproval: async () => "approve",
}
