/**
 * HELLGATE — default-OFF byte-identity for the central-config slice
 * (ADR-0497, jun-7-misc 05). When `QUANTA_CENTRAL_CONFIG` is unset:
 *   - `runtimeConfig().centralConfig` is false
 *   - the new optional disk knobs (`centralConfigDir`, `centralConfigSources`,
 *     `trustedPaths`) are undefined
 *   - the existing env-parse is unchanged (the new fields only ADD)
 *   - the loader, if (incorrectly) invoked, is the ONLY read path — but it must
 *     never be invoked when OFF: we assert the loader performs ZERO `read`
 *     calls when handed a no-source discovery (proving the read is fully
 *     gated by the host's source/path selection, not an unconditional scan).
 *
 * Red-on-injection: if the knob's strict gate is loosened, or the new fields
 * leak a default value, or the loader reads when it shouldn't, this fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type LayerPaths, type ReadTextPort, readLayers, resolveDiskConfig } from "@/config"
import { parseSettingSources } from "@/config"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

const KNOBS = [
  "QUANTA_CENTRAL_CONFIG",
  "QUANTA_CONFIG_DIR",
  "QUANTA_SETTING_SOURCES",
  "QUANTA_TRUSTED_PATHS",
] as const

const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of KNOBS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  __resetRuntimeConfig()
})
afterEach(() => {
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

describe("runtime-config default-OFF", () => {
  test("centralConfig false + new disk knobs undefined when unset", () => {
    const rc = runtimeConfig()
    expect(rc.centralConfig).toBe(false)
    expect(rc.centralConfigDir).toBeUndefined()
    expect(rc.centralConfigSources).toBeUndefined()
    expect(rc.trustedPaths).toBeUndefined()
  })

  test("strict gate — a loose truthy spelling does NOT arm centralConfig", () => {
    for (const v of ["on", "true", "yes", " 1 ", "0", "false"]) {
      process.env.QUANTA_CENTRAL_CONFIG = v
      __resetRuntimeConfig()
      // RED-ON-INJECTION: only `=== "1"` arms this RCE-adjacent gate.
      expect(runtimeConfig().centralConfig).toBe(false)
    }
    process.env.QUANTA_CENTRAL_CONFIG = "1"
    __resetRuntimeConfig()
    expect(runtimeConfig().centralConfig).toBe(true)
  })

  test("disk knobs are INERT raw carriers — a disk knob can NEVER arm a security gate (round-4 F8)", () => {
    // The header documents `parseX(env.X ?? disk?.x)` consumption, but the disk
    // values are carried RAW (`stringOrUndef`) and consumed by NO gate today.
    // This is the forward-guard the host-wiring lane must not regress: setting a
    // disk knob to the strict-gate magic value `"1"` must NOT flip the master
    // `centralConfig` gate (or any gate). A disk value crossing into a
    // `gateOnStrict` field would be a fail-OPEN — the disk source must stay
    // inert metadata until the host explicitly resolves + trust-gates it.
    for (const k of KNOBS) delete process.env[k]
    process.env.QUANTA_CONFIG_DIR = "1"
    process.env.QUANTA_SETTING_SOURCES = "1"
    process.env.QUANTA_TRUSTED_PATHS = "1"
    __resetRuntimeConfig()
    const rc = runtimeConfig()
    // RED-ON-INJECTION: if any disk knob were wired to feed `centralConfig` (or
    // a future `?? disk?.x` accidentally targeted a gate), this would be true.
    expect(rc.centralConfig).toBe(false)
    // The disk fields are carried verbatim, NOT parsed into a bool/gate.
    expect(rc.centralConfigDir).toBe("1")
    expect(rc.centralConfigSources).toBe("1")
    expect(rc.trustedPaths).toBe("1")
  })
})

describe("loader does ZERO reads when no source is discovered", () => {
  test("all-undefined paths ⇒ readLayers makes no read calls", async () => {
    let calls = 0
    const read: ReadTextPort = async () => {
      calls++
      return undefined
    }
    const noPaths: LayerPaths = { managed: undefined, user: undefined, project: undefined, local: undefined }
    const layers = await readLayers(noPaths, read, () => {})
    expect(calls).toBe(0)
    expect(Object.keys(layers).length).toBe(0)
  })

  test("resolveDiskConfig with managed-only source skips project/local reads entirely", async () => {
    const reads: string[] = []
    const read: ReadTextPort = async (p) => {
      reads.push(p)
      return undefined
    }
    await resolveDiskConfig({
      cwd: "/repo",
      userConfigDir: "/home/.quanta",
      managedPath: undefined,
      trusted: false,
      sources: parseSettingSources("managed"),
      read,
      warn: () => {},
    })
    // RED-ON-INJECTION: a repo-relative read sneaking in for an unselected
    // source would show a "/repo/.quanta/..." path here.
    expect(reads.some((p) => p.includes("/repo/"))).toBe(false)
  })
})
