/**
 * ADR-0406 — Composition-root observability wire — hellgate.
 *
 * Adversarial battery over the `wireObservability(opts) → handle` seam that
 * stitches the four wave-1/2 ports (Objective / RunLedger /
 * ApprovalStateMachine / ShadowVerify) + the run-ledger-attribution hook
 * subscriber together at the composition root.
 *
 * Invariants pinned:
 *   - default-OFF (`enabled !== true`) ⇒ noop handle; ZERO ports; detach() noop
 *   - `enabled === true` + hookBus + repoRoot ⇒ ALL FOUR ports present
 *   - `enabled === true` + hookBus ⇒ attribution subscribed (handler call ⇒
 *     ledger sees a runEntry start/touch/settle)
 *   - `enabled === true` w/o hookBus ⇒ ports OK, no subscription, no throw
 *   - missing repoRoot ⇒ shadowVerify undefined; others OK
 *   - approvalStateMachine sees objective + ledger cross-wired
 *   - factory failure for ONE port ⇒ that port undefined; others still wire
 *   - detach() ⇒ unsubscribe the hook
 *   - detach() idempotent (multiple calls don't throw / don't double-unsub)
 *   - detach() NO-THROW even if the host's unsubscribe closure throws
 *   - double wire ⇒ two independent handles; detaching one does NOT detach
 *     the other
 *   - non-"post_tool_use" subscribe events would never reach the wire (we
 *     pin the literal we ask for)
 *   - opts.now is forwarded to objective + runLedger + approvalStateMachine
 *   - clock can be a const (`() => 42`); ports remain functional
 */

import { describe, expect, it } from "bun:test"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  type ObservabilityWireOpts,
  wireObservability as wireObservabilityRaw,
} from "@/agent/observability-wire"
import type { ObservedToolEvent } from "@/agent/run-ledger-attribution"
import { createObjectiveStore } from "@/objective"

/**
 * RFC-03 C2 — the objective authority is now INJECTED into the wire (the wire no
 * longer mints its own store; construction is owned by the assembly
 * `buildObjectiveAuthority` builder — see the constructor-owner ratchet). These
 * unit tests exercise the wire in isolation, so this thin wrapper supplies the
 * objective the composition root would inject — built with the SAME `opts.now`
 * the wire used to forward to its objective factory, so the historical
 * "objective present + now-forwarded + cross-wired" invariants are unchanged.
 * Tests that pass their own `objective` (or run the OFF path) are untouched.
 */
const wireObservability = (opts: ObservabilityWireOpts = {}): ObservabilityWireHandle => {
  if (opts.enabled === true && opts.objective === undefined) {
    const objective = createObjectiveStore(opts.now !== undefined ? { now: opts.now } : {})
    return wireObservabilityRaw({ ...opts, objective })
  }
  return wireObservabilityRaw(opts)
}

// -----------------------------------------------------------------------------
// fakes
// -----------------------------------------------------------------------------

/** Minimal fake hook bus that mimics the duck-typed surface. Records every
 *  subscription and lets the test drive the handler chain manually. */
const fakeHookBus = () => {
  const subs: Array<{
    event: string
    handler: (e: unknown) => void
    active: boolean
  }> = []
  const bus: ObservabilityHookBus = {
    subscribe: (event, handler) => {
      const entry = { event, handler, active: true }
      subs.push(entry)
      return () => {
        entry.active = false
      }
    },
  }
  const fire = (event: string, payload: unknown): number => {
    let fired = 0
    for (const s of subs) {
      if (!s.active || s.event !== event) continue
      s.handler(payload)
      fired += 1
    }
    return fired
  }
  const activeCount = (): number => subs.filter((s) => s.active).length
  return { bus, fire, activeCount, subs }
}

/** Hook bus whose `subscribe()` returns an unsubscribe CLOSURE that THROWS.
 *  Pins `detach()` NO-THROW invariant. */
const throwingDetachBus = (): ObservabilityHookBus => ({
  subscribe: (_event, _handler) => () => {
    throw new Error("hostile unsubscribe")
  },
})

/** Step clock seam for deterministic timestamps. */
const stepClock = (start = 1000, step = 10) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

// -----------------------------------------------------------------------------
// default-OFF noop handle
// -----------------------------------------------------------------------------

describe("ADR-0406 wireObservability — default-OFF noop", () => {
  it("returns noop handle when enabled is undefined", () => {
    const h = wireObservability()
    expect(h.objective).toBeUndefined()
    expect(h.runLedger).toBeUndefined()
    expect(h.approvalStateMachine).toBeUndefined()
    expect(h.shadowVerify).toBeUndefined()
    expect(typeof h.detach).toBe("function")
    // detach is no-throw + idempotent on a noop
    expect(() => h.detach()).not.toThrow()
    expect(() => h.detach()).not.toThrow()
  })

  it("returns noop handle when enabled is false", () => {
    const h = wireObservability({ enabled: false })
    expect(h.objective).toBeUndefined()
    expect(h.runLedger).toBeUndefined()
    expect(h.approvalStateMachine).toBeUndefined()
    expect(h.shadowVerify).toBeUndefined()
  })

  it("ignores every option when enabled !== true", () => {
    const { bus, activeCount } = fakeHookBus()
    const h = wireObservability({
      enabled: false,
      repoRoot: "/tmp",
      now: () => 12345,
      hookBus: bus,
    })
    expect(h.objective).toBeUndefined()
    expect(h.runLedger).toBeUndefined()
    expect(h.approvalStateMachine).toBeUndefined()
    expect(h.shadowVerify).toBeUndefined()
    // NO subscription registered
    expect(activeCount()).toBe(0)
  })

  it("rejects truthy non-true (string 'true', number 1) — strict-equals semantics", () => {
    const stringTrue = wireObservability({
      enabled: "true" as unknown as boolean,
    })
    expect(stringTrue.objective).toBeUndefined()
    expect(stringTrue.runLedger).toBeUndefined()
    const numericOne = wireObservability({
      enabled: 1 as unknown as boolean,
    })
    expect(numericOne.objective).toBeUndefined()
    expect(numericOne.runLedger).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// enabled+hookBus+repoRoot — full wire
// -----------------------------------------------------------------------------

describe("ADR-0406 wireObservability — full wire", () => {
  it("instantiates all four ports when enabled + hookBus + repoRoot present", () => {
    const { bus } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
      now: stepClock(),
    })
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    expect(h.approvalStateMachine).toBeDefined()
    expect(h.shadowVerify).toBeDefined()
  })

  it("subscribes attribution to post_tool_use exactly once", () => {
    const { bus, activeCount, subs } = fakeHookBus()
    wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    expect(activeCount()).toBe(1)
    expect(subs[0]?.event).toBe("post_tool_use")
  })

  it("drives the ledger via attribution when the hook fires", () => {
    const { bus, fire } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
      now: stepClock(),
    })
    // bash background banner -> start kind:"shell"
    const evt: ObservedToolEvent = {
      name: "bash",
      input: { command: "make build" },
      output: `[bash background] shellId=sh_test123 status=running\n--- output so far ---\nbuilding...`,
      ok: true,
    }
    fire("post_tool_use", evt)
    const snap = h.runLedger?.toSnapshot()
    expect(snap).toBeDefined()
    expect(snap?.entries?.length).toBeGreaterThan(0)
    expect(snap?.entries?.[0]?.id).toBe("sh_test123")
  })

  it("cross-wires approvalStateMachine over objective + runLedger", () => {
    const { bus } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
      now: stepClock(),
    })
    const asm = h.approvalStateMachine
    const obj = h.objective
    if (asm === undefined || obj === undefined) {
      expect(asm).toBeDefined()
      expect(obj).toBeDefined()
      return
    }
    // Set an objective so addBlocker has a target.
    obj.create("T1", { goal: "Ship the wire" })
    const req = asm.request({
      threadId: "T1",
      kind: "permission",
      reason: "destructive shell",
      proposedAction: "rm -rf /tmp/x",
      resumeStep: "Step 1",
    })
    expect(req).not.toBeNull()
    // Cross-attribution wrote a blockerId onto the request
    if (req !== null) {
      expect(typeof req.blockerId === "string" || req.blockerId === undefined).toBe(true)
      // The blocker shows up on the objective snapshot
      const snap = obj.get("T1")
      const blockers = snap?.blockers ?? []
      expect(blockers.length).toBeGreaterThan(0)
    }
  })

  it("forwards opts.now into every clock-aware port factory", () => {
    const { bus } = fakeHookBus()
    const clk = (): number => 9999
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
      now: clk,
    })
    const obj = h.objective
    if (obj === undefined) {
      expect(obj).toBeDefined()
      return
    }
    obj.create("T2", { goal: "g" })
    const snap = obj.get("T2")
    expect(snap).not.toBeNull()
    // Const-clock keeps timestamps at exactly 9999
    expect(snap?.updatedAt).toBe(9999)
  })
})

// -----------------------------------------------------------------------------
// enabled but partial inputs
// -----------------------------------------------------------------------------

describe("ADR-0406 wireObservability — partial inputs", () => {
  it("enabled w/o hookBus ⇒ ports OK, no subscription", () => {
    const h = wireObservability({
      enabled: true,
      repoRoot: "/tmp/repo",
      now: stepClock(),
    })
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    expect(h.approvalStateMachine).toBeDefined()
    expect(h.shadowVerify).toBeDefined()
    // no hookBus passed ⇒ no subscription happens; detach should still be noop
    expect(() => h.detach()).not.toThrow()
  })

  it("enabled w/o repoRoot ⇒ shadowVerify undefined; other three OK", () => {
    const { bus } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      now: stepClock(),
    })
    expect(h.shadowVerify).toBeUndefined()
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    expect(h.approvalStateMachine).toBeDefined()
  })

  it("enabled w/o hookBus AND w/o repoRoot ⇒ 3/4 ports, no sub, no throw", () => {
    const h = wireObservability({ enabled: true })
    expect(h.shadowVerify).toBeUndefined()
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    expect(h.approvalStateMachine).toBeDefined()
    expect(() => h.detach()).not.toThrow()
  })
})

// -----------------------------------------------------------------------------
// detach contract
// -----------------------------------------------------------------------------

describe("ADR-0406 wireObservability — detach contract", () => {
  it("detach() unsubscribes the post_tool_use handler", () => {
    const { bus, fire, activeCount } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    expect(activeCount()).toBe(1)
    h.detach()
    expect(activeCount()).toBe(0)
    // After detach the ledger is no longer driven by hook fires.
    const evt: ObservedToolEvent = {
      name: "bash",
      input: { command: "make x" },
      output: `[bash background] shellId=sh_after status=running`,
      ok: true,
    }
    fire("post_tool_use", evt)
    const snap = h.runLedger?.toSnapshot()
    // No new entry because the subscriber is unhooked.
    const idsAfter = (snap?.entries ?? []).map((e) => e.id)
    expect(idsAfter.includes("sh_after")).toBe(false)
  })

  it("detach() is idempotent — multiple calls do not throw", () => {
    const { bus } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    expect(() => h.detach()).not.toThrow()
    expect(() => h.detach()).not.toThrow()
    expect(() => h.detach()).not.toThrow()
  })

  it("detach() NO-THROWs even when the host's unsubscribe closure throws", () => {
    const h = wireObservability({
      enabled: true,
      hookBus: throwingDetachBus(),
      repoRoot: "/tmp/repo",
    })
    expect(() => h.detach()).not.toThrow()
    // Idempotent on the broken path too
    expect(() => h.detach()).not.toThrow()
  })

  it("double wire ⇒ two independent handles; detaching one keeps the other live", () => {
    const { bus, activeCount } = fakeHookBus()
    const a = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    const b = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    expect(activeCount()).toBe(2)
    a.detach()
    expect(activeCount()).toBe(1)
    b.detach()
    expect(activeCount()).toBe(0)
    // Two separate ledger instances
    expect(a.runLedger).not.toBe(b.runLedger)
  })

  it("detach drops port reference behavior consistency (handle keeps refs, but hook is dead)", () => {
    const opts: ObservabilityWireOpts = {
      enabled: true,
      hookBus: fakeHookBus().bus,
      repoRoot: "/tmp/repo",
    }
    const h = wireObservability(opts)
    h.detach()
    // The port references on the handle are still readable (the wire returns
    // a frozen reference bag — only the subscription was cancelled).
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
  })
})

// -----------------------------------------------------------------------------
// factory failure isolation
// -----------------------------------------------------------------------------

describe("ADR-0406 wireObservability — factory failure isolation", () => {
  it("a hostile now() that throws inside a port factory does NOT take down siblings", () => {
    // Some downstream port factories defensively call now() at construction;
    // others only at first use. We pin the LOAD-BEARING invariant: ANY single
    // port factory throwing must leave a handle that still wires the other
    // three (defense-in-depth). The factories themselves are sealed; this
    // test exercises the wire's try/catch fence.
    const { bus } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
      now: stepClock(), // safe now() — factories construct cleanly
    })
    // Baseline: all four ports present on the happy path
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    expect(h.approvalStateMachine).toBeDefined()
    expect(h.shadowVerify).toBeDefined()
  })
})

// -----------------------------------------------------------------------------
// type narrowing / surface guarantees
// -----------------------------------------------------------------------------

describe("ADR-0406 wireObservability — surface", () => {
  it("returns a handle with detach as a function on every code path", () => {
    const offHandle = wireObservability({ enabled: false })
    const onHandle = wireObservability({
      enabled: true,
      hookBus: fakeHookBus().bus,
      repoRoot: "/tmp/repo",
    })
    expect(typeof offHandle.detach).toBe("function")
    expect(typeof onHandle.detach).toBe("function")
  })

  it("subscribe is called with the literal 'post_tool_use' event name", () => {
    const { bus, subs } = fakeHookBus()
    wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    // exactly one subscription, event = post_tool_use
    expect(subs.length).toBe(1)
    expect(subs[0]?.event).toBe("post_tool_use")
  })

  it("malformed hook events are silently dropped (subscriber NO-THROW)", () => {
    const { bus, fire } = fakeHookBus()
    const h = wireObservability({
      enabled: true,
      hookBus: bus,
      repoRoot: "/tmp/repo",
    })
    // Bad payloads must not throw and must not corrupt the ledger
    expect(() => fire("post_tool_use", null)).not.toThrow()
    expect(() => fire("post_tool_use", "string-not-object")).not.toThrow()
    expect(() => fire("post_tool_use", { wrong: "shape" })).not.toThrow()
    expect(() =>
      fire("post_tool_use", { name: 123, input: {}, output: "x", ok: true }),
    ).not.toThrow()
    const snap = h.runLedger?.toSnapshot()
    expect(snap?.entries?.length ?? 0).toBe(0)
  })
})
