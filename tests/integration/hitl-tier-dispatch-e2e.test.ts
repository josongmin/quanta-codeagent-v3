/**
 * End-to-end dispatch coverage for the HITL 4-tier annotation registry
 * (ADR-0047). Exercises `dispatchTool` — NOT `runAdmissibilityGate` directly
 * — so we catch any drift between the gate's composed-tier resolution and
 * the dispatch surface (`DispatchResult`).
 *
 * Each test stands up a minimal tool, configures `hitl.enabled = true`, and
 * asserts:
 *   - tier=hand-off-required ⇒ deny block with `preview="handoff"`, body
 *     carries the registry's `handoffMessage` (so the UI can render it)
 *   - tier=always-confirm ⇒ deny block with `preview="declined"` even under
 *     `mode: "bypass"`
 *   - tier=pre-approval-ok ⇒ tool RUNS under bypass mode
 *   - tier=none ⇒ tool RUNS even under `mode: "default"` (skips ask)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
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
      yield { type: "result", result: { ok: true, output: "ran-ok" } }
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

describe("hitl-tier dispatch e2e — each tier surfaces a distinct DispatchResult", () => {
  beforeEach(() => {
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("hand-off-required: dispatchTool returns a deny block with preview='handoff' carrying handoffMessage", async () => {
    // exec_command + `rm -rf /` → registry pattern → hand-off-required.
    const exec = makeTool("exec_command", { schema: z.object({ command: z.string() }) })
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const out = await dispatchTool(call("exec_command", { command: "rm -rf /" }), c, {
      mode: "bypass",
    })
    expect(out.ok).toBe(false)
    expect(out.preview).toBe("handoff")
    // The handoff body must include enough information for a UI to show the
    // operator what happened (not silent rejection).
    expect(out.block.content).toContain("human handoff")
    expect(out.block.content).toContain("rm -rf")
    expect(out.block.content).toContain("Agent cannot proceed")
    expect(out.block.is_error).toBe(true)
  })

  test("always-confirm: bypass mode cannot skip; declined ⇒ preview='declined'", async () => {
    const exec = makeTool("exec_command", { schema: z.object({ command: z.string() }) })
    let askedWith: unknown = null
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async (a) => {
        askedWith = a
        return false
      },
      permission: { mode: "bypass" },
    })
    const out = await dispatchTool(call("exec_command", { command: "git push origin main" }), c, {
      mode: "bypass",
    })
    expect(askedWith).not.toBeNull()
    expect(out.ok).toBe(false)
    expect(out.preview).toBe("declined")
    expect(out.block.content).toContain("always-confirm tier")
  })

  test("always-confirm: accepted ⇒ tool runs (ok:true)", async () => {
    const exec = makeTool("exec_command", { schema: z.object({ command: z.string() }) })
    const c = cfg({
      registry: new ToolRegistry([exec]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const out = await dispatchTool(call("exec_command", { command: "git push origin main" }), c, {
      mode: "bypass",
    })
    expect(out.ok).toBe(true)
    expect(out.preview).toBe("ran-ok")
  })

  test("pre-approval-ok: bypass mode admits without confirm", async () => {
    // apply_patch ⇒ registry says pre-approval-ok; bypass admits.
    const ap = makeTool("apply_patch")
    let askedCount = 0
    const c = cfg({
      registry: new ToolRegistry([ap]),
      hitl: { enabled: true },
      onConfirm: async () => {
        askedCount += 1
        return true
      },
      permission: { mode: "bypass" },
    })
    const out = await dispatchTool(call("apply_patch"), c, { mode: "bypass" })
    expect(out.ok).toBe(true)
    expect(askedCount).toBe(0)
  })

  test("none: default mode still admits (skips ask)", async () => {
    // spawn_agent is registered as tier="none" in the registry.
    const sa = makeTool("spawn_agent")
    let askedCount = 0
    const c = cfg({
      registry: new ToolRegistry([sa]),
      hitl: { enabled: true },
      onConfirm: async () => {
        askedCount += 1
        return false
      },
      permission: { mode: "default" },
    })
    const out = await dispatchTool(call("spawn_agent"), c, { mode: "default" })
    expect(out.ok).toBe(true)
    expect(askedCount).toBe(0)
  })

  test("backwards compat: unknown tool + HITL disabled ⇒ default behavior unchanged", async () => {
    // No hitl block ⇒ the new annotation registry is bypassed entirely; the
    // existing mode policy gates the call.
    const t = makeTool("totally_unknown", { readOnly: false })
    const c = cfg({
      registry: new ToolRegistry([t]),
      permission: { mode: "bypass" },
    })
    const out = await dispatchTool(call("totally_unknown"), c, { mode: "bypass" })
    expect(out.ok).toBe(true)
  })
})

describe("hitl-tier dispatch e2e — user override file changes runtime behavior", () => {
  let tmp: string
  let overridesPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hitl-e2e-"))
    overridesPath = join(tmp, "hitl-overrides.json")
    process.env.QUANTA_HITL_OVERRIDES = overridesPath
    __resetHitlOverrides()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.QUANTA_HITL_OVERRIDES
    __resetHitlOverrides()
  })

  test("override turns a normally-OK tool into hand-off-required (custom handoffMessage surfaces in deny body)", async () => {
    writeFileSync(
      overridesPath,
      JSON.stringify({
        write: {
          tier: "hand-off-required",
          handoffMessage: "Writes are disabled in this deployment by ops policy.",
        },
      }),
    )
    __resetHitlOverrides()
    const w = makeTool("write", {
      schema: z.object({ path: z.string(), content: z.string() }),
      hitlTier: () => "pre-approval-ok",
    })
    const c = cfg({
      registry: new ToolRegistry([w]),
      hitl: { enabled: true },
      onConfirm: async () => true,
      permission: { mode: "bypass" },
    })
    const out = await dispatchTool(call("write", { path: "x.ts", content: "y" }), c, {
      mode: "bypass",
    })
    expect(out.ok).toBe(false)
    expect(out.preview).toBe("handoff")
    expect(out.block.content).toContain("Writes are disabled in this deployment")
  })
})
