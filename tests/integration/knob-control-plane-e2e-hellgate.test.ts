/**
 * KNOB CONTROL-PLANE e2e HELLGATE (ADR-0503 P4 R5).
 *
 * Drives the REAL `/knobs set|reset` slash command end-to-end and proves a live
 * `/knobs set <envKey>=<val>` flows through the ONE `@/shared/knob-overrides`
 * store into BOTH read accessors this session, with no restart:
 *   - channel A: `runtimeConfig()`  (the ~145 typed runtime-config knobs)
 *   - channel B: `readCliKnob()`     (CLI knobs)
 * plus `/knobs reset` reverts, the security carve-out HOLDS (strict knobs can't
 * be session-enabled), and byte-identity is preserved when nothing is set.
 *
 * This is the closeout lock for the live-control plane — if any wire breaks
 * (store split, cache not invalidated, carve-out bypassed) it fails RED.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "../../src/apps/cli/knobs-bootstrap" // populate @/runner registry (for the wire)
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import { __resetCliKnobOverrides, readCliKnob } from "../../src/apps/cli/cli-knobs-accessor"
import { buildKnobsSlash, type KnobsSurfaceWire } from "../../src/apps/cli/slash-commands-knobs"
import type { SlashContext } from "../../src/apps/cli/slash-contract"

// minimal wire — the catalog-knob path of doSet does NOT use the @/runner wire,
// so a stub resolution/save is enough to build the command.
const stubWire: KnobsSurfaceWire = {
  resolution: () => new Map(),
  setOverride: () => undefined,
  resetOverride: () => undefined,
  sessionOverrides: () => ({}),
  save: async () => {},
  configPath: "/tmp/none.json",
}

const drive = () => {
  let stdout = ""
  let stderr = ""
  const ctx = {
    out: (s: string) => {
      stdout += s
    },
    err: (s: string) => {
      stderr += s
    },
  } as unknown as SlashContext
  const cmd = buildKnobsSlash(stubWire)
  return {
    run: (args: string[]) => cmd.run(args, ctx),
    out: () => stdout,
    err: () => stderr,
  }
}

beforeEach(() => {
  __resetCliKnobOverrides()
  __resetRuntimeConfig()
})
afterEach(() => {
  __resetCliKnobOverrides()
  __resetRuntimeConfig()
})

describe("knob control-plane e2e (ADR-0503 P4 R5 hellgate)", () => {
  test("A: /knobs set a runtime-config knob ⇒ runtimeConfig() reflects it live, reset reverts", async () => {
    const baseline = runtimeConfig().logLevel
    expect(baseline).not.toBe("error")
    const h = drive()
    expect(await h.run(["set", "QUANTA_LOG_LEVEL=error"])).toBe(0)
    // channel A: the typed runtime config sees it WITHOUT a restart
    expect(runtimeConfig().logLevel).toBe("error")
    expect(await h.run(["reset", "QUANTA_LOG_LEVEL"])).toBe(0)
    expect(runtimeConfig().logLevel).toBe(baseline)
  })

  test("B: /knobs set a CLI knob ⇒ readCliKnob() reflects it live, reset reverts", async () => {
    expect(readCliKnob("QUANTA_LSP", "bool", {})).toBe(false) // registry default
    const h = drive()
    expect(await h.run(["set", "QUANTA_LSP=on"])).toBe(0)
    expect(readCliKnob("QUANTA_LSP", "bool", {})).toBe(true)
    expect(await h.run(["reset", "QUANTA_LSP"])).toBe(0)
    expect(readCliKnob("QUANTA_LSP", "bool", {})).toBe(false)
  })

  test("C: ONE store feeds BOTH channels (a runtime-config bool reflects in runtimeConfig)", async () => {
    expect(runtimeConfig().bgCompaction).toBe(false)
    const h = drive()
    expect(await h.run(["set", "QUANTA_BG_COMPACTION=1"])).toBe(0)
    expect(runtimeConfig().bgCompaction).toBe(true)
  })

  test("D: SECURITY carve-out — /knobs set CANNOT enable a strict knob (refused + config unchanged)", async () => {
    expect(runtimeConfig().codeMode).toBe(false)
    const h = drive()
    const exit = await h.run(["set", "QUANTA_CODE_MODE=1"])
    expect(exit).toBe(1)
    expect(h.err()).toContain("security-boundary")
    // the override never landed → strict gate stays OFF in the typed config
    expect(runtimeConfig().codeMode).toBe(false)
  })

  test("E: byte-identity — with NO overrides runtimeConfig() is the cached frozen object", () => {
    const a = runtimeConfig()
    expect(runtimeConfig()).toBe(a) // same instance, no rebuild churn
  })

  test("F: invalid numeric is REJECTED at set (no silent garbage in the live plane)", async () => {
    const h = drive()
    expect(await h.run(["set", "QUANTA_FLASH_ERROR_MS=garbage"])).toBe(1)
    expect(h.err()).toContain("expects int")
  })
})
