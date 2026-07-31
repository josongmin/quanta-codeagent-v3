/**
 * §9.6 — opusplan-style sticky model preset hellgate.
 *
 * Claude Code's `opusplan` preset uses a deep-reasoning model (Opus) during
 * plan-mode and a fast model (Sonnet) for execution — a NAMED bundle that maps
 * a logical role/phase to a concrete model, applied STICKILY for the run. This
 * is distinct from the per-role override resolver (`role-model-override`, which
 * stores ad-hoc per-role picks) and from sticky-model (which makes the user's
 * ONE chosen model persist): a preset is a curated multi-role recipe selected
 * by name.
 *
 * V1 = a pure, default-OFF preset registry + resolver. Importing it changes no
 * behaviour; nothing resolves a preset until a caller opts in by name.
 *
 * Cases:
 *   MP-01: built-in `opusplan` maps plan-writer→opus, executor→sonnet
 *   MP-02: resolveModelForRole falls back to the preset `default` for an
 *          unmapped role (no throw on a type-erased role string)
 *   MP-03: unknown preset name ⇒ resolvePreset returns undefined (no throw)
 *   MP-04: a sticky resolver remembers the selected preset across calls
 *   MP-05: byte-identity — with NO preset selected, resolveSticky returns the
 *          caller's fallback verbatim (no preset influence)
 *   MP-06: listPresets enumerates the built-ins (discoverability)
 *   MP-07: custom preset registration composes with the built-ins
 */

import { describe, expect, test } from "bun:test"
import {
  BUILTIN_MODEL_PRESETS,
  createStickyPresetResolver,
  listModelPresets,
  type ModelPreset,
  resolveModelForRole,
  resolveModelPreset,
} from "@/llm/model-preset"

describe("§9.6 built-in opusplan preset", () => {
  test("MP-01: opusplan maps plan-writer→opus, executor→sonnet", () => {
    const preset = resolveModelPreset("opusplan")
    expect(preset).toBeDefined()
    expect(resolveModelForRole(preset!, "plan-writer")).toBe("claude-opus-4-8")
    expect(resolveModelForRole(preset!, "executor")).toBe("claude-sonnet-4-6")
  })

  test("MP-02: unmapped role falls back to preset default (no throw)", () => {
    const preset = resolveModelPreset("opusplan")!
    // a role the preset does not name explicitly
    expect(() => resolveModelForRole(preset, "explorer" as never)).not.toThrow()
    expect(resolveModelForRole(preset, "explorer")).toBe(preset.defaultModel)
  })

  test("MP-03: unknown preset ⇒ undefined (no throw)", () => {
    expect(() => resolveModelPreset("does-not-exist")).not.toThrow()
    expect(resolveModelPreset("does-not-exist")).toBeUndefined()
  })

  test("MP-06: listModelPresets enumerates built-ins", () => {
    const names = listModelPresets().map((p) => p.name)
    expect(names).toContain("opusplan")
    expect(BUILTIN_MODEL_PRESETS.some((p) => p.name === "opusplan")).toBe(true)
  })
})

describe("§9.6 sticky preset resolver", () => {
  test("MP-04: remembers the selected preset across calls", () => {
    const r = createStickyPresetResolver()
    expect(r.selected()).toBeUndefined()
    const ok = r.select("opusplan")
    expect(ok.ok).toBe(true)
    expect(r.selected()?.name).toBe("opusplan")
    // resolve uses the sticky preset
    expect(r.resolve("plan-writer", "fallback-model")).toBe("claude-opus-4-8")
    // a second resolve still uses the same sticky preset
    expect(r.resolve("executor", "fallback-model")).toBe("claude-sonnet-4-6")
  })

  test("MP-05: BYTE-IDENTITY — no preset selected ⇒ fallback verbatim", () => {
    const r = createStickyPresetResolver()
    expect(r.resolve("plan-writer", "user-chosen-model")).toBe("user-chosen-model")
    expect(r.resolve("executor", "another-model")).toBe("another-model")
  })

  test("MP-05b: selecting an unknown preset is rejected, sticky stays empty", () => {
    const r = createStickyPresetResolver()
    const res = r.select("bogus")
    expect(res.ok).toBe(false)
    expect(r.selected()).toBeUndefined()
    // still falls back verbatim
    expect(r.resolve("plan-writer", "fb")).toBe("fb")
  })

  test("MP-05c: clear() removes the sticky preset", () => {
    const r = createStickyPresetResolver()
    r.select("opusplan")
    r.clear()
    expect(r.selected()).toBeUndefined()
    expect(r.resolve("plan-writer", "fb")).toBe("fb")
  })
})

describe("§9.6 custom preset registration", () => {
  test("MP-07: custom preset composes with built-ins", () => {
    const custom: ModelPreset = {
      name: "haiku-fast",
      describe: "everything on haiku",
      defaultModel: "claude-haiku-4-5",
      roles: {},
    }
    const r = createStickyPresetResolver([custom])
    expect(r.select("haiku-fast").ok).toBe(true)
    expect(r.resolve("executor", "fb")).toBe("claude-haiku-4-5")
    // built-ins still reachable
    expect(r.select("opusplan").ok).toBe(true)
  })
})
