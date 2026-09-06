/**
 * Architecture guard for `@/side-agent` — config in
 * `_arch/slice-boundary-configs.ts`.
 *
 * The leaf barrel + registries stay dependency-clean; the documented
 * `worker-charter-runner.ts` composition root may carry only the reviewed
 * `allowImports` carve-outs. The negative-proof block below drives synthetic
 * imports through the LIVE policy (red-on-injection) so the guard is provably
 * not vacuous.
 */

import { describe, expect, test } from "bun:test"
import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import {
  extractImports,
  isImportDeniedByConfig,
  registerSliceBoundarySuite,
} from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("side-agent"))

describe("@/side-agent boundary policy is governed (negative proof)", () => {
  const cfg = getSliceBoundaryConfig("side-agent")
  const worker = "worker-charter-runner.ts"
  const leaf = "process.ts"

  test("FIRES: a peer-library VALUE import (@/memory, @/session) is denied", () => {
    expect(isImportDeniedByConfig("@/memory", cfg)).toBe(true)
    expect(isImportDeniedByConfig("@/session", cfg)).toBe(true)
  })

  test("FIRES: a Layer-2 up-import (@/runner, @/host, @/ipc, @/apps) is denied", () => {
    expect(isImportDeniedByConfig("@/runner", cfg)).toBe(true)
    expect(isImportDeniedByConfig("@/host", cfg)).toBe(true)
    expect(isImportDeniedByConfig("@/ipc", cfg)).toBe(true)
    expect(isImportDeniedByConfig("@/apps", cfg)).toBe(true)
  })

  test("FIRES: an un-reviewed @/agent sub-barrel is still denied", () => {
    // Only the two documented `@/agent/*` runner sub-barrels are carved out;
    // the bare slice and any other path must stay denied.
    expect(isImportDeniedByConfig("@/agent", cfg)).toBe(true)
    expect(isImportDeniedByConfig("@/agent/loop", cfg)).toBe(true)
    expect(isImportDeniedByConfig("@/agent", cfg, worker)).toBe(true)
    expect(isImportDeniedByConfig("@/agent/loop", cfg, worker)).toBe(true)
  })

  test("CLEAN: worker-charter-runner may use the documented composition imports", () => {
    const src = [
      'import { createLLM } from "@/llm"',
      'import { replayLlmPort } from "@/llm/replay"',
      'import { buildDefaultTools } from "@/tool"',
      'import { subagentRunnerToSidePass } from "@/agent/side-agent-runner"',
    ].join("\n")
    const specs = extractImports(src).map((row) => row.spec)
    expect(specs).toEqual(["@/llm", "@/llm/replay", "@/tool", "@/agent/side-agent-runner"])
    for (const spec of specs) {
      expect(isImportDeniedByConfig(spec, cfg, worker)).toBe(false)
    }
  })

  test("FIRES: the same @/llm import in process.ts is denied", () => {
    const src = 'import { createLLM } from "@/llm"\n'
    const specs = extractImports(src)
    expect(specs).toHaveLength(1)
    expect(specs[0]?.spec).toBe("@/llm")
    expect(isImportDeniedByConfig("@/llm", cfg, leaf)).toBe(true)
    expect(isImportDeniedByConfig("@/tool", cfg, leaf)).toBe(true)
    expect(isImportDeniedByConfig("@/llm/replay", cfg, leaf)).toBe(true)
  })

  test("FIRES: an unapproved specifier is denied even on the worker file", () => {
    const src = 'import { something } from "@/memory"\n'
    const specs = extractImports(src)
    expect(specs).toHaveLength(1)
    expect(isImportDeniedByConfig(specs[0]?.spec ?? "", cfg, worker)).toBe(true)
  })

  test("CLEAN: the true leaf dep (@/shared) is NOT denied", () => {
    expect(isImportDeniedByConfig("@/shared", cfg)).toBe(false)
    expect(isImportDeniedByConfig("@/shared", cfg, leaf)).toBe(false)
  })
})
