/**
 * SEP5-10 — seven CLI gate/knob overlaps stay derived from one owner.
 * Help, default seed, and /knobs lookup are projections, not a second list.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CLI_FEATURE_GATE_NAMES,
  CLI_FEATURE_GATES,
  CLI_SEEDED_SURFACE_KNOBS,
} from "@/apps/cli/cli-feature-gates"
import { CLI_KNOBS, cliKnob } from "@/apps/cli/cli-knobs"
import { renderHelp } from "@/apps/cli/help-render"
import { BUILTINS } from "@/apps/cli/slash-commands"
import { KNOB_INVENTORY } from "@/config/knob-inventory"
import { setColorPolicy, stripAnsi } from "@/ui/ui-helpers"

beforeEach(() => setColorPolicy("off"))
afterEach(() => setColorPolicy(null))

const envRowCount = (out: string, gate: string): number => {
  const rowKey = new RegExp(`^[│\\s]*${gate}\\s{2,}`)
  return out.split("\n").filter((l) => rowKey.test(l)).length
}

describe("CLI seeded-surface knob projections", () => {
  test("overlap floor is 7", () => {
    expect(CLI_SEEDED_SURFACE_KNOBS.length).toBe(7)
  })

  test("help, seed, and knobs lookup stay derived for every overlap row", () => {
    const help = stripAnsi(renderHelp(BUILTINS))
    for (const row of CLI_SEEDED_SURFACE_KNOBS) {
      expect(CLI_FEATURE_GATE_NAMES).toContain(row.gate)
      expect(
        CLI_FEATURE_GATES.some((g) => g.gate === row.gate && g.describe === row.describe),
      ).toBe(true)
      expect(envRowCount(help, row.gate)).toBe(1)
      const knob = cliKnob(row.gate)
      expect(knob).toBeDefined()
      expect(knob?.kind).toBe(row.kind)
      expect(knob?.default).toBe(row.default)
      expect(knob?.describe).toBe(row.knobDescribe)
      expect(knob?.readSite).toBe(row.readSite)
      expect(CLI_KNOBS.filter((k) => k.envKey === row.gate)).toHaveLength(1)
    }
  })

  test("mutation: drop one SSOT row and the knobs projection vanishes", () => {
    const clone = CLI_SEEDED_SURFACE_KNOBS.filter((r) => r.gate !== "QUANTA_AT_AUTOCOMPLETE")
    expect(clone.length).toBe(6)
    expect(clone.some((r) => r.gate === "QUANTA_AT_AUTOCOMPLETE")).toBe(false)
  })

  test("CLI-seeded gates are not described as NOT seeded", () => {
    for (const gate of CLI_FEATURE_GATES) {
      const entry = KNOB_INVENTORY.find((k) => k.envKey === gate.gate)
      if (entry === undefined) continue
      expect(entry.describe).not.toMatch(/NOT CLI-seeded|NOT seeded/)
    }
    const root = join(import.meta.dir, "../../..")
    const liveWire = readFileSync(
      join(root, "src/apps/cli/repl/spinner-stall-live-wire.ts"),
      "utf8",
    )
    const setup = readFileSync(join(root, "src/apps/cli/repl/session-setup.ts"), "utf8")
    expect(liveWire).not.toMatch(/NEW default-OFF gate/)
    expect(setup).not.toMatch(/NEW default-OFF gate `QUANTA_SPINNER_STALL`/)
  })
})
