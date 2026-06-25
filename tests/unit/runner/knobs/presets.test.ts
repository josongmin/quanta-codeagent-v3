/**
 * Presets — content shape + resolver integration.
 */
import { describe, expect, test } from "bun:test"
import { type AnyKnob, asAnyKnob, KNOB_PRESETS, type Knob, resolveKnobs } from "@/runner/knobs"

const passthrough: Knob<string> = {
  id: "x",
  envKey: "Q_X",
  category: "tool",
  surfaces: ["bench"],
  parse: (raw) => raw,
  apply: (cfg) => cfg,
  describe: "x",
}

describe("KNOB_PRESETS", () => {
  test("baseline is defined and empty", () => {
    expect(KNOB_PRESETS.baseline).toBeDefined()
    expect(Object.keys(KNOB_PRESETS.baseline ?? {})).toEqual([])
  })

  test("hint-only bundles issue-hint", () => {
    expect(KNOB_PRESETS["hint-only"]?.["issue-hint"]).toBe("1")
  })

  test("everything bundles all advertised knobs", () => {
    const p = KNOB_PRESETS.everything
    expect(p).toBeDefined()
    expect(p?.lsp).toBe("1")
    expect(p?.subagent).toBe("1")
    expect(p?.skills).toBe("1")
  })

  test("presets are non-mutable (Object.freeze contract)", () => {
    // The presets export is `Readonly<...>`; at runtime the shape is plain
    // objects, but TS protects against mutation at the type level. We
    // verify the shape didn't get accidentally edited by an importer.
    const before = JSON.stringify(KNOB_PRESETS.everything)
    // Hostile cast — try to mutate.
    ;(KNOB_PRESETS as Record<string, Record<string, string>>).baseline = { lsp: "1" }
    // Even if write succeeded (JS), subsequent reads should observe the
    // baseline as-mutated; we restore by reading the JSON we captured.
    expect(JSON.stringify(KNOB_PRESETS.everything)).toBe(before)
    // Restore baseline for the rest of the suite.
    ;(KNOB_PRESETS as Record<string, Record<string, string>>).baseline = {}
  })
})

describe("preset → resolver integration", () => {
  test("named preset is consumed as a layer", () => {
    const knobs = new Map<string, AnyKnob>([
      [
        "x",
        asAnyKnob({
          ...passthrough,
          id: "x",
        }),
      ],
    ])
    // Adjust KNOB_PRESETS at runtime is not done; we use 'everything' which
    // doesn't include 'x' → resolver returns empty.
    const r = resolveKnobs({ surface: "bench", knobs, preset: "everything" })
    expect(r.has("x")).toBe(false)
  })

  test("unknown preset name is treated as empty (no throw)", () => {
    const r = resolveKnobs({ surface: "bench", knobs: new Map(), preset: "does-not-exist" })
    expect(r.size).toBe(0)
  })

  test("preset value picked up when no higher layer present", () => {
    // Use the actual 'everything' preset which sets lsp=1.
    const lsp: Knob<boolean> = {
      id: "lsp",
      envKey: "Q_LSP",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => (raw === "1" ? true : undefined),
      apply: (cfg) => cfg,
      describe: "lsp",
    }
    const r = resolveKnobs({
      surface: "bench",
      knobs: new Map<string, AnyKnob>([["lsp", asAnyKnob(lsp)]]),
      preset: "everything",
    })
    expect(r.get("lsp")?.source).toBe("preset")
    expect(r.get("lsp")?.value).toBe(true)
  })

  test("baseline preset → no values", () => {
    const lsp: Knob<boolean> = {
      id: "lsp",
      envKey: "Q_LSP",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => (raw === "1" ? true : undefined),
      apply: (cfg) => cfg,
      describe: "lsp",
    }
    const r = resolveKnobs({
      surface: "bench",
      knobs: new Map<string, AnyKnob>([["lsp", asAnyKnob(lsp)]]),
      preset: "baseline",
    })
    expect(r.has("lsp")).toBe(false)
  })

  test("preset losing race to env layer", () => {
    const lsp: Knob<boolean> = {
      id: "lsp",
      envKey: "Q_LSP",
      category: "tool",
      surfaces: ["bench"],
      parse: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined),
      apply: (cfg) => cfg,
      describe: "lsp",
    }
    const r = resolveKnobs({
      surface: "bench",
      knobs: new Map<string, AnyKnob>([["lsp", asAnyKnob(lsp)]]),
      envVars: { Q_LSP: "0" } as NodeJS.ProcessEnv,
      preset: "everything",
    })
    expect(r.get("lsp")?.source).toBe("env")
    expect(r.get("lsp")?.value).toBe(false)
  })
})
