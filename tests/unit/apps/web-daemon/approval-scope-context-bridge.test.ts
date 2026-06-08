/**
 * ADR-0512 P3 — web/IDE escalation approval card: the DAEMON bridge.
 *
 * The CLI renders the rich yellow escalation card from the `permission_
 * escalation_requested` STREAM event (`config.stream.emit`). The BROWSER does
 * NOT consume that stream — it consumes the SESSION protocol: the web daemon
 * routes `onConfirm` through `createRuntimeApprovalProtocolController`
 * (`context-binding.ts`), which mints a `PendingApprovalView` and throws
 * `RuntimeApprovalRequiredError`; the kernel turns that into an
 * `approval.requested` session event the browser already renders.
 *
 * The GAP (this file pins it): the skill-scope escalation attaches a
 * `scopeContext` to the `ToolAction` (`decideScopeEscalation` →
 * `action.scopeContext = { activeSkill, reason }`), and that action reaches the
 * daemon's `onConfirm`. But the minted `PendingApprovalView` DROPPED it, so the
 * browser approval event carried NO skill / risk / reason and could only draw a
 * generic approval — never the rich card.
 *
 * Contract pinned here:
 *   1. A NORMAL action (no `scopeContext`) ⇒ the minted approval omits
 *      `scopeContext` ⇒ byte-identical to every pre-ADR-0512 approval.
 *   2. An ESCALATION action (`scopeContext` present) ⇒ the minted approval
 *      carries `scopeContext { activeSkill, reason, risk }`, with `risk` derived
 *      from the action's `isReadOnly` (read-only ⇒ "read-only", else
 *      "mutating") — the SAME distinction the CLI card draws.
 */
import { describe, expect, test } from "bun:test"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import type { ToolAction } from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"

type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>

const makeCtrl = (): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  const registry = { extractShellCommand: () => null }
  const base = { registry, approvalProtocol: { confirmSlot: slot } }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}

/** Run a scope whose work triggers ONE approval (onConfirm throws). Returns the
 *  minted `PendingApprovalView`. */
const requestApprovalInScope = async (
  ctrl: Ctrl,
  slot: { current: (a: ToolAction) => Promise<boolean> },
  act: ToolAction,
): Promise<PendingApprovalView> => {
  try {
    await ctrl.runWithProtocol(async () => {
      await slot.current(act)
    })
  } catch (e) {
    if (e instanceof RuntimeApprovalRequiredError) return e.approval
    throw e
  }
  throw new Error("expected RuntimeApprovalRequiredError")
}

describe("ADR-0512 P3 — daemon approval bridge carries escalation scopeContext", () => {
  test("normal action (no scopeContext) ⇒ approval OMITS scopeContext (byte-identical)", async () => {
    const { ctrl, slot } = makeCtrl()
    const approval = await requestApprovalInScope(ctrl, slot, {
      tool: "bash",
      input: { cmd: "ls" },
      isReadOnly: false,
    })
    expect(approval.scopeContext).toBeUndefined()
    // The legacy 3-field shape is intact.
    expect(typeof approval.approvalId).toBe("string")
    expect(typeof approval.reason).toBe("string")
    expect(typeof approval.requestedAt).toBe("string")
  })

  test("escalation action (mutating) ⇒ approval carries scopeContext with risk='mutating'", async () => {
    const { ctrl, slot } = makeCtrl()
    const approval = await requestApprovalInScope(ctrl, slot, {
      tool: "edit",
      input: { path: "src/foo.ts" },
      isReadOnly: false,
      scopeContext: { activeSkill: "localize-fault", reason: "localize-fault is read-only" },
    })
    expect(approval.scopeContext).toEqual({
      tool: "edit",
      activeSkill: "localize-fault",
      reason: "localize-fault is read-only",
      risk: "mutating",
    })
  })

  test("escalation action (read-only) ⇒ scopeContext.risk='read-only'", async () => {
    const { ctrl, slot } = makeCtrl()
    const approval = await requestApprovalInScope(ctrl, slot, {
      tool: "web_fetch",
      input: { url: "https://x" },
      isReadOnly: true,
      scopeContext: { activeSkill: "localize-fault", reason: "out of scope" },
    })
    expect(approval.scopeContext?.risk).toBe("read-only")
    expect(approval.scopeContext?.activeSkill).toBe("localize-fault")
  })
})
