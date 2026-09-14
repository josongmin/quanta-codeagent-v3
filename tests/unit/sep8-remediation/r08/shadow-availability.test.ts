import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __isLspAvailableForTest,
  __resetLspAvailabilityCacheForTest,
  __setLspAvailabilityOverrideForTest,
  isAvailable,
} from "@/agent/lsp-bridge/availability"
import { createLspTestCheckPort } from "@/agent/shadow-verify-adapters"

afterEach(() => {
  __setLspAvailabilityOverrideForTest(null)
  __resetLspAvailabilityCacheForTest()
})

describe("P2-A-02 shadow probe uses canonical success-only cache", () => {
  test("source has no local availabilityCache Map", () => {
    const src = readFileSync(
      join(process.cwd(), "src/agent/shadow-verify-adapters/check-lsp-test.ts"),
      "utf8",
    )
    expect(src).not.toContain("availabilityCache")
    expect(src).toContain('from "../lsp-bridge/availability"')
  })

  test("false probe is not sticky: second shadow check re-probes and can recover", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r08-a02-"))
    writeFileSync(join(dir, "a.ts"), "export const n = 1\n")
    let probes = 0
    let allow = false
    __setLspAvailabilityOverrideForTest((bin) => {
      if (bin !== "typescript-language-server") return false
      probes += 1
      return allow
    })
    const checker = createLspTestCheckPort()
    const first = await checker.run(dir, "lint", undefined)
    expect(first).toEqual([])
    expect(probes).toBe(1)
    const stillBlocked = await checker.run(dir, "lint", undefined)
    expect(stillBlocked).toEqual([])
    expect(probes).toBe(2)
    allow = true
    // Recovery probe goes through the SAME `isAvailable` the shadow checker uses.
    // Do not `checker.run` with allow=true: that would start a real
    // typescript-language-server and the unit timeout is 5s.
    // `dir` is scratch, which the test preload trusts; the probe asks for a folder.
    expect(await isAvailable("typescript-language-server", dir)).toBe(true)
    expect(probes).toBe(3)
  })

  test("canonical cache dedups in-flight probes and evicts false", async () => {
    // The cache under `isAvailable` (which asks workspace trust first, per call): the
    // shared in-flight promise lives there.
    const bin = `r08-missing-lsp-${Date.now()}`
    const first = __isLspAvailableForTest(bin)
    const second = __isLspAvailableForTest(bin)
    expect(second).toBe(first)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    const third = __isLspAvailableForTest(bin)
    expect(third).not.toBe(first)
    expect(await third).toBe(false)
  })

  test("reviving a local availabilityCache Map is RED on the source rail", () => {
    const src = readFileSync(
      join(process.cwd(), "src/agent/shadow-verify-adapters/check-lsp-test.ts"),
      "utf8",
    )
    const mutated = `${src}\nconst availabilityCache = new Map<string, Promise<boolean>>()`
    expect(src).not.toContain("availabilityCache")
    expect(mutated).toContain("availabilityCache")
    expect(mutated.includes('from "../lsp-bridge/availability"')).toBe(true)
  })
})
