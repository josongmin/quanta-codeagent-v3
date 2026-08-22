import { describe, expect, test } from "bun:test"
import type { ToolAction } from "@/permission"
import { __testing as approvalTesting } from "../context-binding"

/**
 * ADR-0512 P3 — the approval LEASE must carry the ESCALATION's rich
 * ConfirmDecision (once-vs-session scope, deny+steer) end-to-end, so the
 * surface's 4-verb card is genuinely reachable through the session-protocol
 * approval path — NOT just the synthetic `runAgent` onConfirm the e2e feeds.
 *
 * Audit finding (jun-9 100-point pass): the daemon/CLI approval path resolves
 * `approve | deny` (2 verbs). On a skill-scope escalation the loop FULLY supports
 * `allow_once` (dispatch WITHOUT widening) and `deny_and_steer` (recoverable
 * decline + corrective steer), but the lease collapsed every approve to a bare
 * `true` (⇒ always `allow_session`/widen) and every deny to no-lease (⇒ the turn
 * aborts, no steer). So clicking "Allow once" silently widened for the whole
 * session and "Deny + steer" steered nothing — the card lied.
 *
 * The fix: a lease minted for an ESCALATION approval carries the operator's rich
 * `ConfirmDecision`; `onConfirm` returns it (the loop's `decideScopeEscalation`
 * then honours scope/steer). A NORMAL approval is BYTE-IDENTICAL — its lease has
 * no decision, so `onConfirm` still returns bare `true`.
 */

const makeRegistry = () =>
  ({
    extractShellCommand: () => null,
  }) as unknown as Parameters<
    typeof approvalTesting.createRuntimeApprovalProtocolController
  >[0]["registry"]

const makeCtrl = () => {
  const confirmSlot: { current: ((a: ToolAction) => Promise<unknown>) | undefined } = {
    current: async () => true,
  }
  const base = {
    registry: makeRegistry(),
    approvalProtocol: { confirmSlot },
  } as unknown as Parameters<typeof approvalTesting.createRuntimeApprovalProtocolController>[0]
  return approvalTesting.createRuntimeApprovalProtocolController(base)
}

/** An ESCALATION action carries `scopeContext` — the same field
 *  `decideScopeEscalation` sets and `escalationScopeFields` projects onto the
 *  minted approval. */
const escalationAction = (tool: string): ToolAction => ({
  tool,
  input: {},
  isReadOnly: true,
  scopeContext: { activeSkill: "sealed", reason: `${tool} not in scope` },
})

const plainAction = (tool: string): ToolAction => ({ tool, input: {}, isReadOnly: false })

/** Mint an approval for `action` and return its id (the controller throws a
 *  `RuntimeApprovalRequiredError` carrying the pending approval). */
const mint = async (ctrl: ReturnType<typeof makeCtrl>, action: ToolAction): Promise<string> => {
  let id: string | undefined
  await ctrl.runWithProtocol(async () => {
    try {
      await ctrl.onConfirm(action)
    } catch (e) {
      id = (e as { approval: { approvalId: string } }).approval.approvalId
    }
  })
  if (id === undefined) throw new Error("no approval minted")
  return id
}

describe("ADR-0512 P3 — escalation lease carries the rich ConfirmDecision", () => {
  test("approve {scope:'once'} ⇒ the re-run onConfirm returns {decision:'allow',scope:'once'} (NOT bare true ⇒ no widen)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, escalationAction("peek"))
    ctrl.resolveApproval(id, "approve", { scope: "once" })

    let leased: unknown
    await ctrl.runWithProtocol(async () => {
      leased = await ctrl.onConfirm(escalationAction("peek"))
    })
    expect(leased).toEqual({ decision: "allow", scope: "once" })
  })

  test("approve {scope:'session'} ⇒ the re-run onConfirm returns {decision:'allow',scope:'session'} (widen)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, escalationAction("peek"))
    ctrl.resolveApproval(id, "approve", { scope: "session" })

    let leased: unknown
    await ctrl.runWithProtocol(async () => {
      leased = await ctrl.onConfirm(escalationAction("peek"))
    })
    expect(leased).toEqual({ decision: "allow", scope: "session" })
  })

  test("deny + steer ⇒ the re-run onConfirm returns {decision:'deny_and_steer',steer} (recoverable, not abort)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, escalationAction("peek"))
    ctrl.resolveApproval(id, "deny", { steer: "use grep instead" })

    let leased: unknown
    await ctrl.runWithProtocol(async () => {
      leased = await ctrl.onConfirm(escalationAction("peek"))
    })
    expect(leased).toEqual({ decision: "deny_and_steer", steer: "use grep instead" })
  })

  test("escalation deny WITHOUT steer ⇒ the re-run onConfirm returns {decision:'deny'} (recoverable decline)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, escalationAction("peek"))
    ctrl.resolveApproval(id, "deny")

    let leased: unknown
    await ctrl.runWithProtocol(async () => {
      leased = await ctrl.onConfirm(escalationAction("peek"))
    })
    expect(leased).toEqual({ decision: "deny" })
  })
})

describe("ADR-0512 P3 — NORMAL approvals stay BYTE-IDENTICAL (no scopeContext)", () => {
  test("a normal approve lease still returns bare `true` (not a ConfirmDecision)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, plainAction("write_file"))
    ctrl.resolveApproval(id, "approve")

    let leased: unknown
    await ctrl.runWithProtocol(async () => {
      leased = await ctrl.onConfirm(plainAction("write_file"))
    })
    expect(leased).toBe(true)
  })

  test("a normal approve with an ignored scope arg still returns bare `true` (scope only applies to escalations)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, plainAction("write_file"))
    ctrl.resolveApproval(id, "approve", { scope: "once" })

    let leased: unknown
    await ctrl.runWithProtocol(async () => {
      leased = await ctrl.onConfirm(plainAction("write_file"))
    })
    expect(leased).toBe(true)
  })

  test("a normal deny sets NO lease ⇒ the re-run RE-PROMPTS (byte-identical abort path)", async () => {
    const ctrl = makeCtrl()
    const id = await mint(ctrl, plainAction("write_file"))
    ctrl.resolveApproval(id, "deny")

    let reprompted = false
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(plainAction("write_file"))
      } catch {
        reprompted = true
      }
    })
    expect(reprompted).toBe(true)
  })
})
