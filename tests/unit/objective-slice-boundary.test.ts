/**
 * Architecture guard for `@/objective` — config in `_arch/slice-boundary-configs.ts`.
 * Entrypoint that runs the per-slice boundary suite (paired 1:1 with the config;
 * enforced by tests/unit/slice-boundary-config-parity.test.ts).
 *
 * RFC-03 C0: `@/objective` was atomically promoted out of its former
 * agent-nested location into a top-level leaf slice.
 * It is a pure LEAF DOMAIN — no value import from agent/tool/session/permission/
 * runner/host/protocol/apps; effects flow through injected ports. The deny-list
 * assertions below are red-on-injection proof that the guard has teeth for the
 * exact up-import class this promotion must forbid (`@/objective → @/agent`).
 */

import { describe, expect, test } from "bun:test"
import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import { isImportDeniedByConfig, registerSliceBoundarySuite } from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("objective"))

describe("@/objective leaf-domain deny-list has teeth (red-on-injection)", () => {
  const objective = getSliceBoundaryConfig("objective")

  test("FIRES: a VALUE import of @/agent from @/objective is denied (the back-edge lock)", () => {
    // The promotion's whole point: objective must NEVER import the agent bridge
    // back. This is the exact synthetic violation the RED-first step injects into
    // a real src/objective/*.ts file to prove the scanner NAMES it. Any nested
    // agent path (the former home of this slice) is covered by the @/agent prefix.
    expect(isImportDeniedByConfig("@/agent", objective)).toBe(true)
    expect(isImportDeniedByConfig("@/agent/loop", objective)).toBe(true)
  })

  test("FIRES: peer-library up/cross imports (@/tool, @/session, @/permission) are denied", () => {
    expect(isImportDeniedByConfig("@/tool", objective)).toBe(true)
    expect(isImportDeniedByConfig("@/session", objective)).toBe(true)
    expect(isImportDeniedByConfig("@/permission", objective)).toBe(true)
  })

  test("FIRES: Layer-2 up-imports (@/runner, @/host, @/ipc, @/apps) are denied", () => {
    expect(isImportDeniedByConfig("@/runner", objective)).toBe(true)
    expect(isImportDeniedByConfig("@/host", objective)).toBe(true)
    expect(isImportDeniedByConfig("@/ipc", objective)).toBe(true)
    expect(isImportDeniedByConfig("@/apps", objective)).toBe(true)
  })

  test("CLEAN: its only real runtime dependency (@/shared) is NOT denied", () => {
    expect(isImportDeniedByConfig("@/shared", objective)).toBe(false)
  })

  test("CLEAN: an intra-slice self-import (@/objective/store) is NOT denied", () => {
    expect(isImportDeniedByConfig("@/objective/store", objective)).toBe(false)
  })
})
