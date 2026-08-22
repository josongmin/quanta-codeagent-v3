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
import { isImportDeniedByConfig, registerSliceBoundarySuite } from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("side-agent"))

describe("@/side-agent boundary policy is governed (negative proof)", () => {
  const cfg = getSliceBoundaryConfig("side-agent")

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
  })

  test("CLEAN: the documented worker-charter-runner carve-outs are NOT denied", () => {
    expect(isImportDeniedByConfig("@/agent/side-agent-runner", cfg)).toBe(false)
    expect(isImportDeniedByConfig("@/agent/subagent-runner", cfg)).toBe(false)
    expect(isImportDeniedByConfig("@/llm", cfg)).toBe(false)
    expect(isImportDeniedByConfig("@/llm/replay", cfg)).toBe(false)
    expect(isImportDeniedByConfig("@/tool", cfg)).toBe(false)
  })

  test("CLEAN: the true leaf dep (@/shared) is NOT denied", () => {
    expect(isImportDeniedByConfig("@/shared", cfg)).toBe(false)
  })
})
