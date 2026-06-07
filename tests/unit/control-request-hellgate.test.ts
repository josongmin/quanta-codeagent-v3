/**
 * Hellgate — control-request runtime surface (ADR-0496).
 *
 * A SINGLE typed channel for mid-session runtime control the host can issue to a
 * live agent — the net-new controls Claude Code exposes that quanta lacked as a
 * unified surface: set_model, set_permission_mode, set_thinking, get_context_usage.
 * (interrupt / cancel_subagent / set_mode / set_brief already live in SubmissionOp;
 * the ADR documents the consolidation path.)
 *
 * `planControlRequest(req, ctx)` is a PURE planner: it validates each request
 * against caller-supplied allowlists (the slice invents NO model/mode/level
 * vocabulary — the composition root passes the real sets) and returns a typed
 * ControlEffect. NEVER throws; an invalid/garbage request ⇒ a typed `rejected`.
 *
 * Invariants:
 *   1. Each kind maps to its effect on the happy path.
 *   2. Off-allowlist model / mode / level ⇒ rejected (fail-closed), not applied.
 *   3. get_context_usage ⇒ usage when a snapshot is present, else rejected.
 *   4. NO-THROW on a malformed request shape.
 *   5. Exhaustive kind coverage (the closed array matches the union).
 *   6. Default-OFF helper: isControlRequestEnabled gated via @/shared SSOT.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_CONTROL_REQUEST_KINDS,
  type ControlRequest,
  isControlRequestEnabled,
  planControlRequest,
} from "@/agent/control-request"

const ctx = {
  modelAllowlist: ["gpt-5", "claude-opus-4-8"],
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
  thinkingLevels: ["off", "low", "medium", "high"],
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, contextWindow: 200000 },
}

describe("control-request — happy path", () => {
  test("set_model in allowlist ⇒ model-set", () => {
    const e = planControlRequest({ kind: "set_model", model: "gpt-5" }, ctx)
    expect(e).toEqual({ kind: "model-set", model: "gpt-5" })
  })
  test("set_permission_mode valid ⇒ permission-mode-set", () => {
    const e = planControlRequest({ kind: "set_permission_mode", mode: "acceptEdits" }, ctx)
    expect(e).toEqual({ kind: "permission-mode-set", mode: "acceptEdits" })
  })
  test("set_thinking valid ⇒ thinking-set", () => {
    const e = planControlRequest({ kind: "set_thinking", level: "high" }, ctx)
    expect(e).toEqual({ kind: "thinking-set", level: "high" })
  })
  test("get_context_usage with snapshot ⇒ usage", () => {
    const e = planControlRequest({ kind: "get_context_usage" }, ctx)
    expect(e.kind).toBe("usage")
    if (e.kind === "usage") expect(e.usage.totalTokens).toBe(150)
  })
  test("R2 F2: usage is a defensive COPY — mutating it cannot corrupt host state", () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
    const e = planControlRequest({ kind: "get_context_usage" }, { usage })
    expect(e.kind).toBe("usage")
    if (e.kind === "usage") {
      expect(e.usage).not.toBe(usage) // different object reference
      ;(e.usage as { totalTokens: number }).totalTokens = 999
      expect(usage.totalTokens).toBe(3) // host snapshot intact
    }
  })
})

describe("control-request — fail-closed validation", () => {
  test("off-allowlist model ⇒ rejected, not applied", () => {
    const e = planControlRequest({ kind: "set_model", model: "evil-model" }, ctx)
    expect(e.kind).toBe("rejected")
  })
  test("invalid permission mode ⇒ rejected", () => {
    const e = planControlRequest({ kind: "set_permission_mode", mode: "yolo" }, ctx)
    expect(e.kind).toBe("rejected")
  })
  test("invalid thinking level ⇒ rejected", () => {
    const e = planControlRequest({ kind: "set_thinking", level: "ultra" }, ctx)
    expect(e.kind).toBe("rejected")
  })
  test("get_context_usage without snapshot ⇒ rejected", () => {
    const e = planControlRequest({ kind: "get_context_usage" }, { ...ctx, usage: undefined })
    expect(e.kind).toBe("rejected")
  })
  test("empty model string ⇒ rejected", () => {
    const e = planControlRequest({ kind: "set_model", model: "" }, ctx)
    expect(e.kind).toBe("rejected")
  })
  test("no allowlist provided ⇒ set_model accepted (host opted out of gating)", () => {
    const e = planControlRequest({ kind: "set_model", model: "anything" }, { usage: undefined })
    expect(e).toEqual({ kind: "model-set", model: "anything" })
  })
  test("SECURITY: set_permission_mode with ABSENT allowlist ⇒ rejected (fail-closed)", () => {
    // The permission axis is a privilege boundary — unlike model/thinking it must
    // NOT accept on an absent allowlist (would let a model set "bypass").
    const e = planControlRequest({ kind: "set_permission_mode", mode: "bypassPermissions" }, {
      usage: undefined,
    })
    expect(e.kind).toBe("rejected")
  })
  test("SECURITY: 'bypassPermissions' rejected when not in the explicit allowlist", () => {
    const e = planControlRequest(
      { kind: "set_permission_mode", mode: "bypassPermissions" },
      { permissionModes: ["default", "plan"] },
    )
    expect(e.kind).toBe("rejected")
  })
})

describe("control-request — no-throw / adversarial", () => {
  test("malformed request shape ⇒ rejected, never throws", () => {
    const e = planControlRequest({ kind: "nonsense" } as unknown as ControlRequest, ctx)
    expect(e.kind).toBe("rejected")
  })
  test("null/undefined request ⇒ rejected", () => {
    expect(planControlRequest(null as unknown as ControlRequest, ctx).kind).toBe("rejected")
    expect(planControlRequest(undefined as unknown as ControlRequest, ctx).kind).toBe("rejected")
  })
})

describe("control-request — exhaustive coverage + gate", () => {
  test("ALL_CONTROL_REQUEST_KINDS matches the union", () => {
    expect([...ALL_CONTROL_REQUEST_KINDS].sort()).toEqual(
      ["get_context_usage", "set_model", "set_permission_mode", "set_thinking"].sort(),
    )
  })
  test("isControlRequestEnabled is default-OFF, opt-in via SSOT", () => {
    expect(isControlRequestEnabled({})).toBe(false)
    expect(isControlRequestEnabled({ QUANTA_CONTROL_REQUEST: "1" })).toBe(true)
    expect(isControlRequestEnabled({ QUANTA_CONTROL_REQUEST: "on" })).toBe(true)
    expect(isControlRequestEnabled({ QUANTA_CONTROL_REQUEST: "off" })).toBe(false)
    expect(isControlRequestEnabled({ QUANTA_CONTROL_REQUEST: "" })).toBe(false)
  })
})
