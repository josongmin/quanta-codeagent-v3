/**
 * §10.2 e2e hellgate — drive an argv-array rule through the REAL
 * admissibility-gate seam (not just the unit matcher).
 *
 * This proves the full chain end-to-end:
 *   bash tool call → ToolRegistry.extractShellCommand → RulesStore.match →
 *   argv token-prefix match → terminal deny / allow with the real preview.
 *
 * A Codex-style `deny ["rm", "-rf"]` argv rule must DENY `rm -rf ./dist`
 * (token-prefix) but a partial-token command (`rm -rfx`) must NOT match the
 * rule — exactly the semantics a byte-prefix rule cannot express.
 */
import { describe, expect, test } from "bun:test"
import { type AdmissibilityWaveAOptions, runAdmissibilityGate } from "@/agent/admissibility-gate"
import { RulesStore } from "@/rules"
import { ToolRegistry } from "@/tool"
import { actionOf, bashSchema, call, cfg, makeTool } from "./admissibility-wave-a/_fixtures"

const loadedStore = (lines: string): RulesStore => {
  const s = new RulesStore()
  s.loadLayer("user", lines, "user.rules")
  return s
}

const bash = makeTool("bash", {
  readOnly: false,
  schema: bashSchema,
  extractShellCommand: (input) => (input as { command: string }).command,
})

const runGate = async (storeLines: string, command: string) => {
  const wave: AdmissibilityWaveAOptions = { rulesStore: loadedStore(storeLines) }
  const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
  const input = { command }
  return runAdmissibilityGate(
    call("bash", input),
    c,
    { mode: "bypass" },
    actionOf(bash, input),
    undefined,
    wave,
  )
}

describe("§10.2 e2e — argv-array deny rule through the real gate", () => {
  test('deny ["rm","-rf"] DENIES `rm -rf ./dist` (token-prefix)', async () => {
    const res = await runGate('deny ["rm", "-rf"]\n', "rm -rf ./dist")
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_deny")
    expect(res?.block.content).toContain("Permission denied by rule")
  })

  test('deny ["rm","-rf"] does NOT match `rm -rfx` (partial token => no deny)', async () => {
    // `-rfx` is a distinct token; a byte-prefix rule on `rm -rf` would match,
    // an argv rule does not. Under bypass mode + no match the gate admits.
    const res = await runGate('deny ["rm", "-rf"]\n', "rm -rfx ./dist")
    expect(res).toBeNull()
  })

  test('allow ["git","status"] ADMITS `git status --short` (skips HITL)', async () => {
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "default" } })
    const input = { command: "git status --short" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "default" },
      actionOf(bash, input),
      undefined,
      { rulesStore: loadedStore('allow ["git", "status"]\n') },
    )
    expect(res).toBeNull()
  })

  test("a bracket-free legacy store still denies byte-prefix (byte-identical path)", async () => {
    const res = await runGate("deny rm -rf\n", "rm -rf ./dist")
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_deny")
  })
})
