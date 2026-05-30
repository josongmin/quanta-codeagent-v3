import { describe, expect, test } from "bun:test"
import type { ToolAction } from "@/permission"
import { __testing as approvalTesting } from "../context-binding"

/**
 * T03 — Runtime approval & host-side concurrency (audit L5 H-1 / M-2 / M-3).
 *
 * The grant store WAS a session-lifetime `Set<actionKey>` that (a) survived the
 * turn boundary so a single approval auto-passed the first matching action of a
 * LATER turn (H-1, least-privilege break) and (b) was consumed destructively so
 * two concurrent same-actionKey actions raced — the second threw
 * `RuntimeApprovalRequiredError` and aborted the batch (M-3).
 *
 * The lease model: an approval grant is an OPAQUE, single-use lease scoped to
 * one turn/action instance. `resolveApproval(approve)` mints a lease bound to
 * that approval id (NOT a broad action-kind key). A turn-scoped run consumes
 * AT MOST the leases minted for it; a fresh turn starts with a clean ledger.
 */

const makeRegistry = (shellFor: (tool: string, input: unknown) => string | null) =>
  ({
    extractShellCommand: (tool: string, input: unknown) => shellFor(tool, input),
  }) as unknown as Parameters<
    typeof approvalTesting.createRuntimeApprovalProtocolController
  >[0]["registry"]

const makeBase = (registry: ReturnType<typeof makeRegistry>) => {
  const confirmSlot: { current: ((a: ToolAction) => Promise<boolean>) | undefined } = {
    current: async () => true,
  }
  return {
    base: {
      registry,
      approvalProtocol: { confirmSlot },
    } as unknown as Parameters<typeof approvalTesting.createRuntimeApprovalProtocolController>[0],
    confirmSlot,
  }
}

const action = (tool: string, input: unknown = {}): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
})

describe("T03 approval lease — H-1: grants do not leak across the turn boundary", () => {
  test("an approved grant is good for exactly ONE turn — it does not leak to a later turn", async () => {
    const registry = makeRegistry(() => null) // non-shell ⇒ key was tool-name-only
    const { base } = makeBase(registry)
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    // Turn N: action needs approval ⇒ controller mints + throws.
    let mintedId: string | undefined
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("write_file"))
      } catch (e) {
        mintedId = (e as { approval: { approvalId: string } }).approval.approvalId
      }
    })
    expect(mintedId).toBeDefined()
    if (mintedId === undefined) throw new Error("no approval minted")
    ctrl.resolveApproval(mintedId, "approve")

    // Turn N+1 (fresh run scope) runs to completion WITHOUT re-invoking the
    // approved action — e.g. the model changed course. The lease was armed for
    // this turn; because it was not consumed it is cleared at scope exit.
    await ctrl.runWithProtocol(async () => {
      // no write_file this turn
      return undefined
    })

    // Turn N+2: a later write_file must NOT be auto-approved by the stale grant
    // from turn N — least privilege. The pre-T03 session-lifetime grants Set
    // would have silently passed this.
    let leakedAutoApprove = false
    let reprompted = false
    await ctrl.runWithProtocol(async () => {
      try {
        const ok = await ctrl.onConfirm(action("write_file", { path: "/etc/passwd" }))
        leakedAutoApprove = ok === true
      } catch {
        reprompted = true
      }
    })
    expect(leakedAutoApprove).toBe(false)
    expect(reprompted).toBe(true)
  })

  test("the lease auto-passes exactly the re-run of the approved action within the same turn scope", async () => {
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry)
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    let mintedId: string | undefined
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("edit"))
      } catch (e) {
        mintedId = (e as { approval: { approvalId: string } }).approval.approvalId
      }
    })
    if (mintedId === undefined) throw new Error("no approval minted")
    ctrl.resolveApproval(mintedId, "approve")

    // Re-run of the SAME approved action instance auto-passes once.
    let ok = false
    await ctrl.runWithProtocol(async () => {
      ok = (await ctrl.onConfirm(action("edit"))) === true
    })
    expect(ok).toBe(true)
  })
})

describe("T03 approval lease — M-3: concurrent same-actionKey actions do NOT share grant state", () => {
  test("two concurrent same-key actions in one turn each prompt independently (no batch abort)", async () => {
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry)
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    // Approve ONE write_file instance.
    let firstId: string | undefined
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("write_file"))
      } catch (e) {
        firstId = (e as { approval: { approvalId: string } }).approval.approvalId
      }
    })
    if (firstId === undefined) throw new Error("no approval minted")
    ctrl.resolveApproval(firstId, "approve")

    // Two CONCURRENT write_file actions fire. The single lease must satisfy at
    // most one; the OTHER must mint its own approval — never throw a shared-state
    // race that aborts the whole batch.
    const outcomes: Array<"approved" | "reprompt"> = []
    await ctrl.runWithProtocol(async () => {
      await Promise.all([
        (async () => {
          try {
            const ok = await ctrl.onConfirm(action("write_file"))
            outcomes.push(ok ? "approved" : "reprompt")
          } catch {
            outcomes.push("reprompt")
          }
        })(),
        (async () => {
          try {
            const ok = await ctrl.onConfirm(action("write_file"))
            outcomes.push(ok ? "approved" : "reprompt")
          } catch {
            outcomes.push("reprompt")
          }
        })(),
      ])
    })

    // Exactly one auto-approved (the lease), exactly one re-prompted. Neither
    // crashed the batch.
    expect(outcomes.filter((o) => o === "approved").length).toBe(1)
    expect(outcomes.filter((o) => o === "reprompt").length).toBe(1)
  })
})

describe("T03 approval lease — fail-closed when shell extraction throws", () => {
  test("a throwing extractShellCommand forces a prompt (does not collapse to a broad tool-name grant)", async () => {
    const registry = makeRegistry((tool) => {
      if (tool === "bash") throw new Error("malformed shell input")
      return null
    })
    const { base } = makeBase(registry)
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    // Approve a bash action whose extraction throws.
    let mintedId: string | undefined
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("bash", { cmd: "rm -rf /tmp/a" }))
      } catch (e) {
        mintedId = (e as { approval: { approvalId: string } }).approval.approvalId
      }
    })
    expect(mintedId).toBeDefined()
    if (mintedId === undefined) throw new Error("no approval minted")
    ctrl.resolveApproval(mintedId, "approve")

    // A DIFFERENT bash command (also throwing extraction) must NOT inherit the
    // grant — fail closed, re-prompt.
    let reprompted = false
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("bash", { cmd: "rm -rf /" }))
      } catch {
        reprompted = true
      }
    })
    expect(reprompted).toBe(true)
  })
})
