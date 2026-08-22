/**
 * HELLGATE — jun-6 `permission_request` verdict routing + HARD_DENY floor.
 *
 * The pure `routePermissionHookVerdict` helper is what the gate (dispatch step
 * 3b) consults to map a hook decision into the existing admit / terminal-deny /
 * reviewer arms. The SECURITY headline: a hook `allow` must NEVER override
 * HARD_DENY (the §4.4 floor) — the helper independently refuses to admit a
 * HARD_DENY call even if the gate somehow reached it without the `earlyHardDeny`
 * pull-ahead having already terminated the call.
 *
 * We also drive a FAKE dispatch harness (a tiny model of the gate's step 3b +
 * policy stack) over the bus + helper to prove the end-to-end routing:
 *   - deny ⇒ tool denied BEFORE the policy stack (stack spy never runs)
 *   - allow ⇒ admitted without the policy stack
 *   - ask ⇒ reviewer/onConfirm fires
 *   - NO hook ⇒ byte-identical (policy stack decides as today)
 *   - allow on a HARD_DENY call ⇒ STILL denied (floor holds)
 *   - throwing hook ⇒ fail-closed fall-through to the policy stack
 */
import { describe, expect, test } from "bun:test"
import {
  HookBus,
  type HookPermissionDecision,
  normalizePermissionDecision,
  routePermissionHookVerdict,
} from "@/agent/hooks"

describe("routePermissionHookVerdict — pure routing", () => {
  test("null / undefined ⇒ fallthrough", () => {
    expect(routePermissionHookVerdict(null, false)).toEqual({ arm: "fallthrough" })
    expect(routePermissionHookVerdict(undefined, false)).toEqual({ arm: "fallthrough" })
  })

  test("allow on a normal call ⇒ admit", () => {
    expect(routePermissionHookVerdict({ outcome: "allow" }, false)).toEqual({ arm: "admit" })
  })

  test("deny ⇒ deny arm carries reason (normal call)", () => {
    expect(routePermissionHookVerdict({ outcome: "deny", reason: "no curl" }, false)).toEqual({
      arm: "deny",
      reason: "no curl",
    })
  })

  test("ask ⇒ ask arm", () => {
    expect(routePermissionHookVerdict({ outcome: "ask" }, false)).toEqual({ arm: "ask" })
  })
})

describe("routePermissionHookVerdict — HARD_DENY floor (SECURITY)", () => {
  test("allow on a HARD_DENY call is REFUSED ⇒ deny (denylist wins)", () => {
    const r = routePermissionHookVerdict({ outcome: "allow" }, true, "HARD_DENY: rm -rf /")
    expect(r).toEqual({ arm: "deny", reason: "HARD_DENY: rm -rf /" })
  })

  test("allow on a HARD_DENY call with NO reason still denies (stable fallback)", () => {
    const r = routePermissionHookVerdict({ outcome: "allow" }, true)
    expect(r.arm).toBe("deny")
    if (r.arm === "deny") expect(r.reason.length).toBeGreaterThan(0)
  })

  test("deny on a HARD_DENY call ⇒ still deny (tightening is always honored)", () => {
    expect(routePermissionHookVerdict({ outcome: "deny", reason: "x" }, true)).toEqual({
      arm: "deny",
      reason: "x",
    })
  })

  test("ask on a HARD_DENY call ⇒ ask (moot — earlyHardDeny already terminated; never weakens)", () => {
    expect(routePermissionHookVerdict({ outcome: "ask" }, true)).toEqual({ arm: "ask" })
  })
})

describe("normalizePermissionDecision — fail-closed boundary", () => {
  test("recognizes string + object forms; rejects garbage", () => {
    expect(normalizePermissionDecision({ permission: "allow" })).toEqual({ outcome: "allow" })
    expect(normalizePermissionDecision({ permission: { outcome: "ask" } })).toEqual({
      outcome: "ask",
    })
    expect(normalizePermissionDecision({ permission: "bogus" })).toBeNull()
    expect(normalizePermissionDecision({ permission: { outcome: "bogus" } })).toBeNull()
    expect(normalizePermissionDecision(null)).toBeNull()
    expect(normalizePermissionDecision(42)).toBeNull()
    expect(normalizePermissionDecision({})).toBeNull()
  })
})

/* ---- FAKE dispatch harness: bus + helper + a spied policy stack ---------- */

type StackVerdict = "allow" | "deny" | "ask"
interface HarnessResult {
  final: "admitted" | "denied" | "reviewer"
  reason?: string
  stackConsulted: boolean
  reviewerFired: boolean
}

/**
 * A minimal model of the gate's step-3b + policy stack. Mirrors the real
 * wiring: emit `permission_request` FIRST, route the verdict, and ONLY on
 * `fallthrough` consult the policy stack. HARD_DENY is pulled ahead (the
 * `earlyHardDeny` trigger) when a handler is registered — modeled here by
 * passing `isHardDeny` into the helper.
 */
const fakeDispatch = async (args: {
  bus: HookBus
  name: string
  isHardDeny: boolean
  hardDenyReason?: string
  stack: () => StackVerdict
  onReviewer: () => void
}): Promise<HarnessResult> => {
  const out: HarnessResult = {
    final: "denied",
    stackConsulted: false,
    reviewerFired: false,
  }
  const emit = await args.bus.emit({
    type: "permission_request",
    name: args.name,
    input: { command: "x" },
    tier: "always-confirm",
    cwd: "/repo",
  })
  const decision: HookPermissionDecision | undefined = emit.permissionDecision
  const routing = routePermissionHookVerdict(decision, args.isHardDeny, args.hardDenyReason)
  switch (routing.arm) {
    case "admit":
      out.final = "admitted"
      return out
    case "deny":
      out.final = "denied"
      out.reason = routing.reason
      return out
    case "ask":
      args.onReviewer()
      out.reviewerFired = true
      out.final = "reviewer"
      return out
    case "fallthrough": {
      // No hook decision — the policy stack decides as today (byte-identical).
      out.stackConsulted = true
      const v = args.stack()
      out.final = v === "allow" ? "admitted" : v === "deny" ? "denied" : "reviewer"
      if (v === "ask") {
        args.onReviewer()
        out.reviewerFired = true
      }
      return out
    }
  }
}

describe("fake dispatch — end-to-end routing", () => {
  test("hook deny ⇒ denied BEFORE the policy stack (stack never consulted)", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "deny", reason: "no curl" }))
    let stackRan = false
    const r = await fakeDispatch({
      bus,
      name: "bash",
      isHardDeny: false,
      stack: () => {
        stackRan = true
        return "allow"
      },
      onReviewer: () => {},
    })
    expect(r.final).toBe("denied")
    expect(r.reason).toBe("no curl")
    expect(r.stackConsulted).toBe(false)
    expect(stackRan).toBe(false)
  })

  test("hook allow ⇒ admitted without the policy stack", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "allow" }))
    let stackRan = false
    const r = await fakeDispatch({
      bus,
      name: "write",
      isHardDeny: false,
      stack: () => {
        stackRan = true
        return "deny"
      },
      onReviewer: () => {},
    })
    expect(r.final).toBe("admitted")
    expect(stackRan).toBe(false)
  })

  test("hook ask ⇒ reviewer/onConfirm fires regardless of policy", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "ask" }))
    let reviewerFired = false
    const r = await fakeDispatch({
      bus,
      name: "bash",
      isHardDeny: false,
      stack: () => "allow", // policy would auto-allow — overridden by ask
      onReviewer: () => {
        reviewerFired = true
      },
    })
    expect(r.final).toBe("reviewer")
    expect(reviewerFired).toBe(true)
  })

  test("NO hook configured ⇒ byte-identical (policy stack decides as today)", async () => {
    const bus = new HookBus() // no handler
    let stackRan = false
    const r = await fakeDispatch({
      bus,
      name: "bash",
      isHardDeny: false,
      stack: () => {
        stackRan = true
        return "deny"
      },
      onReviewer: () => {},
    })
    expect(r.stackConsulted).toBe(true)
    expect(stackRan).toBe(true)
    expect(r.final).toBe("denied")
  })

  test("HEADLINE: hook allow on a HARD_DENY call ⇒ STILL denied (floor holds)", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "allow" }))
    let stackRan = false
    const r = await fakeDispatch({
      bus,
      name: "bash",
      isHardDeny: true,
      hardDenyReason: "HARD_DENY: rm -rf /",
      stack: () => {
        stackRan = true
        return "allow"
      },
      onReviewer: () => {},
    })
    expect(r.final).toBe("denied")
    expect(r.reason).toBe("HARD_DENY: rm -rf /")
    // The same allow that admitted the normal call above does NOT admit here.
    expect(stackRan).toBe(false)
  })

  test("throwing hook ⇒ fail-closed fall-through to the policy stack", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => {
      throw new Error("boom")
    })
    let stackRan = false
    const r = await fakeDispatch({
      bus,
      name: "bash",
      isHardDeny: false,
      stack: () => {
        stackRan = true
        return "allow"
      },
      onReviewer: () => {},
    })
    // No decision from the throw ⇒ the gate falls through; policy decides.
    expect(r.stackConsulted).toBe(true)
    expect(stackRan).toBe(true)
    expect(r.final).toBe("admitted")
  })

  test("first-decision-wins composes through the harness", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "allow" }))
    bus.on("permission_request", () => ({ permission: "deny", reason: "late" }))
    const r = await fakeDispatch({
      bus,
      name: "bash",
      isHardDeny: false,
      stack: () => "deny",
      onReviewer: () => {},
    })
    expect(r.final).toBe("admitted")
  })
})
