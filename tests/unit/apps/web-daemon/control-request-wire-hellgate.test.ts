/**
 * ★ HELLGATE — web-daemon control-request PRODUCER wire (ADR-0496 A1 live).
 *
 * The jul-03 A1 drain-wire hellgate proved the LOOP edge (`pollControlRequests`
 * drains a wired port). But NOTHING produced a request — the protocol was inert.
 * This pins the MISSING PRODUCER end-to-end on the web-daemon surface with the
 * REAL collaborators: a `controlRequest` WS frame string → `peekControlRequest`
 * (the connection-layer decode) → `enqueue` onto the real
 * `createWebControlRequestPort` → `drainControlRequests` (the REAL loop-side
 * drain + the REAL pure `planControlRequest`) → the applier LANDS the effect on
 * a LIVE mutable `permission` cell (the exact shape `runtime-factory` builds).
 *
 * The LOAD-BEARING proof: `set_permission_mode` ACTUALLY changes the live
 * `permission.mode` — the per-turn gate reads it fresh, so the mode flips
 * mid-session (not a logged no-op). Mutation-red: break the applier / the
 * planner allowlist / the decoder ⇒ the effect never lands ⇒ red.
 *
 * Invariants proven (red-on-injection):
 *   1. DECODE — a well-formed `controlRequest` frame ⇒ the typed request; a
 *      garbage / non-controlRequest frame ⇒ null (falls through to the bridge).
 *   2. END-TO-END — frame → peek → enqueue → drain → apply mutates the LIVE
 *      permission cell (the effect LANDS on the host).
 *   3. FAIL-CLOSED — an off-allowlist permission mode is REJECTED (the planner's
 *      privilege-boundary guard) ⇒ the live cell is UNCHANGED.
 *   4. BOUNDED — a flooding client cannot grow the pending queue past the cap.
 *   5. NON-PERMISSION axes surface via the observe sink (honest, not faked) — no
 *      live cell mutation for model/thinking/usage.
 */
import { describe, expect, test } from "bun:test"
import { drainControlRequests } from "@/agent/control-request"
import { peekControlRequest } from "@/apps/web-daemon/control-request-frame"
import {
  createWebControlRequestPort,
  MAX_PENDING_CONTROL_REQUESTS,
} from "@/apps/web-daemon/web-control-request-port"
import type { PermissionContext } from "@/permission"

const frame = (request: unknown): string => JSON.stringify({ kind: "controlRequest", request })

/** A live mutable permission cell — the exact getter/setter shape
 *  `runtime-factory` builds (per-turn gate reads `.mode` fresh). */
const liveCell = (): PermissionContext => {
  let mode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  }
}

describe("peekControlRequest — decode contract", () => {
  test("well-formed frames ⇒ typed requests", () => {
    expect(peekControlRequest(frame({ kind: "set_permission_mode", mode: "acceptEdits" }))).toEqual(
      { kind: "set_permission_mode", mode: "acceptEdits" },
    )
    expect(peekControlRequest(frame({ kind: "set_model", model: "gpt-x" }))).toEqual({
      kind: "set_model",
      model: "gpt-x",
    })
    expect(peekControlRequest(frame({ kind: "set_thinking", level: "high" }))).toEqual({
      kind: "set_thinking",
      level: "high",
    })
    expect(peekControlRequest(frame({ kind: "get_context_usage" }))).toEqual({
      kind: "get_context_usage",
    })
  })

  test("non-controlRequest / malformed frames ⇒ null (fall through to the bridge)", () => {
    for (const raw of [
      JSON.stringify({ kind: "planInputAnswer", promptId: "p" }),
      JSON.stringify({ kind: "followerVerb", verb: { kind: "steer-turn" } }),
      JSON.stringify({ kind: "controlRequest" }), // no request
      JSON.stringify({ kind: "controlRequest", request: 42 }),
      JSON.stringify({ kind: "controlRequest", request: [1, 2] }), // array
      JSON.stringify({ kind: "controlRequest", request: { kind: "nope" } }), // unknown kind
      JSON.stringify({ kind: "controlRequest", request: { kind: "set_model" } }), // missing model
      JSON.stringify({ kind: "controlRequest", request: { kind: "set_permission_mode" } }), // missing mode
      JSON.stringify({ kind: "controlRequest", request: { kind: "set_model", model: 7 } }), // non-string
      JSON.stringify([1, 2, 3]),
      "not json {",
      "null",
    ]) {
      expect(peekControlRequest(raw)).toBeNull()
    }
  })
})

describe("web control-request END-TO-END — frame → port → drain → LIVE cell", () => {
  test("LOAD-BEARING: set_permission_mode frame flips the LIVE permission cell mid-session", () => {
    const permission = liveCell()
    const handle = createWebControlRequestPort({ permission })
    expect(permission.mode).toBe("default")

    // Client sends the frame; the server peeks + enqueues.
    const req = peekControlRequest(frame({ kind: "set_permission_mode", mode: "bypass" }))
    expect(req).not.toBeNull()
    if (req === null) throw new Error("unreachable")
    handle.enqueue(req)
    expect(handle.pendingCount()).toBe(1)

    // The loop drains + applies against the LIVE allowlists (the REAL planner).
    const applied = drainControlRequests(handle.port, handle.context, handle.applier)

    // The effect LANDED on the host: the live gate cell actually changed.
    expect(permission.mode).toBe("bypass")
    expect(applied).toEqual([{ kind: "permission-mode-set", mode: "bypass" }])
    expect(handle.pendingCount()).toBe(0)
  })

  test("FAIL-CLOSED: an unknown permission mode is REJECTED ⇒ the live cell is UNCHANGED", () => {
    const permission = liveCell()
    const handle = createWebControlRequestPort({ permission })
    // "sudo" is not a PermissionMode — the planner rejects it (privilege boundary).
    const req = peekControlRequest(frame({ kind: "set_permission_mode", mode: "sudo" }))
    if (req === null) throw new Error("unreachable")
    handle.enqueue(req)
    const applied = drainControlRequests(handle.port, handle.context, handle.applier)
    expect(permission.mode).toBe("default") // untouched
    expect(applied).toEqual([{ kind: "rejected", reason: 'permission mode "sudo" not recognized' }])
  })

  test("model allowlist gating: off-list model ⇒ rejected; on-list ⇒ observed (no live cell)", () => {
    const permission = liveCell()
    const observed: Array<{ kind: string; value: string }> = []
    const handle = createWebControlRequestPort({
      permission,
      modelAllowlist: ["gpt-x", "gpt-y"],
      observe: (e) => observed.push(e),
    })
    handle.enqueue({ kind: "set_model", model: "gpt-z" }) // off-list
    handle.enqueue({ kind: "set_model", model: "gpt-y" }) // on-list
    const applied = drainControlRequests(handle.port, handle.context, handle.applier)
    expect(applied[0]?.kind).toBe("rejected")
    expect(applied[1]).toEqual({ kind: "model-set", model: "gpt-y" })
    // Model is a NON-permission axis: no live cell mutation, surfaced honestly.
    expect(permission.mode).toBe("default")
    expect(observed).toContainEqual({ kind: "model", value: "gpt-y" })
    expect(observed).toContainEqual({ kind: "rejected", value: 'model "gpt-z" not recognized' })
  })

  test("get_context_usage: usage snapshot returned as a DEFENSIVE copy (observed)", () => {
    const permission = liveCell()
    const observed: Array<{ kind: string; value: string }> = []
    const usage = { inputTokens: 10, totalTokens: 12 }
    const handle = createWebControlRequestPort({
      permission,
      usage,
      observe: (e) => observed.push(e),
    })
    handle.enqueue({ kind: "get_context_usage" })
    const applied = drainControlRequests(handle.port, handle.context, handle.applier)
    expect(applied[0]?.kind).toBe("usage")
    if (applied[0]?.kind === "usage") {
      expect(applied[0].usage).toEqual(usage)
      // Defensive copy — mutating the returned snapshot must not corrupt the source.
      ;(applied[0].usage as { inputTokens?: number }).inputTokens = 999
      expect(usage.inputTokens).toBe(10)
    }
    expect(observed.some((e) => e.kind === "usage")).toBe(true)
  })
})

describe("web control-request port — safety invariants", () => {
  test("BOUNDED: a flooding client cannot grow the pending queue past the cap", () => {
    const handle = createWebControlRequestPort({ permission: liveCell() })
    for (let i = 0; i < MAX_PENDING_CONTROL_REQUESTS + 20; i++) {
      handle.enqueue({ kind: "set_permission_mode", mode: "default" })
    }
    expect(handle.pendingCount()).toBe(MAX_PENDING_CONTROL_REQUESTS)
  })

  test("latest-wins: when full, the OLDEST is dropped so the freshest intent survives", () => {
    const permission = liveCell()
    const handle = createWebControlRequestPort({ permission })
    // Fill with a benign default, then push one MORE that is the real intent.
    for (let i = 0; i < MAX_PENDING_CONTROL_REQUESTS; i++) {
      handle.enqueue({ kind: "set_permission_mode", mode: "default" })
    }
    handle.enqueue({ kind: "set_permission_mode", mode: "acceptEdits" }) // drops oldest
    const applied = drainControlRequests(handle.port, handle.context, handle.applier)
    // The freshest request is the LAST applied ⇒ the final live mode is acceptEdits.
    expect(applied.at(-1)).toEqual({ kind: "permission-mode-set", mode: "acceptEdits" })
    expect(permission.mode).toBe("acceptEdits")
  })

  test("NO-THROW: a throwing observe sink does not derail the drain (permission still lands)", () => {
    const permission = liveCell()
    const handle = createWebControlRequestPort({
      permission,
      observe: () => {
        throw new Error("hostile sink")
      },
    })
    handle.enqueue({ kind: "set_model", model: "anything" }) // triggers observe (throws, swallowed)
    handle.enqueue({ kind: "set_permission_mode", mode: "bypass" })
    // The drain must not throw and the permission effect must still land.
    expect(() => drainControlRequests(handle.port, handle.context, handle.applier)).not.toThrow()
    expect(permission.mode).toBe("bypass")
  })
})
