/**
 * ★ HELLGATE — follower approval-relay TIMEOUT coordinator (T02 LIVE timeout).
 *
 * The production home of T02's request/response/**timeout** for approvals. Two
 * layers under test:
 *
 *   A. Pure timing/stale discipline with an injected clock + a recording sink:
 *      open→relay-in-time applies; relay-after-deadline is STALE (dropped);
 *      sweep fires the fail-safe DENY once; close marks resolved-elsewhere;
 *      DISABLED (timeoutMs<=0) is pass-through; untracked relay passes through.
 *
 *   B. LIVE wiring against the REAL approval resolver (no mock): `respond` is
 *      bound to `createRuntimeApprovalProtocolController.resolveApproval`, so a
 *      relayed approve of a HARD_DENY command is vetoed at the resolver (no
 *      lease), and a timed-out approval's late approve never reaches it.
 */
import { describe, expect, test } from "bun:test"
import {
  createFollowerApprovalCoordinator,
  type FollowerApprovalResponder,
} from "@/agent/thread-follower"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import type { ToolAction } from "@/permission"

/* ── A. Pure timing discipline ─────────────────────────────────────────────── */
const recorder = () => {
  const calls: Array<{ id: string; decision: string; steer?: string }> = []
  const respond: FollowerApprovalResponder = (id, decision, steer) =>
    calls.push(steer !== undefined ? { id, decision, steer } : { id, decision })
  return { calls, respond }
}

describe("approval coordinator — timing/stale discipline (timeout ENABLED)", () => {
  test("open → relay in time ⇒ applied, responder called once", () => {
    const { calls, respond } = recorder()
    let t = 0
    const c = createFollowerApprovalCoordinator({ respond, now: () => t, timeoutMs: 100 })
    expect(c.open("a1")).toBe(true)
    t = 50
    expect(c.relay("a1", "approve")).toEqual({ kind: "applied" })
    expect(calls).toEqual([{ id: "a1", decision: "approve" }])
  })

  test("relay AFTER the deadline ⇒ stale, responder NOT called (no stale-decision)", () => {
    const { calls, respond } = recorder()
    let t = 0
    const c = createFollowerApprovalCoordinator({ respond, now: () => t, timeoutMs: 100 })
    c.open("a1")
    t = 101
    expect(c.relay("a1", "approve")).toEqual({ kind: "stale", reason: "timed_out" })
    expect(calls).toEqual([])
  })

  test("sweep fires the fail-safe DENY once; later relay is stale", () => {
    const { calls, respond } = recorder()
    let t = 0
    const c = createFollowerApprovalCoordinator({ respond, now: () => t, timeoutMs: 100 })
    c.open("a1")
    c.open("a2")
    t = 200
    expect(
      c
        .sweep()
        .map((x) => x.approvalId)
        .sort(),
    ).toEqual(["a1", "a2"])
    expect(calls).toEqual([
      { id: "a1", decision: "deny" },
      { id: "a2", decision: "deny" },
    ])
    expect(c.sweep()).toEqual([]) // once only
    t = 250
    expect(c.relay("a1", "approve").kind).toBe("stale") // late approve dropped
    expect(calls.filter((x) => x.id === "a1")).toEqual([{ id: "a1", decision: "deny" }])
  })

  test("close marks resolved-elsewhere ⇒ sweep skips + later relay is stale", () => {
    const { calls, respond } = recorder()
    let t = 0
    const c = createFollowerApprovalCoordinator({ respond, now: () => t, timeoutMs: 100 })
    c.open("a1")
    c.close("a1") // the local operator answered via approval.respond
    t = 200
    expect(c.sweep()).toEqual([]) // no fallback for an already-resolved approval
    expect(c.relay("a1", "approve")).toEqual({ kind: "stale", reason: "already_resolved" })
    expect(calls).toEqual([])
  })

  test("untracked relay (missed open) passes through — never drops a real decision", () => {
    const { calls, respond } = recorder()
    const c = createFollowerApprovalCoordinator({ respond, now: () => 5, timeoutMs: 100 })
    expect(c.relay("ghost", "deny").kind).toBe("applied")
    expect(calls).toEqual([{ id: "ghost", decision: "deny" }])
  })

  test("prune evicts terminal entries so the tracker stays bounded (long-lived daemon)", () => {
    const { calls, respond } = recorder()
    const t = 0
    const c = createFollowerApprovalCoordinator({ respond, now: () => t, timeoutMs: 100 })
    for (let i = 0; i < 50; i++) {
      c.open(`a${i}`)
      c.relay(`a${i}`, "approve") // each resolves immediately (in time)
    }
    expect(c.pending()).toBe(0) // all resolved
    expect(c.prune()).toBe(50) // …and all evicted
    expect(calls).toHaveLength(50)
    void t
  })

  test("deny carries steer through", () => {
    const { calls, respond } = recorder()
    const c = createFollowerApprovalCoordinator({ respond, now: () => 5, timeoutMs: 100 })
    c.open("a1")
    c.relay("a1", "deny", "use read instead")
    expect(calls).toEqual([{ id: "a1", decision: "deny", steer: "use read instead" }])
  })
})

describe("approval coordinator — DISABLED (timeoutMs<=0) is pass-through", () => {
  test("open no-ops; relay responds immediately; sweep does nothing", () => {
    const { calls, respond } = recorder()
    const c = createFollowerApprovalCoordinator({ respond, now: () => 0, timeoutMs: 0 })
    expect(c.open("a1")).toBe(false)
    expect(c.relay("a1", "approve").kind).toBe("applied")
    expect(c.sweep()).toEqual([])
    expect(calls).toEqual([{ id: "a1", decision: "approve" }])
  })
})

/* ── B. LIVE wiring against the REAL approval resolver ──────────────────────── */
type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>
const makeCtrl = (): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  const base = {
    registry: { extractShellCommand: () => null },
    approvalProtocol: { confirmSlot: slot },
  }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}
const bash = (command: string): ToolAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
  shellCommand: command,
})
const reqApproval = async (
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
  throw new Error("expected approval")
}
const coordFor = (ctrl: Ctrl, now: () => number) =>
  createFollowerApprovalCoordinator({
    respond: (id, decision, steer) =>
      ctrl.resolveApproval(id, decision, steer !== undefined ? { steer } : undefined),
    now,
    timeoutMs: 100,
  })

describe("approval coordinator → REAL resolver (HARD_DENY + timeout end-to-end)", () => {
  test("relay-approve of a HARD_DENY command in time ⇒ resolver vetoes, no lease (re-prompts)", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await reqApproval(ctrl, slot, bash("rm -rf /"))
    const c = coordFor(ctrl, () => 10)
    c.open(id)
    expect(c.relay(id, "approve").kind).toBe("applied") // forwarded to resolver…
    // …but the resolver's live HARD_DENY re-check minted NO lease ⇒ re-prompts.
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bash("rm -rf /"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("benign approve in time ⇒ lease claimed (no re-prompt)", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await reqApproval(ctrl, slot, bash("ls"))
    const c = coordFor(ctrl, () => 10)
    c.open(id)
    expect(c.relay(id, "approve").kind).toBe("applied")
    let confirmed = false
    await ctrl.runWithProtocol(async () => {
      confirmed = await slot.current(bash("ls"))
    })
    expect(confirmed).toBe(true)
  })

  test("late approve ⇒ resolver NEVER called; sweep denied it; action re-prompts", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await reqApproval(ctrl, slot, bash("ls"))
    let t = 0
    const c = createFollowerApprovalCoordinator({
      respond: (i, d, s) => ctrl.resolveApproval(i, d, s !== undefined ? { steer: s } : undefined),
      now: () => t,
      timeoutMs: 100,
    })
    c.open(id)
    t = 200
    expect(c.sweep().map((x) => x.approvalId)).toEqual([id]) // fail-safe deny fired
    expect(c.relay(id, "approve", undefined).kind).toBe("stale") // late approve dropped
    // Deny minted no lease ⇒ the action re-prompts (the late approve never landed).
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bash("ls"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })
})
