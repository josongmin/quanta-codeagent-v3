/**
 * HELLGATE — jun-6 `permission_request` hook EVENT + `emitPermissionRequest`.
 *
 * Pins the EMITTER half of the new pre-decision hook (the gate hot-path edit is
 * the parent's; these tests use the bus directly, the way the gate will).
 *
 * Surface contract:
 *   - A handler returning `{ permission: "allow" | "deny" | "ask" }` (string OR
 *     object form) surfaces a typed `permissionDecision` on the emit result.
 *   - NO handler / a no-op handler / a malformed response ⇒ NO
 *     `permissionDecision` key (byte-identical, fail-closed: the gate falls
 *     through to the policy stack).
 *   - FIRST decision wins (registration order) — a later handler does not
 *     override an earlier decision.
 *   - A registered `matcher` gates dispatch on the event's tool `name` (like
 *     `pre_tool_use`).
 *   - A THROWING handler does not crash the bus and supplies NO decision
 *     (fail-closed fall-through), and the rest of the chain still runs.
 *   - Caps (`MAX_HANDLERS_PER_EVENT`) + per-handler timeout apply identically.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_HOOK_DENY_REASON,
  HookBus,
  HookRegistrationError,
  MAX_HANDLERS_PER_EVENT,
} from "@/agent/hooks"

const ev = (over: Partial<Parameters<HookBus["emit"]>[0]> = {}) =>
  ({
    type: "permission_request" as const,
    name: "bash",
    input: { command: "ls" },
    tier: "always-confirm" as const,
    cwd: "/repo",
    ...over,
  }) as Extract<Parameters<HookBus["emit"]>[0], { type: "permission_request" }>

describe("emitPermissionRequest — decision surface", () => {
  test("string form: allow", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "allow" }))
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "allow" })
  })

  test("string form: deny carries reason", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "deny", reason: "no curl" }))
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "deny", reason: "no curl" })
  })

  test("string form: deny with NO reason gets a stable default (never empty)", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "deny" }))
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "deny", reason: DEFAULT_HOOK_DENY_REASON })
  })

  test("string form: ask", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "ask" }))
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "ask" })
  })

  test("object form: { permission: { outcome, reason } }", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: { outcome: "deny", reason: "blocked" } }))
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "deny", reason: "blocked" })
  })

  test("handler sees tier + cwd + name + input", async () => {
    const bus = new HookBus()
    const seen: unknown[] = []
    bus.on("permission_request", (e) => {
      seen.push({ name: e.name, tier: e.tier, cwd: e.cwd, input: e.input })
    })
    await bus.emit(ev({ name: "write", tier: "hand-off-required", cwd: "/etc" }))
    expect(seen).toEqual([
      { name: "write", tier: "hand-off-required", cwd: "/etc", input: { command: "ls" } },
    ])
  })
})

describe("emitPermissionRequest — fail-closed / byte-identical", () => {
  test("NO handler ⇒ no permissionDecision key (fall through)", async () => {
    const bus = new HookBus()
    const r = await bus.emit(ev())
    expect("permissionDecision" in r).toBe(false)
    expect(r.deny).toBeNull()
  })

  test("no-op handler (returns nothing) ⇒ no permissionDecision key", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => undefined)
    const r = await bus.emit(ev())
    expect("permissionDecision" in r).toBe(false)
  })

  test("malformed response (out-of-vocabulary outcome) ⇒ no decision", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "YOLO" }))
    const r = await bus.emit(ev())
    expect("permissionDecision" in r).toBe(false)
  })

  test("garbage (no permission key) ⇒ no decision", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ foo: 1 }))
    const r = await bus.emit(ev())
    expect("permissionDecision" in r).toBe(false)
  })

  test("THROWING handler ⇒ no decision, no crash, chain continues", async () => {
    const bus = new HookBus()
    let secondRan = false
    bus.on("permission_request", () => {
      throw new Error("boom")
    })
    bus.on("permission_request", () => {
      secondRan = true
      return { permission: "deny", reason: "second decided" }
    })
    const r = await bus.emit(ev())
    expect(secondRan).toBe(true)
    // The throw is fail-closed (no decision from it); the SECOND handler's deny
    // is honored — a throw never weakens the gate, and never short-circuits it.
    expect(r.permissionDecision).toEqual({ outcome: "deny", reason: "second decided" })
  })
})

describe("emitPermissionRequest — first-decision-wins", () => {
  test("first allow wins over a later deny", async () => {
    const bus = new HookBus()
    let secondConsulted = false
    bus.on("permission_request", () => ({ permission: "allow" }))
    bus.on("permission_request", () => {
      secondConsulted = true
      return { permission: "deny", reason: "too late" }
    })
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "allow" })
    // Second handler still RUNS (registration order, for promptHook/abort), but
    // its decision does not override the first.
    expect(secondConsulted).toBe(true)
  })

  test("a no-op first handler lets the second decide", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => undefined)
    bus.on("permission_request", () => ({ permission: "ask" }))
    const r = await bus.emit(ev())
    expect(r.permissionDecision).toEqual({ outcome: "ask" })
  })
})

describe("emitPermissionRequest — matcher + caps", () => {
  test("matcher gates dispatch on the tool name", async () => {
    const bus = new HookBus()
    bus.on("permission_request", () => ({ permission: "deny", reason: "bash only" }), {
      matcher: "bash",
    })
    const denied = await bus.emit(ev({ name: "bash" }))
    expect(denied.permissionDecision).toEqual({ outcome: "deny", reason: "bash only" })
    const skipped = await bus.emit(ev({ name: "write" }))
    expect("permissionDecision" in skipped).toBe(false)
  })

  test("MAX_HANDLERS_PER_EVENT cap throws on the (cap+1)th registration", () => {
    const bus = new HookBus()
    for (let i = 0; i < MAX_HANDLERS_PER_EVENT; i++) {
      bus.on("permission_request", () => undefined)
    }
    expect(() => bus.on("permission_request", () => undefined)).toThrow(HookRegistrationError)
  })

  test("per-handler timeout: a hanging handler does not block; falls through", async () => {
    const bus = new HookBus()
    bus.on(
      "permission_request",
      () => new Promise(() => {}), // never resolves
      { timeoutMs: 5 },
    )
    const r = await bus.emit(ev())
    // Timed-out handler supplied no decision ⇒ fall through (fail-closed).
    expect("permissionDecision" in r).toBe(false)
    expect(r.timeoutCount).toBe(1)
  })
})
