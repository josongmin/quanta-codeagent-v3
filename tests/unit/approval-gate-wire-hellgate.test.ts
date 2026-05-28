/**
 * ADR-0407 — Approval-gate wire hellgate.
 *
 * Closed-port adapter that wraps `ApprovalStateMachinePort.request(...)` +
 * `settle(...)` around an existing HITL resolver. Wiring point lives at the
 * admissibility-gate boundary; this hellgate proves the contract in isolation.
 *
 * Invariants pinned:
 *   - SM undefined ⇒ legacy passthrough: resolver invoked once, decision
 *     returned verbatim, `approvalId === ""`, NO calls to SM (it's absent).
 *   - SM present + approve resolver ⇒ request() called once, settle("approve")
 *     once, decision==="approve", approvalId === request.id.
 *   - SM present + deny resolver ⇒ settle("deny") with no modifiedAction.
 *   - SM present + modify resolver ⇒ settle("modify") with modifiedAction.
 *   - SM present + resolver returns bare ApprovalDecision string ⇒ supported
 *     (caller may return either the string OR { decision, modifiedAction? }).
 *   - Resolver throws ⇒ settle("deny") called + the throw propagates verbatim.
 *   - Hostile SM whose request() throws ⇒ NO-THROW at gate boundary; resolver
 *     still invoked, approvalId falls back to "" (legacy shape).
 *   - Hostile SM whose settle() throws ⇒ NO-THROW; resolution still returned.
 *   - cancel(approvalId) ⇒ SM.cancel called once; idempotent (a 2nd cancel is
 *     a no-op + does not double-call SM.cancel beyond passing through).
 *   - cancel("") ⇒ no-op (empty id is the legacy / unattributed marker).
 *   - cancel(approvalId) when SM undefined ⇒ no-op, no throw.
 *   - Concurrent open() calls don't conflate IDs (each gets its own id; each
 *     settle targets its own id).
 *   - Adapter return shape is frozen: caller mutating `.approvalId` /
 *     `.decision` / `.modifiedAction` does not affect anything internal.
 *   - Request payload is forwarded verbatim (kind/reason/proposedAction/
 *     resumeStep/options/threadId) to SM.request.
 *   - `now` clock seam is honored for the underlying SM (composition smoke).
 */

import { describe, expect, it } from "bun:test"
import { type ApprovalGateRequest, createApprovalGate } from "@/agent/approval-gate-wire"
import {
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStateMachinePort,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"

const baseReq = (over: Partial<ApprovalGateRequest> = {}): ApprovalGateRequest => ({
  threadId: over.threadId ?? "thread-1",
  kind: over.kind ?? "permission",
  reason: over.reason ?? "user must approve mutating action",
  proposedAction: over.proposedAction ?? "bash rm -rf node_modules",
  resumeStep: over.resumeStep ?? "step-42",
  ...(over.options !== undefined ? { options: over.options } : {}),
})

/** Record SM calls for assertion without coupling to the in-memory store. */
const recordingSM = (
  overrides: Partial<ApprovalStateMachinePort> = {},
): {
  sm: ApprovalStateMachinePort
  calls: {
    request: number
    settle: Array<{ id: string; decision: ApprovalDecision; modifiedAction?: string }>
    cancel: string[]
  }
} => {
  const inner = createApprovalStateMachine()
  const calls = {
    request: 0,
    settle: [] as Array<{ id: string; decision: ApprovalDecision; modifiedAction?: string }>,
    cancel: [] as string[],
  }
  const sm: ApprovalStateMachinePort = {
    request: (req) => {
      calls.request += 1
      return overrides.request ? overrides.request(req) : inner.request(req)
    },
    settle: (id, decision, opts) => {
      const e: { id: string; decision: ApprovalDecision; modifiedAction?: string } = {
        id,
        decision,
        ...(opts?.modifiedAction !== undefined ? { modifiedAction: opts.modifiedAction } : {}),
      }
      calls.settle.push(e)
      return overrides.settle
        ? overrides.settle(id, decision, opts)
        : inner.settle(id, decision, opts)
    },
    expire: (id) => (overrides.expire ? overrides.expire(id) : inner.expire(id)),
    cancel: (id) => {
      calls.cancel.push(id)
      return overrides.cancel ? overrides.cancel(id) : inner.cancel(id)
    },
    get: (id) => (overrides.get ? overrides.get(id) : inner.get(id)),
    list: (filter) => (overrides.list ? overrides.list(filter) : inner.list(filter)),
    pending: () => (overrides.pending ? overrides.pending() : inner.pending()),
    toSnapshot: () => (overrides.toSnapshot ? overrides.toSnapshot() : inner.toSnapshot()),
    fromSnapshot: (snap) =>
      overrides.fromSnapshot ? overrides.fromSnapshot(snap) : inner.fromSnapshot(snap),
  }
  return { sm, calls }
}

describe("approval-gate-wire (ADR-0407)", () => {
  it("SM undefined ⇒ resolver invoked once + approvalId is empty (legacy passthrough)", async () => {
    const gate = createApprovalGate({})
    let resolverCalls = 0
    const out = await gate.open(baseReq(), async () => {
      resolverCalls += 1
      return "approve"
    })
    expect(resolverCalls).toBe(1)
    expect(out.decision).toBe("approve")
    expect(out.approvalId).toBe("")
    expect(out.modifiedAction).toBeUndefined()
  })

  it("SM undefined + deny resolver ⇒ returned verbatim", async () => {
    const gate = createApprovalGate({})
    const out = await gate.open(baseReq(), async () => "deny")
    expect(out.decision).toBe("deny")
    expect(out.approvalId).toBe("")
  })

  it("SM undefined + modify resolver ⇒ modifiedAction preserved", async () => {
    const gate = createApprovalGate({})
    const out = await gate.open(baseReq(), async () => ({
      decision: "modify",
      modifiedAction: "ls -la",
    }))
    expect(out.decision).toBe("modify")
    expect(out.modifiedAction).toBe("ls -la")
    expect(out.approvalId).toBe("")
  })

  it("SM present + approve ⇒ request+settle called once + approvalId minted", async () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => "approve")
    expect(calls.request).toBe(1)
    expect(calls.settle.length).toBe(1)
    expect(calls.settle[0]?.decision).toBe("approve")
    expect(out.decision).toBe("approve")
    expect(out.approvalId.length).toBeGreaterThan(0)
    expect(calls.settle[0]?.id).toBe(out.approvalId)
  })

  it("SM present + deny ⇒ settle('deny') with no modifiedAction", async () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => "deny")
    expect(calls.settle[0]?.decision).toBe("deny")
    expect(calls.settle[0]?.modifiedAction).toBeUndefined()
    expect(out.decision).toBe("deny")
  })

  it("SM present + modify ⇒ settle('modify') with modifiedAction", async () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => ({
      decision: "modify",
      modifiedAction: "echo safe",
    }))
    expect(calls.settle[0]?.decision).toBe("modify")
    expect(calls.settle[0]?.modifiedAction).toBe("echo safe")
    expect(out.decision).toBe("modify")
    expect(out.modifiedAction).toBe("echo safe")
  })

  it("SM present + resolver returns bare ApprovalDecision string ⇒ same as object form", async () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => "approve")
    expect(out.decision).toBe("approve")
    expect(calls.settle[0]?.decision).toBe("approve")
  })

  it("Resolver throws ⇒ settle('deny') called AND throw propagates", async () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    const err = new Error("resolver-boom")
    let caught: unknown
    try {
      await gate.open(baseReq(), async () => {
        throw err
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(err)
    expect(calls.settle.length).toBe(1)
    expect(calls.settle[0]?.decision).toBe("deny")
  })

  it("SM.request throws ⇒ gate is NO-THROW; resolver still invoked + approvalId === ''", async () => {
    let resolverCalls = 0
    const { sm } = recordingSM({
      request: () => {
        throw new Error("hostile-request")
      },
    })
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => {
      resolverCalls += 1
      return "approve"
    })
    expect(resolverCalls).toBe(1)
    expect(out.decision).toBe("approve")
    expect(out.approvalId).toBe("")
  })

  it("SM.settle throws ⇒ gate is NO-THROW; resolution still returned", async () => {
    let resolverCalls = 0
    const { sm } = recordingSM({
      settle: () => {
        throw new Error("hostile-settle")
      },
    })
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => {
      resolverCalls += 1
      return "approve"
    })
    expect(resolverCalls).toBe(1)
    expect(out.decision).toBe("approve")
    expect(out.approvalId.length).toBeGreaterThan(0)
  })

  it("cancel(approvalId) ⇒ SM.cancel called once with that id", () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    gate.cancel("some-id")
    expect(calls.cancel).toEqual(["some-id"])
  })

  it("cancel('') ⇒ no SM.cancel call (legacy/unattributed marker)", () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    gate.cancel("")
    expect(calls.cancel.length).toBe(0)
  })

  it("cancel(...) when SM undefined ⇒ no throw, no observable effect", () => {
    const gate = createApprovalGate({})
    expect(() => gate.cancel("anything")).not.toThrow()
  })

  it("cancel is idempotent at the gate boundary (caller-side; passes through to SM each time)", () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    gate.cancel("id-a")
    gate.cancel("id-a")
    // SM is responsible for terminal-state idempotency; the gate passes through
    // verbatim. The key invariant is NO-THROW + same id each time.
    expect(calls.cancel).toEqual(["id-a", "id-a"])
  })

  it("cancel + SM.cancel throws ⇒ no propagation", () => {
    const { sm } = recordingSM({
      cancel: () => {
        throw new Error("hostile-cancel")
      },
    })
    const gate = createApprovalGate({ approvalSM: sm })
    expect(() => gate.cancel("x")).not.toThrow()
  })

  it("Concurrent open() calls don't conflate IDs", async () => {
    const { sm, calls } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    const [a, b] = await Promise.all([
      gate.open(baseReq({ threadId: "t-a" }), async () => "approve"),
      gate.open(baseReq({ threadId: "t-b" }), async () => "deny"),
    ])
    expect(a.approvalId).not.toBe(b.approvalId)
    expect(a.approvalId.length).toBeGreaterThan(0)
    expect(b.approvalId.length).toBeGreaterThan(0)
    expect(calls.request).toBe(2)
    expect(calls.settle.length).toBe(2)
    // Each settle hits its own id.
    const settledIds = new Set(calls.settle.map((s) => s.id))
    expect(settledIds.size).toBe(2)
    expect(settledIds.has(a.approvalId)).toBe(true)
    expect(settledIds.has(b.approvalId)).toBe(true)
  })

  it("Adapter return shape is frozen (mutating fields throws in strict mode / is silently ignored)", async () => {
    const gate = createApprovalGate({})
    const out = await gate.open(baseReq(), async () => "approve")
    // The frozen guarantee is "can't mutate state through this reference".
    // In strict mode this throws; in sloppy mode it silently fails. Either way
    // the field stays put.
    try {
      ;(out as { decision: ApprovalDecision }).decision = "deny"
    } catch {
      // strict mode — expected
    }
    expect(out.decision).toBe("approve")
  })

  it("Request payload is forwarded verbatim to SM.request", async () => {
    const captured: Array<unknown> = []
    const { sm } = recordingSM({
      request: (req) => {
        captured.push(req)
        // Return a synthetic pending request for the gate to settle.
        const fake: ApprovalRequest = {
          id: "fake-id",
          threadId: (req as { threadId: string }).threadId,
          kind: (req as { kind: ApprovalKind }).kind,
          reason: (req as { reason: string }).reason,
          proposedAction: (req as { proposedAction: string }).proposedAction,
          resumeStep: (req as { resumeStep: string }).resumeStep,
          status: "pending",
          createdAt: 1,
        }
        return fake
      },
    })
    const gate = createApprovalGate({ approvalSM: sm })
    await gate.open(
      baseReq({
        threadId: "T",
        kind: "clarification",
        reason: "ambiguous goal",
        proposedAction: "do X",
        resumeStep: "S",
        options: ["a", "b"],
      }),
      async () => "approve",
    )
    expect(captured.length).toBe(1)
    const r = captured[0] as Record<string, unknown>
    expect(r.threadId).toBe("T")
    expect(r.kind).toBe("clarification")
    expect(r.reason).toBe("ambiguous goal")
    expect(r.proposedAction).toBe("do X")
    expect(r.resumeStep).toBe("S")
    expect(r.options).toEqual(["a", "b"])
  })

  it("approvalId is the id returned by SM.request (not regenerated)", async () => {
    const { sm } = recordingSM({
      request: () => {
        const fake: ApprovalRequest = {
          id: "pinned-id-xyz",
          threadId: "t",
          kind: "permission",
          reason: "r",
          proposedAction: "p",
          resumeStep: "s",
          status: "pending",
          createdAt: 1,
        }
        return fake
      },
    })
    const gate = createApprovalGate({ approvalSM: sm })
    const out = await gate.open(baseReq(), async () => "approve")
    expect(out.approvalId).toBe("pinned-id-xyz")
  })

  it("Composition smoke — real SM, real store, real now clock seam", async () => {
    let t = 5000
    const sm = createApprovalStateMachine({ now: () => ++t })
    const gate = createApprovalGate({ approvalSM: sm, now: () => t })
    const out = await gate.open(baseReq(), async () => "approve")
    expect(out.decision).toBe("approve")
    expect(out.approvalId.length).toBeGreaterThan(0)
    const stored = sm.get(out.approvalId)
    expect(stored?.status).toBe("approved")
    expect(stored?.decision).toBe("approve")
  })

  it("Unknown resolver decision string ⇒ coerced via SM (deny) + propagated through", async () => {
    // The gate forwards whatever the resolver returns; the SM coerces unknown
    // decision enums to "deny" per its own NO-THROW contract. The gate must
    // surface the SM's coercion (the post-settle record's decision) — not
    // fabricate one. The gate's contract returns the resolver's stated decision
    // verbatim; SM coercion is observable only via inspection of stored record.
    const { sm } = recordingSM()
    const gate = createApprovalGate({ approvalSM: sm })
    // Cast through unknown — a hostile resolver returns an out-of-enum value.
    const out = await gate.open(baseReq(), async () => "bogus" as unknown as ApprovalDecision)
    // Gate returns what the resolver said (string), SM stores it coerced.
    expect(out.decision).toBe("bogus" as ApprovalDecision)
    const stored = sm.get(out.approvalId)
    // SM coerces unknown ⇒ "deny" + "denied" status.
    expect(stored?.decision).toBe("deny")
  })
})
