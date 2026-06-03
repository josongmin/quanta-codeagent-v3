/**
 * ★ HELLGATE — runtime approval `pending` map leak (audit #12).
 *
 * The runtime approval-protocol controller adds a `PendingRuntimeApprovalRecord`
 * to a `pending` Map every time `onConfirm` throws `RuntimeApprovalRequiredError`
 * (an approval awaiting a surface decision). The ONLY removal was
 * `resolveApproval`. So an approval that is requested but NEVER resolved (turn
 * aborted, surface dismissed, user moved on) leaked in `pending` for the host's
 * entire lifetime — unbounded on a long-lived host with frequent prompts.
 *
 * FIX: `runWithProtocol` snapshots the pending keys at scope ENTRY and, in
 * `finally`, drops the survivors — an approval that was already pending when the
 * scope began AND is still pending when it exits carried a full turn unresolved
 * and can never be matched again (its `approvalId` holder is gone). The approval
 * the scope itself creates is added AFTER the snapshot, so it gets a one-turn
 * grace (survives to its resolution, or is drained by the NEXT scope). No
 * arbitrary cap; nesting-safe (each scope drains only what it carried in).
 *
 * These tests pin: (1) the just-created approval survives its own scope,
 * (2) an abandoned approval is drained by the next scope, (3) the resolve→lease
 * flow is intact, (4) resolveApproval still removes immediately, and
 * (5) N abandoned approvals stay bounded (no monotonic growth).
 */
import { describe, expect, test } from "bun:test"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import type { ToolAction } from "@/permission"

type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>

const makeCtrl = (): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  // The controller sets `slot.current = onConfirm` for the duration of a
  // runWithProtocol scope and restores `previous` after; init with a no-op.
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  const registry = { extractShellCommand: () => null } // actionKey = action.tool
  const base = { registry, approvalProtocol: { confirmSlot: slot } }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}

const action = (tool = "bash"): ToolAction => ({ tool, input: {}, isReadOnly: false })

/** Run a scope whose work triggers ONE approval (onConfirm throws). Returns the
 *  thrown approvalId. The error propagates out of runWithProtocol (after its
 *  finally) exactly as it does in the real loop. */
const requestApprovalInScope = async (
  ctrl: Ctrl,
  slot: { current: (a: ToolAction) => Promise<boolean> },
  act: ToolAction,
): Promise<string> => {
  try {
    await ctrl.runWithProtocol(async () => {
      await slot.current(act)
    })
  } catch (e) {
    if (e instanceof RuntimeApprovalRequiredError) return e.approval.approvalId
    throw e
  }
  throw new Error("expected RuntimeApprovalRequiredError")
}

describe("runtime approval pending-map leak (#12)", () => {
  test("1. the just-created approval SURVIVES its own scope (one-turn grace)", async () => {
    const { ctrl, slot } = makeCtrl()
    await requestApprovalInScope(ctrl, slot, action())
    // Added during work, AFTER the entry snapshot ⇒ not drained by this scope.
    expect(ctrl.__pendingSize()).toBe(1)
  })

  test("2. an ABANDONED approval is drained by the NEXT scope (the leak fix)", async () => {
    const { ctrl, slot } = makeCtrl()
    await requestApprovalInScope(ctrl, slot, action())
    expect(ctrl.__pendingSize()).toBe(1)
    // A subsequent unrelated scope: the carried-over approval is still pending
    // at this scope's exit ⇒ drained.
    await ctrl.runWithProtocol(async () => {})
    expect(ctrl.__pendingSize()).toBe(0)
  })

  test("3. resolve→lease flow intact: a resolved approval is claimed (no re-prompt)", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApprovalInScope(ctrl, slot, action("bash"))
    ctrl.resolveApproval(id, "approve") // mints a single-use lease
    expect(ctrl.__pendingSize()).toBe(0) // resolve removes immediately

    let confirmed = false
    await ctrl.runWithProtocol(async () => {
      // Same actionKey ⇒ claims the lease ⇒ returns true, does NOT throw.
      confirmed = await slot.current(action("bash"))
    })
    expect(confirmed).toBe(true)
    expect(ctrl.__pendingSize()).toBe(0)
  })

  test("4. resolveApproval(deny) removes the entry immediately (no lease, no leak)", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApprovalInScope(ctrl, slot, action())
    expect(ctrl.__pendingSize()).toBe(1)
    ctrl.resolveApproval(id, "deny")
    expect(ctrl.__pendingSize()).toBe(0)
    // A denied approval mints NO lease ⇒ the same action re-prompts (fail-closed).
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(action())
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("5. N abandoned approvals stay BOUNDED (no monotonic growth)", async () => {
    const { ctrl, slot } = makeCtrl()
    for (let i = 0; i < 50; i++) {
      // Each scope drains the prior turn's carried-over approval, then creates
      // its own ⇒ size never exceeds the one-turn-grace window.
      await requestApprovalInScope(ctrl, slot, action(`tool-${i}`))
      expect(ctrl.__pendingSize()).toBeLessThanOrEqual(1)
    }
    // One final empty scope drains the last survivor.
    await ctrl.runWithProtocol(async () => {})
    expect(ctrl.__pendingSize()).toBe(0)
  })
})
