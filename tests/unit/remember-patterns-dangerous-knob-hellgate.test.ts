/**
 * HELLGATE — jun-6 CLUSTER D #5 residual: the dangerous-opt-in knob
 * (`QUANTA_REMEMBER_PATTERNS_DANGEROUS`) wired at the composition root.
 *
 * The composition root (`resolvePermissionPatternSlice` in
 * `host/runtime/agent-arg-builder.ts`) reads this knob and passes
 * `allowDangerous: <knob>` into the propose port's `recordProposedPattern`.
 *
 * SECURITY (load-bearing): the knob lifts ONLY the extra dangerous-gate. The
 * NO-WIDEN gate is INDEPENDENT of `allowDangerous`, so a dangerous-AND-uncovered
 * proposal is STILL `would_widen` rejected — the knob can never let a model
 * self-grant a NEW capability.
 *
 * Outcomes proven (the exact matrix the prompt requires):
 *   - knob-ON  + dangerous + baseline-COVERED   ⇒ recorded.
 *   - knob-ON  + dangerous + UNcovered          ⇒ still would_widen (no-widen).
 *   - knob-OFF + dangerous (covered or not)     ⇒ dangerous_blocked (rejected).
 *   - config parsing flips the boolean on `=== "1"` only.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { PatternGrantStore, recordProposedPattern } from "@/permission"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { permissionProposeTools } from "@/tool/permission-propose"

/** The `allowDangerous` the composition root threads from the knob. */
const allowDangerousFromKnob = (): boolean => runtimeConfig().rememberPatternsDangerous === true

afterEach(() => {
  delete process.env.QUANTA_REMEMBER_PATTERNS_DANGEROUS
  __resetRuntimeConfig()
})

describe("rememberPatternsDangerous — config parsing", () => {
  test("absent ⇒ false (safe default, byte-identical)", () => {
    __resetRuntimeConfig()
    expect(runtimeConfig().rememberPatternsDangerous).toBe(false)
  })

  test('=== "1" ⇒ true', () => {
    process.env.QUANTA_REMEMBER_PATTERNS_DANGEROUS = "1"
    __resetRuntimeConfig()
    expect(runtimeConfig().rememberPatternsDangerous).toBe(true)
  })

  test("any other value ⇒ false (strict opt-in)", () => {
    process.env.QUANTA_REMEMBER_PATTERNS_DANGEROUS = "true"
    __resetRuntimeConfig()
    expect(runtimeConfig().rememberPatternsDangerous).toBe(false)
  })
})

describe("dangerous knob OFF — dangerous proposals always rejected (safe)", () => {
  test("OFF + dangerous + baseline-covered ⇒ dangerous_blocked (NOT recorded)", () => {
    __resetRuntimeConfig() // knob unset ⇒ false
    const store = new PatternGrantStore(["bash:rm -rf /tmp/x"])
    const res = recordProposedPattern(
      store,
      { proposed: ["bash:rm -rf /tmp/x"], isMaybeDangerous: true },
      { allowDangerous: allowDangerousFromKnob() },
    )
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("dangerous_blocked")
    // Nothing recorded ⇒ the gate still routes the call to the reviewer.
    expect(store.isBaseline("bash:rm -rf /tmp/x")).toBe(true)
  })
})

describe("dangerous knob ON — lifts the dangerous-gate ONLY", () => {
  test("ON + dangerous + baseline-COVERED ⇒ recorded", () => {
    process.env.QUANTA_REMEMBER_PATTERNS_DANGEROUS = "1"
    __resetRuntimeConfig()
    const store = new PatternGrantStore(["bash:rm -rf /tmp/x"])
    const res = recordProposedPattern(
      store,
      { proposed: ["bash:rm -rf /tmp/x"], isMaybeDangerous: true },
      { allowDangerous: allowDangerousFromKnob() },
    )
    expect(res.kind).toBe("recorded")
  })

  test("ON + dangerous + UNcovered ⇒ STILL would_widen (no self-grant)", () => {
    process.env.QUANTA_REMEMBER_PATTERNS_DANGEROUS = "1"
    __resetRuntimeConfig()
    // Baseline covers ONLY a read; the dangerous proposal is NOT covered.
    const store = new PatternGrantStore(["read:src/**"])
    const res = recordProposedPattern(
      store,
      { proposed: ["bash:rm -rf /"], isMaybeDangerous: true },
      { allowDangerous: allowDangerousFromKnob() },
    )
    // The knob lifted the dangerous-gate, but the no-widen gate STILL rejects:
    // a model can never seed a capability the user/policy never granted.
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
    // And it was NOT recorded.
    expect(store.isBaseline("bash:rm -rf /")).toBe(false)
  })

  test("ON + dangerous + one-covered-one-uncovered ⇒ atomic would_widen (no laundering)", () => {
    process.env.QUANTA_REMEMBER_PATTERNS_DANGEROUS = "1"
    __resetRuntimeConfig()
    const store = new PatternGrantStore(["read:src/**"])
    const res = recordProposedPattern(
      store,
      { proposed: ["read:src/**", "bash:rm -rf /"], isMaybeDangerous: true },
      { allowDangerous: allowDangerousFromKnob() },
    )
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
  })
})

describe("no-self-grant — recorded patterns never become baseline (no chain-widen)", () => {
  test("recordProposed writes into `allowed` but NOT into `baseline`", () => {
    const store = new PatternGrantStore() // empty baseline
    store.recordProposed(["bash:laundered"])
    // It is in the auto-pass set but is NOT trusted baseline ground.
    expect(store.granted().has("bash:laundered")).toBe(true)
    expect(store.isBaseline("bash:laundered")).toBe(false)
    // So a proposal that "refines" the just-recorded pattern STILL widens.
    const res = recordProposedPattern(
      store,
      { proposed: ["bash:laundered"] },
      { allowDangerous: true },
    )
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
  })

  test("grant() is the ONLY baseline-widening path (user/policy authority)", () => {
    const store = new PatternGrantStore()
    store.recordProposed(["x"])
    expect(store.isBaseline("x")).toBe(false)
    store.grant(["y"])
    expect(store.isBaseline("y")).toBe(true)
  })

  test("empty baseline ⇒ every proposal would_widen even with the knob ON", () => {
    const store = new PatternGrantStore()
    const res = recordProposedPattern(
      store,
      { proposed: ["read:src/**"] },
      { allowDangerous: true },
    )
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
  })
})

describe("tool surface — permission_propose_pattern cannot self-grant", () => {
  const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })
  const run = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: string }> => {
    let last = { ok: false, output: "none" }
    for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
    }
    return last
  }
  const port = (store: PatternGrantStore, allowDangerous: boolean) => ({
    recordProposed: (input: { proposed: readonly string[]; isMaybeDangerous?: boolean }) =>
      recordProposedPattern(
        store,
        {
          proposed: input.proposed,
          ...(input.isMaybeDangerous !== undefined
            ? { isMaybeDangerous: input.isMaybeDangerous }
            : {}),
        },
        { allowDangerous },
      ),
  })

  test("an uncovered proposal through the TOOL ⇒ would_widen, store untouched", async () => {
    const store = new PatternGrantStore(["bash:git status"])
    const tool = permissionProposeTools(port(store, false))[0] as Tool
    const r = await run(tool, { proposed: ["bash:rm -rf /"] })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("would_widen")
    expect(store.granted().has("bash:rm -rf /")).toBe(false)
  })

  test("knob ON + dangerous + uncovered through the TOOL ⇒ STILL would_widen", async () => {
    const store = new PatternGrantStore(["read:src/**"])
    const tool = permissionProposeTools(port(store, true))[0] as Tool
    const r = await run(tool, { proposed: ["read:/etc/**"], is_maybe_dangerous: true })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("would_widen")
    expect(store.granted().has("read:/etc/**")).toBe(false)
  })
})
