/**
 * Unit tests for the HITL 4-tier composition inside `runAdmissibilityGate`
 * (ADR-0047). The gate composes:
 *   - the tool's own `hitlTier(input)` declaration, with
 *   - the name-based registry annotation (`getToolHitlTier`)
 * by taking the STRICTER of the two (one-way ratchet — registry can only
 * tighten, never loosen the tool's own declaration).
 *
 * These tests construct minimal tools and assert the gate's outcome for each
 * tier:
 *   - tier=hand-off-required ⇒ deny preview="handoff"
 *   - tier=always-confirm    ⇒ deny preview="declined" (or admissible after
 *                              approval) — fires regardless of approval_policy
 *   - tier=pre-approval-ok   ⇒ falls through to mode policy
 *   - tier=none              ⇒ admissible (skip mode policy + classifier)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import { __resetHitlOverrides } from "@/agent/hitl-tier-registry"
import type { ToolUseBlock } from "@/llm"
import type { HITLTier, PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
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
    description: `${name}`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: async function* (): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
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

describe("HITL tier gate — built-in registry composition", () => {
  beforeEach(() => {
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("exec_command with `rm -rf /` ⇒ hand-off-required (deny preview='handoff') even with bypass + onConfirm", async () => {
    // The tool itself has NO hitlTier — the registry's command-pattern match
    // is what escalates this to hand-off-required.
    const exec = makeTool("exec_command", { schema: z.object({ command: z.string() }) })
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("exec_command", input),
      c,
      { mode: "bypass" },
      { tool: "exec_command", input, isReadOnly: false },
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("handoff")
    // The registry's handoffMessage should be surfaced.
    expect(res?.block.content).toContain("rm -rf")
  })

  test("exec_command with `git push --force` ⇒ always-confirm; declined ⇒ deny preview='declined'", async () => {
    const exec = makeTool("exec_command", { schema: z.object({ command: z.string() }) })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async () => {
        asked = true
        return false
      },
      // Even bypass cannot skip always-confirm.
      permission: { mode: "bypass" },
    })
    const input = { command: "git push --force origin main" }
    const res = await runAdmissibilityGate(
      call("exec_command", input),
      c,
      { mode: "bypass" },
      { tool: "exec_command", input, isReadOnly: false },
    )
    expect(asked).toBe(true)
    expect(res?.preview).toBe("declined")
    expect(res?.block.content).toContain("always-confirm tier")
  })

  test("exec_command with `ls` ⇒ none (admissible, no mode policy consulted)", async () => {
    const exec = makeTool("exec_command", { schema: z.object({ command: z.string() }) })
    let confirmCalled = false
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async () => {
        confirmCalled = true
        return false
      },
      // default mode would normally ask for a mutating tool — but tier=none
      // short-circuits that.
      permission: { mode: "default" },
    })
    const input = { command: "ls -la" }
    const res = await runAdmissibilityGate(
      call("exec_command", input),
      c,
      { mode: "default" },
      { tool: "exec_command", input, isReadOnly: false },
    )
    expect(res).toBeNull()
    expect(confirmCalled).toBe(false)
  })

  test("apply_patch ⇒ pre-approval-ok; bypass mode allows admissibly", async () => {
    const ap = makeTool("apply_patch")
    const c = cfg({
      registry: new ToolRegistry([ap]),
      hitl: { enabled: true },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("apply_patch"),
      c,
      { mode: "bypass" },
      { tool: "apply_patch", input: {}, isReadOnly: false },
    )
    expect(res).toBeNull()
  })

  test("spawn_agent ⇒ none; admissible without confirm", async () => {
    const sa = makeTool("spawn_agent")
    const c = cfg({
      registry: new ToolRegistry([sa]),
      hitl: { enabled: true },
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(
      call("spawn_agent"),
      c,
      { mode: "default" },
      { tool: "spawn_agent", input: {}, isReadOnly: false },
    )
    expect(res).toBeNull()
  })

  test("unknown tool with mutating semantics ⇒ pre-approval-ok (today's behavior, backwards compat)", async () => {
    // A mutating tool with NO hitlTier declaration and NO registry entry must
    // fall through to mode policy (default ⇒ ask). The crucial check is that
    // the registry doesn't escalate to always-confirm or hand-off-required.
    const unknown = makeTool("totally_new_tool", {
      readOnly: false,
      hitlTier: () => "pre-approval-ok",
    })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([unknown]),
      hitl: { enabled: true },
      onConfirm: async () => {
        asked = true
        return true
      },
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(
      call("totally_new_tool"),
      c,
      { mode: "default" },
      { tool: "totally_new_tool", input: {}, isReadOnly: false },
    )
    expect(asked).toBe(true)
    expect(res).toBeNull()
  })
})

describe("HITL tier gate — registry ESCALATES tool declarations (one-way ratchet)", () => {
  beforeEach(() => {
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("tool declares 'pre-approval-ok' but registry pattern says 'always-confirm' ⇒ always-confirm wins", async () => {
    // Tool says everything is fine; registry sees `git push` and escalates.
    const exec = makeTool("exec_command", {
      schema: z.object({ command: z.string() }),
      hitlTier: () => "pre-approval-ok",
    })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async () => {
        asked = true
        return false
      },
      permission: { mode: "bypass" },
    })
    const input = { command: "git push origin main" }
    const res = await runAdmissibilityGate(
      call("exec_command", input),
      c,
      { mode: "bypass" },
      { tool: "exec_command", input, isReadOnly: false },
    )
    expect(asked).toBe(true)
    expect(res?.preview).toBe("declined")
  })

  test("tool declares 'always-confirm' but registry says 'none' ⇒ always-confirm wins (registry CANNOT loosen)", async () => {
    // Edge case: registry has read ⇒ none, but tool overrides itself to
    // always-confirm. The stricter declaration (tool's) must win.
    const t = makeTool("read", {
      readOnly: true,
      hitlTier: () => "always-confirm",
    })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([t]),
      hitl: { enabled: true },
      onConfirm: async () => {
        asked = true
        return false
      },
      permission: { mode: "bypass" },
    })
    const res = await runAdmissibilityGate(
      call("read", { path: "x.ts" }),
      c,
      { mode: "bypass" },
      { tool: "read", input: { path: "x.ts" }, isReadOnly: true },
    )
    expect(asked).toBe(true)
    expect(res?.preview).toBe("declined")
  })
})

describe("HITL tier gate — user override file", () => {
  let tmp: string
  let overridesPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hitl-gate-"))
    overridesPath = join(tmp, "hitl-overrides.json")
    process.env.QUANTA_HITL_OVERRIDES = overridesPath
    __resetHitlOverrides()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("override forces hand-off-required on a normally-OK tool", async () => {
    writeFileSync(
      overridesPath,
      JSON.stringify({
        write: {
          tier: "hand-off-required",
          handoffMessage: "All writes require manual operator approval per ops policy.",
        },
      }),
    )
    __resetHitlOverrides()
    const writeTool = makeTool("write", {
      schema: z.object({ path: z.string(), content: z.string() }),
      hitlTier: () => "pre-approval-ok",
    })
    const c = cfg({
      registry: new ToolRegistry([writeTool]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const input = { path: "x.ts", content: "y" }
    const res = await runAdmissibilityGate(
      call("write", input),
      c,
      { mode: "bypass" },
      { tool: "write", input, isReadOnly: false },
    )
    expect(res?.preview).toBe("handoff")
    expect(res?.block.content).toContain("manual operator approval")
  })
})
