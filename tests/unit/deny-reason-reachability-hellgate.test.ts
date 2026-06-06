/**
 * HELLGATE — C6 deny-reason REACHABILITY through the REAL admissibility-gate.
 *
 * Phase 1 shipped the pure leaf (`structuredDenyReason` / `denyContentPrefix`)
 * + its structure/no-leak hellgates, but NO deny SITE called it: the
 * `surfaceDenyReason` (`QUANTA_DENY_REASON`) flag flowed to NO consumer, so the
 * feature was inert. This battery proves the L4 wiring step — the gate's
 * `deny(..., denyReason(...))` sites — is now CONFIG-REACHABLE:
 *
 *   1. knob-ON  ⇒ a denial through the real `runAdmissibilityGate` carries the
 *      structured `denyReason` (right `layer`/`pillar`) on the
 *      `ToolFailure.permission_denied` envelope AND the categorical
 *      `[denied · layer=… · pillar=…]` prefix on the model-facing content.
 *   2. knob-OFF ⇒ the failure envelope is BYTE-IDENTICAL to today: a deny that
 *      did not carry a `permission_denied` failure carries NONE; a deny that
 *      did (the steered always-confirm path) carries `{mode, isReadonly}` ONLY,
 *      with NO `denyReason` key and NO content prefix.
 *   3. Each policy layer maps to the right `layer` (hard-deny / stack / reviewer
 *      / hook / tool-profile / mode).
 *   4. HARD_DENY surfaces WITHOUT leaking the matched command/pattern: the
 *      structured `safeReason` + the content prefix contain NONE of a hostile
 *      command, embedded secret, or regex source — even though the prose
 *      `content` (agent-authored) may echo the command.
 *
 * Defect class: a deny SITE attaches the COMMAND-echoing prose (or any raw
 * input) to the STRUCTURED field, or the knob-OFF path drifts from the legacy
 * `{block, ok:false, preview}` shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type HITLTier, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent, ToolFailure } from "@/tool"
import { ToolRegistry } from "@/tool"

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    hitlTier?: (input: unknown) => HITLTier
  } = {},
): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () =>
      (async function* (): AsyncIterable<ToolEvent> {
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

/** Narrow a DispatchResult failure to the permission_denied arm (or undefined). */
const permFailure = (
  f: ToolFailure | undefined,
): Extract<ToolFailure, { mode: "permission_denied" }> | undefined =>
  f?.mode === "permission_denied" ? f : undefined

let permissionStateRoot: string
const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
const originalDenyReason = process.env.QUANTA_DENY_REASON

const setKnob = (on: boolean): void => {
  if (on) process.env.QUANTA_DENY_REASON = "1"
  else delete process.env.QUANTA_DENY_REASON
  __resetRuntimeConfig()
}

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "deny-reach-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  if (originalDenyReason === undefined) delete process.env.QUANTA_DENY_REASON
  else process.env.QUANTA_DENY_REASON = originalDenyReason
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  rmSync(permissionStateRoot, { recursive: true, force: true })
})

describe("hellgate — C6 reachability: knob-ON surfaces structured denyReason", () => {
  test("mode-block deny carries layer=mode + [denied] prefix when knob ON", async () => {
    setKnob(true)
    const mutate = makeTool("mutate", { readOnly: false })
    const c = cfg({ registry: new ToolRegistry([mutate]), planMode: true })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res?.preview).toBe("plan-blocked")
    const f = permFailure(res?.failure)
    expect(f).toBeDefined()
    expect(f?.denyReason?.layer).toBe("mode")
    expect(f?.denyReason?.verdict).toBe("deny")
    // Content carries the categorical prefix (layer at minimum).
    expect(res?.block.content).toContain("[denied · layer=mode")
  })

  test("stack-policy ask→declined carries layer=stack + pillar=approval", async () => {
    setKnob(true)
    const mutate = makeTool("mutate", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      onConfirm: async () => false, // declines the ask
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res?.ok).toBe(false)
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("stack")
    expect(f?.denyReason?.pillar).toBe("approval")
    expect(res?.block.content).toContain("[denied · layer=stack · pillar=approval]")
  })

  test("always-confirm declined carries layer=reviewer + pillar=approval", async () => {
    setKnob(true)
    const tool = makeTool("dangerous", { readOnly: false, hitlTier: () => "always-confirm" })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => false,
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(res?.preview).toBe("declined")
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("reviewer")
    expect(f?.denyReason?.pillar).toBe("approval")
    expect(res?.block.content).toContain("[denied · layer=reviewer · pillar=approval]")
  })

  test("hand-off-required tier carries layer=reviewer", async () => {
    setKnob(true)
    const tool = makeTool("handoff", { readOnly: false, hitlTier: () => "hand-off-required" })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("handoff"), c, { mode: "bypass" }, actionOf(tool))
    expect(res?.preview).toBe("handoff")
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("reviewer")
  })

  test("pre_tool_use hook deny carries layer=hook", async () => {
    setKnob(true)
    const ro = makeTool("read", { readOnly: true })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", async () => ({ deny: "blocked by repo hook" }))
    const c = cfg({
      registry: new ToolRegistry([ro]),
      hooks,
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("read"), c, { mode: "bypass" }, actionOf(ro))
    expect(res?.preview).toBe("hook-denied")
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("hook")
  })

  test("tool-profile deny carries layer=tool-profile", async () => {
    setKnob(true)
    const tool = makeTool("write", { readOnly: false })
    const resolver = {
      resolve: () => ({ kind: "deny" as const, reason: "profile forbids write" }),
    }
    const c = cfg({
      registry: new ToolRegistry([tool]),
      toolProfile: { defaultName: "strict" as never, resolver: resolver as never },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("write"), c, { mode: "bypass" }, actionOf(tool))
    expect(res?.preview).toBe("tool-profile-denied")
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("tool-profile")
    // No leak of the resolver's own categorical message beyond what it authored.
    expect(f?.denyReason?.safeReason).toBe("profile forbids write")
  })
})

describe("hellgate — C6 HARD_DENY no-leak through the real gate", () => {
  const SECRET = "sk-live-DEADBEEF-supersecret-0xCAFE"
  const REGEX = "(?:rm)\\s+-rf\\s+/"

  test("knob-ON HARD_DENY: structured safeReason + prefix leak NONE of cmd/secret/regex", async () => {
    setKnob(true)
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    const c = cfg({
      registry: new ToolRegistry([bash]),
      hitl: { enabled: true },
      onConfirm: async () => true, // approving — HARD_DENY must still win
      permission: { mode: "bypass" },
    })
    const hostileCommand = `rm -rf / ; echo ${SECRET} ; grep -E '${REGEX}'`
    const input = { command: hostileCommand }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
    )
    expect(res?.preview).toBe("handoff")
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("hard-deny")
    // CATEGORICAL safeReason — never the command-echoing prose.
    const safe = f?.denyReason?.safeReason ?? ""
    expect(safe).toBe("blocked dangerous command (pattern hit)")
    for (const leak of [hostileCommand, SECRET, REGEX, "rm -rf"]) {
      expect(safe).not.toContain(leak)
    }
    // The content PREFIX is derived ONLY from layer/pillar — also leak-free.
    const prefix = (res?.block.content ?? "").split("]")[0] ?? ""
    for (const leak of [SECRET, REGEX]) {
      expect(prefix).not.toContain(leak)
    }
    expect(prefix).toContain("[denied · layer=hard-deny")
  })

  test("HARD_DENY via earlyHardDeny (reviewerPort bypass active) is also leak-free", async () => {
    setKnob(true)
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    // A reviewer port makes earlyHardDeny's bypassActive trigger fire (the
    // HARD_DENY is pulled ahead of the rule/reviewer path).
    const reviewerPort = {
      review: async () => ({ outcome: "user_approved" as const, reviewer: "user" as const }),
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "bypass" },
    })
    const hostileCommand = `rm -rf / # ${SECRET}`
    const input = { command: hostileCommand }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      { reviewerPort: reviewerPort as never },
    )
    expect(res?.preview).toBe("handoff")
    const f = permFailure(res?.failure)
    expect(f?.denyReason?.layer).toBe("hard-deny")
    expect(f?.denyReason?.safeReason).toBe("blocked dangerous command (pattern hit)")
    expect(f?.denyReason?.safeReason).not.toContain(SECRET)
  })
})

describe("hellgate — C6 knob-OFF byte-identity (sacred)", () => {
  test("mode-block deny knob-OFF carries NO failure key + NO prefix", async () => {
    setKnob(false)
    const mutate = makeTool("mutate", { readOnly: false })
    const c = cfg({ registry: new ToolRegistry([mutate]), planMode: true })
    const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(mutate))
    expect(res?.preview).toBe("plan-blocked")
    // No failure attached on the basic deny path (legacy shape).
    expect(res?.failure).toBeUndefined()
    expect("failure" in (res ?? {})).toBe(false)
    expect(res?.block.content).not.toContain("[denied ·")
  })

  test("always-confirm declined (no steer) knob-OFF: NO failure key, byte-identical", async () => {
    setKnob(false)
    const tool = makeTool("dangerous", { readOnly: false, hitlTier: () => "always-confirm" })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      onConfirm: async () => false, // plain deny (no deny_and_steer) ⇒ no steer arm
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(res?.preview).toBe("declined")
    // Legacy plain-decline path attached NO failure; knob-OFF preserves that.
    expect(res?.failure).toBeUndefined()
    expect(res?.block.content).not.toContain("[denied ·")
  })

  test("deny_and_steer decline knob-OFF: failure is {mode, isReadonly} ONLY (ADR-0077)", async () => {
    setKnob(false)
    const tool = makeTool("dangerous", { readOnly: false, hitlTier: () => "always-confirm" })
    const c = cfg({
      registry: new ToolRegistry([tool]),
      hitl: { enabled: true },
      // A `deny_and_steer` confirm result exercises the ADR-0077 steer arm that
      // DOES attach a `permission_denied` failure even pre-C6.
      onConfirm: async () => ({ decision: "deny_and_steer", steer: "use read instead" }),
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(call("dangerous"), c, { mode: "bypass" }, actionOf(tool))
    expect(res?.preview).toBe("deny_steer")
    const f = permFailure(res?.failure)
    // The legacy ADR-0077 envelope: present, but with NO denyReason KEY.
    expect(f).toEqual({ mode: "permission_denied", isReadonly: false })
    expect(f && "denyReason" in f).toBe(false)
    expect(res?.block.content).not.toContain("[denied ·")
  })

  test("HARD_DENY knob-OFF (policy evaluate path): no denyReason, no prefix", async () => {
    setKnob(false)
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    // No allow-capable bypass wired ⇒ HARD_DENY surfaces via the mode-policy
    // `evaluate()` path (preview "denied"), not the earlyHardDeny "handoff".
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
    )
    expect(res?.preview).toBe("denied")
    expect(res?.failure).toBeUndefined()
    expect(res?.block.content).not.toContain("[denied ·")
  })

  test("HARD_DENY knob-ON (policy evaluate path): layer=hard-deny, NO command leak", async () => {
    setKnob(true)
    const bash = makeTool("bash", { readOnly: false, schema: bashSchema })
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const leakMarker = "leak-me-not-SECRET"
    const input = { command: `rm -rf / # ${leakMarker}` }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
    )
    expect(res?.preview).toBe("denied")
    const f = permFailure(res?.failure)
    // The policy `evaluate()` HARD_DENY arm sets decision.reason = "Blocked
    // dangerous command: <cmd>" — which echoes the command. The STRUCTURED field
    // MUST switch to the categorical hard-deny form so the command never leaks.
    expect(f?.denyReason?.layer).toBe("hard-deny")
    expect(f?.denyReason?.safeReason).toBe("blocked dangerous command (pattern hit)")
    expect(f?.denyReason?.safeReason).not.toContain(leakMarker)
    expect(f?.denyReason?.safeReason).not.toContain("rm -rf")
    // The content prefix is layer-only ⇒ also leak-free.
    const prefix = (res?.block.content ?? "").split("]")[0] ?? ""
    expect(prefix).not.toContain(leakMarker)
    expect(prefix).toContain("[denied · layer=hard-deny")
  })
})
