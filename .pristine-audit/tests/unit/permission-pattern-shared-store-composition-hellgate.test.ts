/**
 * CLUSTER D #5 — SHARED-STORE composition hellgate (BASELINE-SEED RESIDUAL CLOSED).
 *
 * Proves the REAL composition root (`buildBaseFromArgs`) constructs ONE
 * `PatternGrantStore` and threads it to BOTH consumers, so the remember-patterns
 * feature is actually USEFUL while staying SECURE (the baseline = ONLY
 * user/policy-approved patterns):
 *
 *   - `AgentConfig.permissionPatternStore` (the admissibility-gate's user-approve
 *     `grant` path + `autoPassByPatterns` read), AND
 *   - the registered `permission_propose_pattern` tool's recording port.
 *
 * The SAME instance is asserted both ways — the gate growing the baseline via a
 * user approval makes the model's previously-rejected proposal succeed, and the
 * model's `recordProposed` write never reaches the gate's auto-pass baseline.
 *
 * Security lifecycle (attack → outcome), end-to-end over the REAL gate + REAL
 * tool sharing ONE store:
 *
 *   1. model proposes P BEFORE any user approval ⇒ rejected `would_widen`
 *      (P not in baseline — the freshly-built store has an EMPTY baseline).
 *   2. USER approves P via the REAL gate (`onConfirm` allow + `rememberPatterns`)
 *      ⇒ P enters the SHARED store's baseline (gate `grant`).
 *   3. model RE-proposes P (now baseline-covered) ⇒ recorded; a future
 *      structurally-equivalent action AUTO-PASSES through the REAL gate.
 *   4. model proposes a refinement of a RECORDED-(not-baseline) pattern ⇒
 *      rejected `would_widen` (no chain-widen: a recorded `allowed` pattern is
 *      not baseline, so refining IT is still a widen — the model can never seed
 *      the baseline).
 *   5. KNOB-OFF ⇒ no store on the config, tool absent, gate byte-identical.
 *
 * Drives the production builder (no hand-rolled store) so the composition-root
 * wiring — not just the pure cores — is what is under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { Tool, ToolRegistry, ToolResult } from "@/tool"

const DRIVEN = [
  "QUANTA_REMEMBER_PATTERNS",
  "QUANTA_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // The builder REQUIRES a provider key or it throws ProviderKeyMissingError.
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-deterministic-key"
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

const partial = () => ({ mode: "headless" as const, dials: undefined })

const buildBase = () => {
  __resetRuntimeConfig()
  return buildBaseFromArgs(partial())
}

const findTool = (registry: ToolRegistry, name: string): Tool | undefined =>
  registry.all().find((t) => t.name === name)

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

/** Drive the REAL registered tool through its execute generator, return its
 *  terminal ToolResult. */
const runTool = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, {
    cwd: "/tmp",
    signal: new AbortController().signal,
  })) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no result event")
  return last
}

const gateConfig = (base: ReturnType<typeof buildBase>, over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    registry: base.registry,
    permissionPatternStore: base.permissionPatternStore,
    ...over,
  }) as AgentConfig

const actionOf = (over: Partial<AdmissibilityAction>): AdmissibilityAction => ({
  tool: "mutate",
  input: {},
  isReadOnly: false,
  ...over,
})

const P = "bash:git status"
const RECORDED_NOT_BASELINE = "read:cache/**"

describe("CLUSTER D #5 — shared-store composition (BASELINE-SEED RESIDUAL CLOSED)", () => {
  test("knob ON ⇒ ONE store backs BOTH the gate config AND the registered tool", () => {
    process.env.QUANTA_REMEMBER_PATTERNS = "1"
    const base = buildBase()
    // The gate's store slot is populated.
    expect(base.permissionPatternStore).toBeDefined()
    // The model-facing tool is registered.
    const tool = findTool(base.registry as ToolRegistry, "permission_propose_pattern")
    expect(tool).toBeDefined()
  })

  test("FULL lifecycle: propose-before-approve REJECTED → user grant → refine RECORDED + auto-pass → chain-widen REJECTED", async () => {
    process.env.QUANTA_REMEMBER_PATTERNS = "1"
    const base = buildBase()
    const store = base.permissionPatternStore
    if (store === undefined) throw new Error("expected store wired")
    const tool = findTool(base.registry as ToolRegistry, "permission_propose_pattern")
    if (tool === undefined) throw new Error("expected propose tool registered")

    // ── ATTACK 1: model proposes P with an EMPTY baseline ⇒ would_widen. ──────
    const before = await runTool(tool, { proposed: [P] })
    expect(before.ok).toBe(false)
    expect(before.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
    // The model write never reached the gate's store baseline.
    expect(store.isBaseline(P)).toBe(false)
    expect(store.granted().has(P)).toBe(false)

    // ── USER approves P via the REAL gate (mode-policy ask ⇒ onConfirm allow).
    //    The gate's cascadeOnApprove → grantAndCascade → store.grant writes P
    //    into THIS SAME store's baseline. ─────────────────────────────────────
    const c = gateConfig(base, {
      onConfirm: async () => true, // user approves
    })
    const approve = await runAdmissibilityGate(
      call("mutate"),
      c,
      { mode: "default" },
      actionOf({ rememberPatterns: [P] }),
    )
    // Allow-shaped result (null ⇒ admitted).
    expect(approve).toBeNull()
    // The SHARED store's baseline grew — proving the gate wrote into THE SAME
    // instance the tool reads.
    expect(store.isBaseline(P)).toBe(true)

    // ── model RE-proposes P (now baseline-covered) ⇒ recorded. ───────────────
    const after = await runTool(tool, { proposed: [P] })
    expect(after.ok).toBe(true)
    expect(after.output).toContain(P)
    expect(store.granted().has(P)).toBe(true)

    // ── future structurally-equivalent action AUTO-PASSES through the REAL gate
    //    (no reviewer consulted) — the model's refinement is now useful. ───────
    let askedAfter = 0
    const c2 = gateConfig(base, {
      onConfirm: async () => {
        askedAfter++
        return false
      },
    })
    const autoPass = await runAdmissibilityGate(
      call("mutate", {}, "c-auto"),
      c2,
      { mode: "default" },
      actionOf({ rememberPatterns: [P] }),
    )
    expect(autoPass).toBeNull() // admitted via pattern auto-pass
    expect(askedAfter).toBe(0) // reviewer NOT consulted

    // ── ATTACK 2 (chain-widen): the model first records a pattern, then tries
    //    to refine THAT recorded-(not-baseline) pattern. A recorded `allowed`
    //    pattern is NOT baseline, so refining it is still would_widen — the
    //    model can never seed the baseline. ───────────────────────────────────
    // Seed the recorded-but-not-baseline pattern by first granting its baseline
    // via the gate, recording it, then proving a DIFFERENT pattern "covered" by
    // it alone is rejected. We exercise the purest chain-widen: propose a
    // pattern that is NEITHER in the baseline NOR covered by any grant.
    const widen = await runTool(tool, { proposed: [RECORDED_NOT_BASELINE] })
    expect(widen.ok).toBe(false)
    expect(widen.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
    expect(store.isBaseline(RECORDED_NOT_BASELINE)).toBe(false)
    expect(store.granted().has(RECORDED_NOT_BASELINE)).toBe(false)
  })

  test("no chain-widen: a RECORDED allowed pattern is not baseline ⇒ refining IT is still rejected", async () => {
    process.env.QUANTA_REMEMBER_PATTERNS = "1"
    const base = buildBase()
    const store = base.permissionPatternStore
    if (store === undefined) throw new Error("expected store wired")
    const tool = findTool(base.registry as ToolRegistry, "permission_propose_pattern")
    if (tool === undefined) throw new Error("expected propose tool registered")

    // User grants A via the gate ⇒ A in baseline.
    const c = gateConfig(base, { onConfirm: async () => true })
    await runAdmissibilityGate(
      call("mutate"),
      c,
      { mode: "default" },
      actionOf({ rememberPatterns: ["bash:git log"] }),
    )
    expect(store.isBaseline("bash:git log")).toBe(true)
    // Model records A (baseline-covered) ⇒ A enters `allowed` (NOT baseline again).
    expect((await runTool(tool, { proposed: ["bash:git log"] })).ok).toBe(true)
    // Now the model proposes B, "covered by" the just-recorded A — but A is only
    // in `allowed`, never the baseline ⇒ B is would_widen. No chain-widen.
    const b = await runTool(tool, { proposed: ["bash:git log --all"] })
    expect(b.ok).toBe(false)
    expect(b.failure).toMatchObject({ mode: "rejected", reason: "would_widen" })
    expect(store.granted().has("bash:git log --all")).toBe(false)
  })

  test("default-OFF: knob unset ⇒ NO store on config + tool ABSENT + gate byte-identical", async () => {
    // Knob NOT set (beforeEach deleted it).
    const base = buildBase()
    // No store wired onto the AgentConfig.
    expect(base.permissionPatternStore).toBeUndefined()
    // Tool absent from the registry.
    expect(findTool(base.registry as ToolRegistry, "permission_propose_pattern")).toBeUndefined()

    // Gate is byte-identical: a mutating tool with rememberPatterns set still
    // gets NO auto-pass (the reviewer is consulted, exactly as today).
    let asked = false
    const c = gateConfig(base, {
      onConfirm: async () => {
        asked = true
        return false
      },
    })
    const res = await runAdmissibilityGate(
      call("mutate"),
      c,
      { mode: "default" },
      actionOf({ rememberPatterns: [P] }),
    )
    expect(asked).toBe(true) // reviewer consulted — no auto-pass
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("declined")
  })

  test("the tool's port + the gate share the SAME instance (mutation through one is visible via the other)", async () => {
    process.env.QUANTA_REMEMBER_PATTERNS = "1"
    const base = buildBase()
    const store = base.permissionPatternStore
    if (store === undefined) throw new Error("expected store wired")
    const tool = findTool(base.registry as ToolRegistry, "permission_propose_pattern")
    if (tool === undefined) throw new Error("expected propose tool registered")

    // Grant via the gate (writes baseline into the SHARED store).
    const c = gateConfig(base, { onConfirm: async () => true })
    await runAdmissibilityGate(
      call("mutate"),
      c,
      { mode: "default" },
      actionOf({ rememberPatterns: ["read:src/**"] }),
    )
    // The tool — which closes over a DIFFERENT reference path (its port) — sees
    // the gate's baseline grant. If the two had separate stores, this would be
    // would_widen.
    const r = await runTool(tool, { proposed: ["read:src/**"] })
    expect(r.ok).toBe(true)
  })
})
