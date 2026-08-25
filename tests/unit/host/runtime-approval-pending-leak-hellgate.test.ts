/**
 * ★ HELLGATE — runtime approval pending lifecycle.
 *
 * The runtime approval-protocol controller adds a `PendingRuntimeApprovalRecord`
 * to a `pending` Map every time `onConfirm` throws `RuntimeApprovalRequiredError`
 * (an approval awaiting a surface decision). The ONLY removal was
 * `resolveApproval`. A later protocol scope is NOT a terminal event, however:
 * the kernel still owns the same `approvalId` in `awaiting_approval` and may
 * dispatch `approval.respond` after unrelated host work. Dropping it early
 * makes the kernel card unresolvable and incorrectly turns a deferred pause
 * into a denial.
 *
 * These tests pin: (1) an approval remains pending across later scopes,
 * (2) its original identity still resolves into a lease, and (3) only an
 * explicit response clears the pending record.
 */
import { describe, expect, test } from "bun:test"
import { type ApprovalGateRequest, createApprovalGate } from "@/agent/approval-gate-wire"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { createRunLedger } from "@/agent/run-ledger"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import { createObjectiveStore } from "@/objective"
import type { ToolAction } from "@/permission"

type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>

const makeCtrl = (
  approvalStateMachine?: ReturnType<typeof createApprovalStateMachine>,
): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  // The controller sets `slot.current = onConfirm` for the duration of a
  // runWithProtocol scope and restores `previous` after; init with a no-op.
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  const registry = { extractShellCommand: () => null } // actionKey = action.tool
  const base = {
    registry,
    approvalProtocol: { confirmSlot: slot },
    ...(approvalStateMachine !== undefined ? { approvalStateMachine } : {}),
  }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}

const action = (tool = "bash"): ToolAction => ({ tool, input: {}, isReadOnly: false })

const approvalRequest = (): ApprovalGateRequest => ({
  threadId: "session-approval",
  kind: "permission",
  reason: "mutating action needs approval",
  proposedAction: "bash apply change",
  resumeStep: "approval.respond",
})

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

describe("runtime approval pending lifecycle", () => {
  test("1. the just-created approval survives its own scope", async () => {
    const { ctrl, slot } = makeCtrl()
    await requestApprovalInScope(ctrl, slot, action())
    expect(ctrl.__pendingSize()).toBe(1)
  })

  test("2. a deferred approval stays pending through a later scope and its original id resolves", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApprovalInScope(ctrl, slot, action())
    expect(ctrl.__pendingSize()).toBe(1)
    // A later scope is not a cancellation/expiry/session-close event. The
    // kernel still owns `id`, so this must remain resolvable.
    await ctrl.runWithProtocol(async () => {})
    expect(ctrl.__pendingSize()).toBe(1)

    await ctrl.resolveApproval(id, "approve")
    expect(ctrl.__pendingSize()).toBe(0)
    let confirmed = false
    await ctrl.runWithProtocol(async () => {
      confirmed = await slot.current(action())
    })
    expect(confirmed).toBe(true)
  })

  test("3. gate deferred error keeps attribution pending until the host resolves the same kernel id", async () => {
    const objective = createObjectiveStore()
    const ledger = createRunLedger()
    const approvalStateMachine = createApprovalStateMachine({ objective, ledger })
    objective.create("session-approval", { goal: "finish safely" })
    const { ctrl, slot } = makeCtrl(approvalStateMachine)
    const gate = createApprovalGate({ approvalSM: approvalStateMachine })
    let id = ""

    try {
      await ctrl.runWithProtocol(async () => {
        await gate.open(approvalRequest(), async () => ({
          decision: (await slot.current(action())) ? "approve" : "deny",
        }))
      })
    } catch (error) {
      if (error instanceof RuntimeApprovalRequiredError) id = error.approval.approvalId
      else throw error
    }

    expect(approvalStateMachine.get(id)?.status).toBe("pending")
    expect(ledger.get(id)?.status).toBe("waiting")
    expect(objective.get("session-approval")?.blockers).toHaveLength(1)

    await ctrl.resolveApproval(id, "approve")
    expect(approvalStateMachine.get(id)?.status).toBe("approved")
    expect(ledger.get(id)?.status).toBe("completed")
    expect(objective.get("session-approval")?.blockers).toHaveLength(0)
  })

  test("4. session close is terminal and cancels a deferred approval", async () => {
    const approvalStateMachine = createApprovalStateMachine()
    const { ctrl, slot } = makeCtrl(approvalStateMachine)
    const id = await requestApprovalInScope(ctrl, slot, action())
    approvalStateMachine.request({
      id,
      threadId: "session-approval",
      kind: "permission",
      reason: "mutating action needs approval",
      proposedAction: "bash apply change",
      resumeStep: "approval.respond",
    })

    ctrl.close()
    expect(ctrl.__pendingSize()).toBe(0)
    expect(approvalStateMachine.get(id)?.status).toBe("cancelled")
  })

  test("5. resolve→lease flow intact: a resolved approval is claimed (no re-prompt)", async () => {
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

  test("6. resolveApproval(deny) removes the entry immediately (no lease, no leak)", async () => {
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
})
