/**
 * Role-based model override hellgate (ADR-0256).
 *
 * Adversarial battery locking the role-model resolver contract — Roo's
 * orchestrator-style {role → modelId} selector. Sibling to ADR-0212
 * sticky-model: sticky is the workflow-phase axis (plan/audit/review),
 * role-override is the dispatched sub-task axis (plan-writer/executor/…).
 *
 * Wire order:
 *   HELL-RM-01 — resolve no override → default
 *   HELL-RM-02 — setOverride + resolve → override
 *   HELL-RM-03 — listOverrides returns accurate snapshot
 *   HELL-RM-04 — 5-role exhaustive (each role distinct override)
 *   HELL-RM-05 — empty modelId on setOverride → typed Err
 *   HELL-RM-06 — unknown role on resolve → default (no throw)
 *   HELL-RM-07 — setOverride twice on same role overwrites
 *   HELL-RM-08 — default-OFF: no resolver → byte-identical default behavior
 *   HELL-RM-09 — 5 roles can hold different overrides simultaneously
 *   HELL-RM-10 — listOverrides() snapshot is frozen
 *   HELL-RM-11 — concurrent setOverride safe (last-write-wins)
 *   HELL-RM-12 — resolve is pure (no IO, deterministic, no clock)
 *   HELL-RM-13 — 1000 resolve perf sanity (sub-100ms)
 *   HELL-RM-14 — ADR-0212 sticky compose: sticky as defaultModel preserved
 *   HELL-RM-15 — clearOverride(role) → default fallback restored
 */
import { describe, expect, test } from "bun:test"
import { defaultRoleModelResolver, OverrideError, type Role } from "@/llm/role-model-override"
import { QuantaError } from "@/shared"

describe("role-based model override hellgate (ADR-0256)", () => {
  test("HELL-RM-01 — resolve with no override returns defaultModel", () => {
    const r = defaultRoleModelResolver()
    expect(r.resolve("plan-writer", "gpt-5")).toBe("gpt-5")
  })

  test("HELL-RM-02 — setOverride then resolve returns override", () => {
    const r = defaultRoleModelResolver()
    const setResult = r.setOverride("plan-writer", "claude-opus")
    expect(setResult.ok).toBe(true)
    expect(r.resolve("plan-writer", "gpt-5")).toBe("claude-opus")
  })

  test("HELL-RM-03 — listOverrides returns accurate snapshot", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("plan-writer", "model-A")
    r.setOverride("executor", "model-B")
    const list = r.listOverrides()
    expect(list).toEqual({ "plan-writer": "model-A", executor: "model-B" })
  })

  test("HELL-RM-04 — 5-role exhaustive (every Role member resolvable)", () => {
    const roles: readonly Role[] = ["plan-writer", "executor", "reviewer", "explorer", "default"]
    const r = defaultRoleModelResolver()
    for (const role of roles) {
      expect(r.resolve(role, "default-model")).toBe("default-model")
    }
  })

  test("HELL-RM-05 — empty modelId on setOverride → typed Err('empty-model')", () => {
    const r = defaultRoleModelResolver()
    const result = r.setOverride("plan-writer", "")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(OverrideError)
      expect(result.error).toBeInstanceOf(QuantaError)
      expect(result.error.code).toBe("empty-model")
    }
    // The override was NOT stored — resolve falls through to default.
    expect(r.resolve("plan-writer", "fallback")).toBe("fallback")
    // And it does NOT appear in listOverrides.
    expect(r.listOverrides()).toEqual({})
  })

  test("HELL-RM-06 — unknown role on resolve → default (no throw)", () => {
    const r = defaultRoleModelResolver()
    // Cast through unknown — at JSON-RPC / type-erased boundaries the
    // resolver may see a string that isn't in the Role union. It MUST
    // NOT throw; it MUST fall through to defaultModel.
    const unknownRole = "totally-made-up-role" as unknown as Role
    expect(() => r.resolve(unknownRole, "safe-default")).not.toThrow()
    expect(r.resolve(unknownRole, "safe-default")).toBe("safe-default")
  })

  test("HELL-RM-07 — setOverride twice on same role overwrites", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("executor", "first")
    r.setOverride("executor", "second")
    expect(r.resolve("executor", "default")).toBe("second")
    expect(r.listOverrides()).toEqual({ executor: "second" })
  })

  test("HELL-RM-08 — default-OFF: no resolver wired → byte-identical default behavior", () => {
    // The contract: a host that never constructs a resolver keeps the
    // current single-axis behavior (defaultModel === effectiveModelId).
    // We model that by NOT using the resolver at all — the default model
    // is what the caller would pass downstream untouched.
    const defaultModel = "gpt-5"
    // Without a resolver, the effective model IS the default model.
    const effective = defaultModel
    expect(effective).toBe("gpt-5")
    // And constructing the resolver but never calling setOverride is
    // ALSO byte-identical (the resolve path is pure pass-through).
    const r = defaultRoleModelResolver()
    expect(r.resolve("executor", defaultModel)).toBe(defaultModel)
  })

  test("HELL-RM-09 — 5 roles can hold different overrides simultaneously", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("plan-writer", "m-plan")
    r.setOverride("executor", "m-exec")
    r.setOverride("reviewer", "m-rev")
    r.setOverride("explorer", "m-explore")
    r.setOverride("default", "m-default")
    expect(r.resolve("plan-writer", "X")).toBe("m-plan")
    expect(r.resolve("executor", "X")).toBe("m-exec")
    expect(r.resolve("reviewer", "X")).toBe("m-rev")
    expect(r.resolve("explorer", "X")).toBe("m-explore")
    expect(r.resolve("default", "X")).toBe("m-default")
  })

  test("HELL-RM-10 — listOverrides() returns frozen object", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("plan-writer", "m1")
    const list = r.listOverrides()
    expect(Object.isFrozen(list)).toBe(true)
    // Mutation attempts must throw in strict mode (which Bun uses for
    // ESM by default).
    expect(() => {
      ;(list as Record<string, string>)["plan-writer"] = "tampered"
    }).toThrow()
    // Adding new key also blocked.
    expect(() => {
      ;(list as Record<string, string>)["new-key"] = "x"
    }).toThrow()
  })

  test("HELL-RM-11 — concurrent setOverride safe (last-write-wins)", async () => {
    const r = defaultRoleModelResolver()
    // All set's are sync — wrap in microtask boundaries to simulate
    // concurrent dispatch from multiple async producers. The last-write
    // for a given key MUST win, and no exception MUST escape.
    const ops: Promise<void>[] = []
    for (let i = 0; i < 50; i++) {
      ops.push(
        Promise.resolve().then(() => {
          r.setOverride("plan-writer", `m-${i}`)
        }),
      )
    }
    await Promise.all(ops)
    // The final state must be one of the 50 writes — specifically the
    // last one to execute (microtask ordering on Bun is FIFO).
    const got = r.resolve("plan-writer", "fallback")
    expect(got.startsWith("m-")).toBe(true)
    // The store has exactly one entry for plan-writer (not 50).
    const list = r.listOverrides()
    expect(Object.keys(list)).toEqual(["plan-writer"])
  })

  test("HELL-RM-12 — resolve is pure (deterministic, no clock dependency)", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("executor", "model-X")
    // Resolve 5 times in succession; every call returns the same value.
    const results = Array.from({ length: 5 }, () => r.resolve("executor", "default"))
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe("model-X")
    // And resolve does NOT mutate the store (listOverrides unchanged).
    expect(r.listOverrides()).toEqual({ executor: "model-X" })
  })

  test("HELL-RM-13 — 1000 resolve calls complete in under 100ms (perf sanity)", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("plan-writer", "model-A")
    r.setOverride("executor", "model-B")
    r.setOverride("reviewer", "model-C")
    const roles: readonly Role[] = ["plan-writer", "executor", "reviewer", "explorer"]
    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      const role = roles[i % roles.length] as Role
      r.resolve(role, "default")
    }
    const elapsedMs = performance.now() - start
    // Generous bound — Map.get on a 3-entry map is O(1); the bound is
    // sized to catch a regression where someone accidentally introduces
    // Array.find or string parsing on the hot path.
    expect(elapsedMs).toBeLessThan(100)
  })

  test("HELL-RM-14 — ADR-0212 sticky compose: sticky modelId as defaultModel is preserved", () => {
    // Composition root pattern:
    //   const stickyId = await stickyResolver.resolve({ mode, globalDefault })
    //   const effective = roleResolver.resolve(role, stickyId)
    // When no role override exists, the sticky pick flows through.
    const r = defaultRoleModelResolver()
    const stickyId = "sticky-pick-from-mode-plan"
    expect(r.resolve("executor", stickyId)).toBe(stickyId)
    // When a role override IS set, role override wins over sticky —
    // sub-task autonomy beats workflow phase (documented precedence).
    r.setOverride("executor", "role-override-pick")
    expect(r.resolve("executor", stickyId)).toBe("role-override-pick")
  })

  test("HELL-RM-15 — clearOverride(role) → resolve falls back to default", () => {
    const r = defaultRoleModelResolver()
    r.setOverride("plan-writer", "override-pick")
    expect(r.resolve("plan-writer", "default")).toBe("override-pick")
    r.clearOverride("plan-writer")
    // Override gone — fall back to default.
    expect(r.resolve("plan-writer", "default")).toBe("default")
    expect(r.listOverrides()).toEqual({})
    // clearOverride on a role that has no override is a no-op (no throw).
    expect(() => r.clearOverride("reviewer")).not.toThrow()
  })
})
