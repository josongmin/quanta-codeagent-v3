/**
 * Hellgate — control-request effect APPLICATION + drain (ADR-0496, live-consume).
 *
 * The planner is proven in control-request-hellgate; this proves the application
 * layer an IDE/web host uses to LAND planned effects:
 *   - applyControlEffect routes each effect to the matching applier callback.
 *   - drainControlRequests pulls every pending request, plans + applies in order.
 *   - BOUNDED (a hostile always-returns port cannot livelock).
 *   - NO-THROW (a thrown port / thrown applier ends the drain cleanly).
 */
import { describe, expect, test } from "bun:test"
import {
  applyControlEffect,
  type ControlEffectApplier,
  type ControlRequest,
  type ControlRequestContext,
  drainControlRequests,
  MAX_CONTROL_REQUESTS_PER_DRAIN,
} from "@/agent/control-request"

const recorder = () => {
  const calls: string[] = []
  const applier: ControlEffectApplier = {
    setModel: (m) => calls.push(`model:${m}`),
    setPermissionMode: (m) => calls.push(`perm:${m}`),
    setThinking: (l) => calls.push(`think:${l}`),
    reportUsage: (u) => calls.push(`usage:${u.totalTokens ?? "?"}`),
    onRejected: (r) => calls.push(`reject:${r}`),
  }
  return { calls, applier }
}

const ctx: ControlRequestContext = {
  modelAllowlist: ["gpt-5", "claude-opus-4-8"],
  permissionModes: ["plan", "acceptEdits"],
  thinkingLevels: ["low", "high"],
  usage: { totalTokens: 1234 },
}

/** A port that yields a fixed queue then null. */
const queuePort = (reqs: ControlRequest[]) => {
  let i = 0
  return { next: () => (i < reqs.length ? (reqs[i++] as ControlRequest) : null) }
}

describe("applyControlEffect — routes each effect kind", () => {
  test("each effect kind hits its callback", () => {
    const { calls, applier } = recorder()
    applyControlEffect({ kind: "model-set", model: "gpt-5" }, applier)
    applyControlEffect({ kind: "permission-mode-set", mode: "plan" }, applier)
    applyControlEffect({ kind: "thinking-set", level: "high" }, applier)
    applyControlEffect({ kind: "usage", usage: { totalTokens: 9 } }, applier)
    applyControlEffect({ kind: "rejected", reason: "nope" }, applier)
    expect(calls).toEqual(["model:gpt-5", "perm:plan", "think:high", "usage:9", "reject:nope"])
  })
  test("absent callback ⇒ no-op (host opted out of an axis)", () => {
    expect(() => applyControlEffect({ kind: "model-set", model: "x" }, {})).not.toThrow()
  })
})

describe("drainControlRequests — plan + apply in order", () => {
  test("drains the whole queue, applying planned effects", () => {
    const { calls, applier } = recorder()
    const effects = drainControlRequests(
      queuePort([
        { kind: "set_model", model: "gpt-5" },
        { kind: "set_permission_mode", mode: "plan" },
        { kind: "get_context_usage" },
      ]),
      ctx,
      applier,
    )
    expect(calls).toEqual(["model:gpt-5", "perm:plan", "usage:1234"])
    expect(effects.map((e) => e.kind)).toEqual(["model-set", "permission-mode-set", "usage"])
  })

  test("off-allowlist request ⇒ rejected effect applied (fail-closed)", () => {
    const { calls, applier } = recorder()
    drainControlRequests(queuePort([{ kind: "set_model", model: "evil" }]), ctx, applier)
    expect(calls[0]).toContain("reject:")
  })

  test("permission mode with NO allowlist ⇒ rejected (privilege boundary)", () => {
    const { calls, applier } = recorder()
    drainControlRequests(queuePort([{ kind: "set_permission_mode", mode: "bypassPermissions" }]), {}, applier)
    expect(calls[0]).toContain("reject:")
  })

  test("BOUNDED: a hostile always-returns port stops at the cap", () => {
    let n = 0
    const hostile = { next: (): ControlRequest => { n++; return { kind: "get_context_usage" } } }
    const effects = drainControlRequests(hostile, ctx, recorder().applier)
    expect(effects.length).toBe(MAX_CONTROL_REQUESTS_PER_DRAIN)
    expect(n).toBe(MAX_CONTROL_REQUESTS_PER_DRAIN)
  })

  test("NO-THROW: a thrown port ends the drain with what was applied", () => {
    let i = 0
    const flaky = {
      next: (): ControlRequest | null => {
        if (i++ === 0) return { kind: "set_thinking", level: "low" }
        throw new Error("port boom")
      },
    }
    const { calls, applier } = recorder()
    const effects = drainControlRequests(flaky, ctx, applier)
    expect(calls).toEqual(["think:low"])
    expect(effects).toHaveLength(1)
  })

  test("NO-THROW: a thrown applier callback ends the drain cleanly", () => {
    const applier: ControlEffectApplier = {
      setThinking: () => {
        throw new Error("apply boom")
      },
    }
    const effects = drainControlRequests(queuePort([{ kind: "set_thinking", level: "low" }]), ctx, applier)
    expect(effects).toHaveLength(0)
  })
})
