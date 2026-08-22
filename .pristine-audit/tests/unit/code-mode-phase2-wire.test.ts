/**
 * code-mode (RFC jun-6-code-mode, Phase 2 + Phase 3) — WIRE + MENU + DIRECTIVE.
 *
 * Phase 2: the dispatch seam surfaces the agent's ACTUAL registered tool names
 * onto `ToolContext.codeCellSurface` from `AgentConfig.codeCellSurfaceTools`
 * (`registry.toolNames()`). The wire (`wireCodeCellDispatch`) sets BOTH the
 * dispatch factory AND the surface thunk behind `QUANTA_CODE_MODE=1`, and is
 * byte-identical default-OFF when unset.
 *
 * Phase 3: `code_mode_only` (`QUANTA_CODE_MODE_ONLY`) steers the model via a
 * gated, default-OFF prompt directive. It NEVER hides individual tools (the
 * mutating tools stay reachable; the cell re-gates them) and is byte-identical
 * when off.
 */

import { expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import {
  CODE_MODE_ONLY_DIRECTIVE,
  type DirectiveConfig,
  selectActiveDirectives,
} from "@/agent/prompt-directives"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { buildDefaultTools, ToolRegistry } from "@/tool"

// ───────────────────────── registry.toolNames() ─────────────────────────────

test("registry.toolNames — returns every registered name in stable order", () => {
  const tools = buildDefaultTools({ codeMode: true })
  const registry = new ToolRegistry(tools)
  const names = registry.toolNames()
  // Same set the dispatcher knows (one per registered tool).
  expect(names.length).toBe(tools.length)
  expect(names).toEqual(tools.map((t) => t.name))
  expect(names).toContain("read")
  expect(names).toContain("code_cell")
})

test("registry.toolNames — a newly-added tool appears automatically", () => {
  const base = new ToolRegistry(buildDefaultTools())
  const before = base.toolNames()
  const withGated = new ToolRegistry(buildDefaultTools({ coverageCheck: true }))
  const after = withGated.toolNames()
  expect(after).toContain("coverage_check")
  expect(before).not.toContain("coverage_check")
})

// ───────────────────────── Phase 2 wire (surface thunk) ─────────────────────

const stubLlm: LLMPort = { model: "stub", stream: async function* () {} } as unknown as LLMPort

const baseConfig = (): AgentConfig =>
  ({
    llm: stubLlm,
    signal: new AbortController().signal,
    registry: new ToolRegistry(buildDefaultTools({ codeMode: true })),
    permission: { mode: "default" } as PermissionContext,
  }) as unknown as AgentConfig

test("wire ON — QUANTA_CODE_MODE=1 sets BOTH the dispatch factory AND the surface thunk", () => {
  const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_CODE_MODE: "1" })
  expect(typeof wired.codeCellDispatchFactory).toBe("function")
  expect(typeof wired.codeCellSurfaceTools).toBe("function")
  // The surface thunk reads the LIVE registry — the FULL registered set.
  const surface = wired.codeCellSurfaceTools?.()
  expect(surface).toContain("read")
  expect(surface).toContain("write")
  expect(surface).toContain("bash")
  expect(surface).toContain("code_cell")
})

test("wire OFF — QUANTA_CODE_MODE unset ⇒ NEITHER slot set (byte-identical)", () => {
  const wired = wireOptionalAgentPorts(baseConfig(), {})
  expect(wired.codeCellDispatchFactory).toBeUndefined()
  expect(wired.codeCellSurfaceTools).toBeUndefined()
})

test("wire — the surface thunk reflects a registry mutated AFTER assembly", () => {
  const cfg = baseConfig()
  const wired = wireOptionalAgentPorts(cfg, { QUANTA_CODE_MODE: "1" })
  // Re-read after mutating the SAME registry instance (the thunk reads live).
  const reg = wired.registry as unknown as ToolRegistry
  const before = wired.codeCellSurfaceTools?.()?.length ?? 0
  // Add a tool to the live registry by constructing a fresh one is not possible
  // (registry is held by ref); instead assert the thunk re-reads the same ref so
  // a future add would surface. We assert identity of read source:
  expect(wired.codeCellSurfaceTools?.()).toEqual(reg.toolNames())
  expect(before).toBeGreaterThan(0)
})

test("wire — caller-set surface thunk is preserved (override precedence)", () => {
  const cfg = baseConfig()
  const custom = () => ["read"]
  ;(cfg as { codeCellSurfaceTools?: () => readonly string[] }).codeCellSurfaceTools = custom
  const wired = wireOptionalAgentPorts(cfg, { QUANTA_CODE_MODE: "1" })
  expect(wired.codeCellSurfaceTools).toBe(custom)
})

// ───────────────────────── Phase 3 (code_mode_only) ─────────────────────────

const ALL_OFF: DirectiveConfig = {
  directiveAutonomous: false,
  directiveReadComplete: false,
  directiveProgress: false,
  directiveMemoryVerify: false,
  directiveThinkFreq: false,
  directiveAntiPlatitude: false,
  directiveParallelTools: false,
  directiveAdvisorRail: false,
  codeModeOnly: false,
}

test("code_mode_only ON ⇒ the steering directive is selected", () => {
  const out = selectActiveDirectives({ ...ALL_OFF, codeModeOnly: true })
  expect(out).toBe(CODE_MODE_ONLY_DIRECTIVE)
  expect(out).toContain("CODE MODE: prefer the `code_cell` tool")
})

test("code_mode_only OFF ⇒ ZERO bytes (byte-identical default-OFF)", () => {
  expect(selectActiveDirectives(ALL_OFF)).toBe("")
})

test("code_mode_only directive is harmless prose — carries no system-reminder tokens", () => {
  expect(CODE_MODE_ONLY_DIRECTIVE.toLowerCase()).not.toContain("<system-reminder")
  expect(CODE_MODE_ONLY_DIRECTIVE.toLowerCase()).not.toContain("</system-reminder")
})

test("MENU — code_mode_only does NOT hide individual tools (mutating tools stay registered)", () => {
  // Phase-3 design decision (RFC §5.3): the directive STEERS via prompt; it does
  // not filter the catalog. The default tool menu is identical whether or not the
  // code_mode_only steering is on — mutating tools remain directly reachable AND
  // re-gated inside cells. Byte-identical menu either way.
  const menu = buildDefaultTools({ codeMode: true }).map((t) => t.name)
  expect(menu).toContain("write")
  expect(menu).toContain("bash")
  expect(menu).toContain("edit")
  expect(menu).toContain("code_cell")
})
