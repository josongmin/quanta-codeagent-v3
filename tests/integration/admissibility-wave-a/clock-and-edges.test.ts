import { describe, expect, test } from "bun:test"
import { type AdmissibilityWaveAOptions, runAdmissibilityGate } from "@/agent/admissibility-gate"
import {
  type DenialMemory,
  OutcomeInvariantError,
  type PermissionContext,
  ReviewerUnavailableError,
  type ToolActionKeyed,
} from "@/permission"
import type { RulesStore } from "@/rules"
import { ToolRegistry } from "@/tool"
import {
  actionOf,
  bashSchema,
  call,
  cfg,
  decision,
  loadedStore,
  makePort,
  makeTool,
} from "./_fixtures"

describe("Wave A: injectable decidedAt clock", () => {
  const dangerous = makeTool("dangerous", {
    readOnly: false,
    hitlTier: () => "always-confirm",
  })

  test("port receives decidedAt from injected function (not Date.now)", async () => {
    let observed = -1
    const port = makePort({
      userReview: async (_a: ToolActionKeyed, ctx) => {
        observed = ctx.decidedAt
        return decision("user", "user_approved", ctx.decidedAt)
      },
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: () => 424242 },
    )
    expect(observed).toBe(424242)
  })

  test("decidedAt is called ONCE per gate invocation (deterministic value)", async () => {
    let calls = 0
    const clock = () => {
      calls += 1
      return 7
    }
    const port = makePort({
      userReview: async () => decision("user", "user_approved", 7),
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user", decidedAt: clock },
    )
    expect(calls).toBe(1)
  })

  test("missing decidedAt falls back to Date.now (still admissible)", async () => {
    const port = makePort({
      userReview: async (_a: ToolActionKeyed, ctx) =>
        decision("user", "user_approved", ctx.decidedAt),
    })
    const c = cfg({
      registry: new ToolRegistry([dangerous]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(dangerous),
      undefined,
      { reviewerPort: port, defaultReviewer: "user" },
    )
    expect(res).toBeNull()
  })
})

// ─── 8. Combined option ordering ─────────────────────────────────────────

describe("Wave A: cross-cutting ordering and edge cases", () => {
  test("rule allow bypasses HITL handler (onConfirm not called)", async () => {
    let confirmed = false
    const tool = makeTool("dangerous", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow dangerous\n"),
    }
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => {
        confirmed = true
        return false
      },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(tool),
      undefined,
      wave,
    )
    expect(confirmed).toBe(false)
    expect(res).toBeNull()
  })

  test("rule no_match + fallthrough + reviewerPort → legacy HITL path uses reviewer", async () => {
    const tool = makeTool("dangerous", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    let invoked = false
    const port = makePort({
      userReview: async () => {
        invoked = true
        return decision("user", "user_approved")
      },
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow nothing-here\n"),
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
    }
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "bypass" },
      actionOf(tool),
      undefined,
      wave,
    )
    expect(invoked).toBe(true)
    expect(res).toBeNull()
  })

  test("rule allow + pre_tool_use hook STILL runs (hook is the last word)", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: bashSchema,
      extractShellCommand: (input) => (input as { command: string }).command,
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
    }
    const { HookBus } = await import("@/agent")
    const hooks = new HookBus()
    let hookCount = 0
    hooks.on("pre_tool_use", () => {
      hookCount += 1
      return { deny: "policy says no" }
    })
    const c = cfg({
      registry: new ToolRegistry([bash]),
      hooks,
      permission: { mode: "default" },
    })
    const input = { command: "git status" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "default" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(hookCount).toBe(1)
    expect(res?.preview).toBe("hook-denied")
    expect(res?.block.content).toContain("policy says no")
  })

  test("RulesStore.match throw propagates (no silent catch)", async () => {
    class BoomStore {
      match(_: string): never {
        throw new Error("rules-boom")
      }
    }
    const bash = makeTool("bash", {
      readOnly: false,
      schema: bashSchema,
      extractShellCommand: (input) => (input as { command: string }).command,
    })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: new BoomStore() as unknown as RulesStore,
    }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "default" } })
    const input = { command: "git status" }
    await expect(
      runAdmissibilityGate(
        call("bash", input),
        c,
        { mode: "default" },
        actionOf(bash, input),
        undefined,
        wave,
      ),
    ).rejects.toThrow("rules-boom")
  })

  test("only priorDenials supplied (no port, no rules) → still byte-identical legacy", async () => {
    // priorDenials without a reviewerPort is inert (the gate never reaches
    // reviewAction). Wave A treats it as a no-op so the legacy mode path runs.
    const mut = makeTool("mut", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([mut]),
      onConfirm: async () => true,
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(
      call("mut"),
      c,
      { mode: "default" },
      actionOf(mut),
      undefined,
      {
        priorDenials: [
          {
            sessionId: "s1",
            actionKey: "mut",
            reviewer: "guardian_subagent",
            outcome: "guardian_denied",
            deniedAt: 1,
          },
        ],
      },
    )
    expect(res).toBeNull()
  })

  test("Wave A active but only noMatchPolicy set (no rulesStore) → bypassed; legacy continues", async () => {
    const mut = makeTool("mut", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([mut]),
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("mut"),
      c,
      { mode: "bypass" },
      actionOf(mut),
      undefined,
      { noMatchPolicy: "deny" },
    )
    // No rules store ⇒ rule gate falls through; bypass admits.
    expect(res).toBeNull()
  })
})
