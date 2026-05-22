/**
 * Order-locking tests for `runAdmissibilityGate` (Codex `may-20-codex-agent-
 * loop.md §5` absorption — ADR-0018). These assertions lock the canonical
 * dispatch-time gate ordering: plan-mode block → HITL tier (when enabled) →
 * mode policy (HARD_DENY inside) → pre_tool_use hook. The extraction in Wave
 * B4 must be behavior-preserving, so each test constructs a config that would
 * trigger MULTIPLE gates and asserts which one fires first.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import {
  AutoModeClassifier,
  type ClassifierPort,
  type HITLTier,
  type PermissionContext,
} from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Build a minimal Tool with scripted behavior. */
const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    hitlTier?: (input: unknown) => HITLTier
    run?: () => AsyncIterable<ToolEvent>
  } = {},
): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () =>
      opts.run
        ? opts.run()
        : (async function* () {
            yield { type: "result", result: { ok: true, output: "ran" } }
          })(),
  }
  if (opts.hitlTier) {
    ;(tool as Tool & { hitlTier: (input: unknown) => HITLTier }).hitlTier = opts.hitlTier
  }
  return tool
}

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

const actionOf = (tool: Tool, input: unknown = {}): AdmissibilityAction => ({
  tool: tool.name,
  input,
  isReadOnly: tool.isReadOnly(),
})

const bashSchema = z.object({ command: z.string() })

describe("runAdmissibilityGate: canonical ordering", () => {
  test("HARD_DENY beats HITL allow (always-confirm + approving onConfirm still denied)", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: bashSchema,
      hitlTier: () => "always-confirm",
    })
    let confirmed = false
    const c = cfg({
      registry: new ToolRegistry([bash]),
      hitl: { enabled: true },
      onConfirm: async () => {
        confirmed = true
        return true
      },
      permission: { mode: "bypass" },
    })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("handoff")
    expect(res?.block.content).toContain("Action requires human handoff")
    // Confirm was never invoked — HARD_DENY short-circuits the tier resolution.
    expect(confirmed).toBe(false)
  })

  test("HARD_DENY beats auto-classifier allow (auto mode)", async () => {
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    let classifierCalled = false
    const port: ClassifierPort = async () => {
      classifierCalled = true
      return { verdict: "allow", reason: "looks fine" }
    }
    const auto = new AutoModeClassifier(port)
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "auto" },
    })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "auto" },
      actionOf(bash, input),
      auto,
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("denied")
    expect(res?.block.content).toContain("Permission denied")
    expect(res?.block.content).toContain("Blocked dangerous command")
    expect(classifierCalled).toBe(false)
  })

  test("plan-mode block fires before HITL gate", async () => {
    const mutate = makeTool("mutate", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    let confirmed = false
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      planMode: true,
      hitl: { enabled: true },
      onConfirm: async () => {
        confirmed = true
        return true
      },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("plan-blocked")
    expect(res?.block.content).toContain("blocked in plan mode")
    expect(confirmed).toBe(false)
  })

  test("HITL hand-off-required cannot be bypassed by bypass mode", async () => {
    const tool = makeTool("dangerous", {
      readOnly: false,
      hitlTier: () => "hand-off-required",
    })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("handoff")
    expect(res?.block.content).toContain("hand-off-required")
  })

  test("HITL always-confirm asks even in bypass mode; declined ⇒ deny", async () => {
    const tool = makeTool("dangerous", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => {
        asked = true
        return false
      },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(asked).toBe(true)
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("declined")
    expect(res?.block.content).toContain("always-confirm tier")
  })

  test("HITL tier 'none' skips mode policy AND the classifier", async () => {
    const ro = makeTool("read", {
      readOnly: true,
      hitlTier: () => "none",
    })
    let classifierCalled = false
    const port: ClassifierPort = async () => {
      classifierCalled = true
      return { verdict: "block", reason: "should be ignored" }
    }
    const auto = new AutoModeClassifier(port)
    const c = cfg({
      registry: new ToolRegistry([ro]),
      hitl: { enabled: true },
      permission: { mode: "auto" },
    })
    const res = await runAdmissibilityGate(call("read"), c, { mode: "auto" }, actionOf(ro), auto)
    expect(res).toBeNull()
    expect(classifierCalled).toBe(false)
  })

  test("HITL pre-approval-ok falls through to mode policy (ask)", async () => {
    const mutate = makeTool("mutate", {
      readOnly: false,
      hitlTier: () => "pre-approval-ok",
    })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      hitl: { enabled: true },
      onConfirm: async () => {
        asked = true
        return false
      },
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(asked).toBe(true)
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("declined")
    expect(res?.block.content).toContain("User declined")
  })

  test("mode 'default' + no onConfirm ⇒ deny 'User declined'", async () => {
    const mutate = makeTool("mutate", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("declined")
    expect(res?.block.content).toContain("User declined")
  })

  test("auto-mode classifier 'allow' ⇒ admissible (null)", async () => {
    const mutate = makeTool("mutate", { readOnly: false })
    const port: ClassifierPort = async () => ({ verdict: "allow", reason: "ok" })
    const auto = new AutoModeClassifier(port)
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      permission: { mode: "auto" },
    })
    const res = await runAdmissibilityGate(
      call("mutate"),
      c,
      { mode: "auto" },
      actionOf(mutate),
      auto,
    )
    expect(res).toBeNull()
  })

  test("auto-mode classifier 'deny' ⇒ permission deny", async () => {
    const mutate = makeTool("mutate", { readOnly: false })
    const port: ClassifierPort = async () => ({ verdict: "block", reason: "no good" })
    const auto = new AutoModeClassifier(port)
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      permission: { mode: "auto" },
    })
    const res = await runAdmissibilityGate(
      call("mutate"),
      c,
      { mode: "auto" },
      actionOf(mutate),
      auto,
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("denied")
    expect(res?.block.content).toContain("Permission denied")
  })

  test("hook deny short-circuits AFTER mode policy passes", async () => {
    const ok = makeTool("ok", { readOnly: true })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "policy says no" }))
    const c = cfg({
      registry: new ToolRegistry([ok]),
      hooks,
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(call("ok"), c, { mode: "default" }, actionOf(ok))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("hook-denied")
    expect(res?.block.content).toContain("policy says no")
  })

  test("hook is NOT consulted when policy denies upstream", async () => {
    const mutate = makeTool("mutate", { readOnly: false })
    let hookCount = 0
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookCount += 1
    })
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      hooks,
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res?.preview).toBe("declined")
    expect(hookCount).toBe(0)
  })

  test("all gates skipped (read-only, no hitl, no hooks) ⇒ null (admissible)", async () => {
    const ok = makeTool("ok", { readOnly: true })
    const c = cfg({
      registry: new ToolRegistry([ok]),
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(call("ok"), c, { mode: "default" }, actionOf(ok))
    expect(res).toBeNull()
  })

  test("mode 'review' blocks a mutating tool with preview='review-blocked'", async () => {
    const mutate = makeTool("mutate", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      mode: "review",
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "bypass" }, actionOf(mutate))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("review-blocked")
    expect(res?.block.content).toContain("blocked in review mode: mutate")
  })

  test("mode 'audit' blocks a mutating tool with preview='audit-blocked'", async () => {
    const mutate = makeTool("mutate", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      mode: "audit",
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "bypass" }, actionOf(mutate))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("audit-blocked")
    expect(res?.block.content).toContain("blocked in audit mode: mutate")
  })

  test("mode 'review' allows read-only tools (only mutating tools are blocked)", async () => {
    const ro = makeTool("ro", { readOnly: true })
    const c = cfg({
      registry: new ToolRegistry([ro]),
      mode: "review",
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("ro"), c, { mode: "bypass" }, actionOf(ro))
    expect(res).toBeNull()
  })

  test("mode 'audit' allows read-only tools (only mutating tools are blocked)", async () => {
    const ro = makeTool("ro", { readOnly: true })
    const c = cfg({
      registry: new ToolRegistry([ro]),
      mode: "audit",
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("ro"), c, { mode: "bypass" }, actionOf(ro))
    expect(res).toBeNull()
  })

  test("review/audit blocks fire BEFORE HITL — confirm handler never invoked", async () => {
    const mutate = makeTool("mutate", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    let confirmed = false
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      mode: "review",
      hitl: { enabled: true },
      onConfirm: async () => {
        confirmed = true
        return true
      },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res?.preview).toBe("review-blocked")
    expect(confirmed).toBe(false)
  })

  test("HITL approved (always-confirm + accepted) still emits pre_tool_use hook", async () => {
    const tool = makeTool("dangerous", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    let hookCount = 0
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookCount += 1
    })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      hooks,
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(res).toBeNull()
    expect(hookCount).toBe(1)
  })

  test("HITL always-confirm with no onConfirm wired ⇒ deny", async () => {
    const tool = makeTool("dangerous", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("denied")
    expect(res?.block.content).toContain("no confirm handler is wired")
  })
})

describe("runAdmissibilityGate: parity with dispatchTool", () => {
  test("dispatchTool path matches runAdmissibilityGate for representative configs", async () => {
    // Each scenario builds a config the gate sees and an equivalent dispatch
    // call. We assert structural parity (ok flag + preview tag + a content
    // substring) so any extraction drift becomes visible.
    type Scenario = {
      name: string
      tool: Tool
      input: unknown
      permission: PermissionContext
      hitl?: { enabled?: boolean }
      planMode?: boolean
      onConfirm?: () => Promise<boolean>
      expectPreview: string | null // null ⇒ tool runs (ok:true)
      expectContent?: string
    }
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    const ro = makeTool("ro", { readOnly: true })
    const mutate = makeTool("mut", { readOnly: false })
    const alwaysConfirm = makeTool("ac", {
      readOnly: false,
      hitlTier: () => "always-confirm",
    })

    const scenarios: Scenario[] = [
      {
        name: "read-only fast path",
        tool: ro,
        input: {},
        permission: { mode: "default" },
        expectPreview: null,
      },
      {
        name: "HARD_DENY bash + bypass",
        tool: bash,
        input: { command: "rm -rf /" },
        permission: { mode: "bypass" },
        expectPreview: "denied",
        expectContent: "Permission denied",
      },
      {
        name: "HARD_DENY bash + HITL on",
        tool: bash,
        input: { command: "rm -rf /" },
        permission: { mode: "bypass" },
        hitl: { enabled: true },
        expectPreview: "handoff",
        expectContent: "human handoff",
      },
      {
        name: "default mode mutating, no confirm",
        tool: mutate,
        input: {},
        permission: { mode: "default" },
        expectPreview: "declined",
        expectContent: "User declined",
      },
      {
        name: "default mode mutating, confirm yes",
        tool: mutate,
        input: {},
        permission: { mode: "default" },
        onConfirm: async () => true,
        expectPreview: null,
      },
      {
        name: "plan mode blocks mutating tool",
        tool: mutate,
        input: {},
        permission: { mode: "default" },
        planMode: true,
        expectPreview: "plan-blocked",
        expectContent: "blocked in plan mode",
      },
      {
        name: "acceptEdits + mutating ⇒ allow",
        tool: mutate,
        input: {},
        permission: { mode: "acceptEdits" },
        expectPreview: null,
      },
      {
        name: "always-confirm + HITL + decline ⇒ declined",
        tool: alwaysConfirm,
        input: {},
        permission: { mode: "bypass" },
        hitl: { enabled: true },
        onConfirm: async () => false,
        expectPreview: "declined",
        expectContent: "always-confirm tier",
      },
      {
        name: "always-confirm + HITL + accept ⇒ runs",
        tool: alwaysConfirm,
        input: {},
        permission: { mode: "bypass" },
        hitl: { enabled: true },
        onConfirm: async () => true,
        expectPreview: null,
      },
      {
        name: "always-confirm WITHOUT HITL ⇒ bypass allows it (tier ignored)",
        tool: alwaysConfirm,
        input: {},
        permission: { mode: "bypass" },
        expectPreview: null,
      },
    ]

    for (const s of scenarios) {
      const buildCfg = (): AgentConfig =>
        cfg({
          registry: new ToolRegistry([s.tool]),
          permission: s.permission,
          ...(s.hitl ? { hitl: s.hitl } : {}),
          ...(s.planMode !== undefined ? { planMode: s.planMode } : {}),
          ...(s.onConfirm ? { onConfirm: s.onConfirm } : {}),
        })

      // Path A: runAdmissibilityGate directly
      const direct = await runAdmissibilityGate(
        call(s.tool.name, s.input),
        buildCfg(),
        s.permission,
        { tool: s.tool.name, input: s.input, isReadOnly: s.tool.isReadOnly() },
      )

      // Path B: dispatchTool — which funnels through the same gate.
      const dispatched = await dispatchTool(call(s.tool.name, s.input), buildCfg(), s.permission)

      if (s.expectPreview === null) {
        // Tool ran — both paths should reflect ok-success.
        expect(direct, `[${s.name}] direct should be null when admissible`).toBeNull()
        expect(dispatched.ok, `[${s.name}] dispatched should be ok`).toBe(true)
      } else {
        expect(direct, `[${s.name}] direct should not be null`).not.toBeNull()
        expect(direct?.preview, `[${s.name}] direct preview`).toBe(s.expectPreview)
        expect(dispatched.preview, `[${s.name}] dispatched preview`).toBe(s.expectPreview)
        if (s.expectContent) {
          expect(direct?.block.content, `[${s.name}] direct content`).toContain(s.expectContent)
          expect(dispatched.block.content, `[${s.name}] dispatched content`).toContain(
            s.expectContent,
          )
        }
      }
    }
  })
})

describe("runAdmissibilityGate: pattern auto-pass CANNOT bypass HARD_DENY (AUDIT-FIX)", () => {
  // Fail-open closed: with ONLY `permissionPatternStore` wired (no rulesStore /
  // reviewerPort), a covered-pattern action used to skip the pulled-ahead
  // HARD_DENY at gate step 2 and `auto_pass` straight to the hook — routing a
  // denylisted command (e.g. `rm -rf /`) around the security boundary. The fix
  // adds permissionPatternStore to the step-2 trigger so HARD_DENY fires first.
  test("HARD_DENY beats a fully-covered pattern auto-pass", async () => {
    const { PatternGrantStore } = await import("@/permission")
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    const store = new PatternGrantStore(["bash:rm"]) // pattern IS granted
    const input = { command: "rm -rf /" }
    const action: AdmissibilityAction = {
      tool: "bash",
      input,
      isReadOnly: false,
      rememberPatterns: ["bash:rm"],
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permissionPatternStore: store,
      permission: { mode: "bypass" },
    } as Partial<AgentConfig>)
    const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, action)
    // HARD_DENY must win — NOT a null (auto-pass) result.
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("handoff")
    expect(res?.block.content).toContain("human handoff")
  })

  test("a SAFE covered-pattern action (no HARD_DENY) still auto-passes", async () => {
    const { PatternGrantStore } = await import("@/permission")
    const readish = makeTool("read_file", { readOnly: true, schema: z.object({ path: z.string() }) })
    const store = new PatternGrantStore(["read:src"])
    const action: AdmissibilityAction = {
      tool: "read_file",
      input: { path: "src/x.ts" },
      isReadOnly: true,
      rememberPatterns: ["read:src"],
    }
    const c = cfg({
      registry: new ToolRegistry([readish]),
      permissionPatternStore: store,
      permission: { mode: "default" },
    } as Partial<AgentConfig>)
    const res = await runAdmissibilityGate(call("read_file", { path: "src/x.ts" }), c, { mode: "default" }, action)
    // No HARD_DENY on a read-only path ⇒ auto-pass admits (null).
    expect(res).toBeNull()
  })
})
