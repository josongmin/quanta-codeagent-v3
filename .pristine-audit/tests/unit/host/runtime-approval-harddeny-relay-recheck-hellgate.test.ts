/**
 * ★ HELLGATE — HARD_DENY re-check at the approval RESOLVE boundary (T02, LIVE).
 *
 * A follower client co-controls a live thread and may RELAY an approve/deny for a
 * pending approval over the session transport (`approval.respond` →
 * `host.resolveApproval`). The danger: a relayed APPROVE of a dangerous command
 * would mint a grant the local operator never saw. The dispatch gate already
 * denies HARD_DENY commands BEFORE they reach the prompt (earlyHardDeny), so this
 * is defense-in-depth — but it must hold UNCONDITIONALLY: NO approve path, local
 * or relayed, may ever mint a grant for a HARD_DENY command.
 *
 * This pins the re-check at the REAL resolver (`createRuntimeApprovalProtocol
 * controller.resolveApproval`), not a stub: an approve of a HARD_DENY action
 * mints NO lease, so the action re-prompts (fail-closed). RED-on-injection:
 * remove the `if (hardDenyReason(record.action) !== null) return` guard and test 1
 * fails (the dangerous action would be silently granted).
 */
import { describe, expect, test } from "bun:test"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import type { ToolAction } from "@/permission"

type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>

const makeCtrl = (): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  // extractShellCommand → null ⇒ actionKey = action.tool (stable across mint+claim).
  // The HARD_DENY re-check reads `action.shellCommand` (set on the action below),
  // so it fires independent of the registry's extraction.
  const registry = { extractShellCommand: () => null }
  const base = { registry, approvalProtocol: { confirmSlot: slot } }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}

const bashAction = (command: string): ToolAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
  shellCommand: command,
})

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

describe("HARD_DENY relay re-check at resolveApproval (T02)", () => {
  test("1. APPROVE of a HARD_DENY command mints NO lease ⇒ re-prompts (fail-closed)", async () => {
    const { ctrl, slot } = makeCtrl()
    const danger = bashAction("rm -rf /")
    const id = await requestApprovalInScope(ctrl, slot, danger)
    // A follower relays an APPROVE. The re-check must veto it.
    ctrl.resolveApproval(id, "approve")
    expect(ctrl.__pendingSize()).toBe(0) // record removed regardless

    // No lease was minted ⇒ the SAME dangerous action re-prompts rather than
    // riding a grant. If the guard were removed this would NOT throw (RED).
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bashAction("rm -rf /"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("1b. session_prefix APPROVE of a HARD_DENY command mints NO standing grant", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApprovalInScope(ctrl, slot, bashAction("rm -rf /"))
    // The most dangerous relay: an "always allow" prefix grant for a dangerous cmd.
    ctrl.resolveApproval(id, "approve", { scope: "session_prefix" })
    // The standing grant must NOT exist — the action re-prompts.
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bashAction("rm -rf /"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("2. APPROVE of a BENIGN command mints the lease ⇒ claimed, no re-prompt (control)", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApprovalInScope(ctrl, slot, bashAction("ls -la"))
    ctrl.resolveApproval(id, "approve")
    let confirmed = false
    await ctrl.runWithProtocol(async () => {
      confirmed = await slot.current(bashAction("ls -la"))
    })
    // Paired control: the re-check does NOT block legitimate approvals.
    expect(confirmed).toBe(true)
  })

  test("3. DENY of a HARD_DENY command mints no lease (unchanged — denying is always safe)", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApprovalInScope(ctrl, slot, bashAction("rm -rf /"))
    ctrl.resolveApproval(id, "deny")
    expect(ctrl.__pendingSize()).toBe(0)
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bashAction("rm -rf /"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })
})
