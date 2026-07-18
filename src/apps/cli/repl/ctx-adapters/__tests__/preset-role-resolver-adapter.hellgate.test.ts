/**
 * Hellgate — preset → role-model resolver adapter (§9.6 opusplan ACTIVATION).
 *
 * This adapter is the load-bearing wire that makes a `/presets` pick actually
 * change which model a delegated role runs: it bridges the live
 * `StickyPresetResolver` (`ctx.presets`, mutated by the slash) onto the
 * `AgentConfig.roleModelResolver` port the loop consumes (`resolveChildLlm`).
 *
 * Each case is a distinct, mutation-meaningful invariant:
 *   - Default-OFF byte-identity: with NO preset selected, `resolve` returns the
 *     caller `default` VERBATIM (the loop is untouched until a preset is picked).
 *   - The SHARED instance: selecting on the preset resolver the adapter wraps is
 *     observed by the adapter's `resolve` (single instance, no split-brain).
 *   - Sticky binding wins over the caller default (the core activation proof).
 *   - Unmapped role falls to the preset default, NOT the caller default.
 *   - clear() reverts to caller-default-verbatim.
 *   - Explicit override layers ABOVE the preset (documented precedence).
 *   - NO-THROW / no silent poison: empty override modelId is a TYPED reject.
 */
import { describe, expect, test } from "bun:test"
import { createStickyPresetResolver } from "@/llm"
import { buildPresetRoleModelResolver } from "../preset-role-resolver-adapter"

describe("preset role-model adapter — Default-OFF byte-identity", () => {
  test("no preset selected ⇒ resolve returns the caller default VERBATIM", () => {
    const presets = createStickyPresetResolver()
    const r = buildPresetRoleModelResolver(presets)
    // Every role falls straight through — byte-identical to no resolver at all.
    expect(r.resolve("plan-writer", "boot-model")).toBe("boot-model")
    expect(r.resolve("executor", "boot-model")).toBe("boot-model")
    expect(r.resolve("default", "boot-model")).toBe("boot-model")
    expect(r.listOverrides()).toEqual({})
  })
})

describe("preset role-model adapter — shared instance activation (sticky)", () => {
  test("selecting on the wrapped resolver changes resolve; binding beats caller default", () => {
    const presets = createStickyPresetResolver()
    const r = buildPresetRoleModelResolver(presets)

    // ── RED-ON-INJECTION ANCHOR ─────────────────────────────────────────────
    // These pass ONLY because the adapter delegates to the SAME `presets`
    // instance. If `resolve` stopped consulting `presets.resolve` (e.g. returned
    // `defaultModel` directly), the sticky assertions below flip RED.
    expect(presets.select("opusplan").ok).toBe(true)
    // Sticky: the preset binding WINS over the caller fallback (fallback ignored).
    expect(r.resolve("plan-writer", "boot-model")).toBe("claude-opus-4-8")
    expect(r.resolve("reviewer", "boot-model")).toBe("claude-opus-4-8")
    expect(r.resolve("executor", "boot-model")).toBe("claude-sonnet-4-6")
    // An UNMAPPED role falls to the preset's OWN default, never the caller default.
    expect(r.resolve("default", "boot-model")).toBe("claude-sonnet-4-6")
  })

  test("clear() reverts role resolution to caller-default-verbatim", () => {
    const presets = createStickyPresetResolver()
    const r = buildPresetRoleModelResolver(presets)
    presets.select("opusplan")
    expect(r.resolve("plan-writer", "boot-model")).toBe("claude-opus-4-8")
    presets.clear()
    expect(r.resolve("plan-writer", "boot-model")).toBe("boot-model")
  })
})

describe("preset role-model adapter — explicit override layering", () => {
  test("an explicit role override beats the selected preset binding", () => {
    const presets = createStickyPresetResolver()
    const r = buildPresetRoleModelResolver(presets)
    presets.select("opusplan")
    // Preset binds plan-writer → opus; an explicit override must win (ADR-0256
    // precedence: sub-task autonomy beats workflow phase).
    expect(r.setOverride("plan-writer", "claude-haiku-4-5").ok).toBe(true)
    expect(r.resolve("plan-writer", "boot-model")).toBe("claude-haiku-4-5")
    // A role WITHOUT an override still resolves via the preset.
    expect(r.resolve("executor", "boot-model")).toBe("claude-sonnet-4-6")
    expect(r.listOverrides()).toEqual({ "plan-writer": "claude-haiku-4-5" })
    // clearOverride reverts to the preset binding.
    r.clearOverride("plan-writer")
    expect(r.resolve("plan-writer", "boot-model")).toBe("claude-opus-4-8")
  })
})

describe("preset role-model adapter — NO-THROW / no silent poison", () => {
  test("empty override modelId ⇒ TYPED reject, no poison, resolve unaffected", () => {
    const presets = createStickyPresetResolver()
    const r = buildPresetRoleModelResolver(presets)
    const res = r.setOverride("executor", "")
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected reject")
    expect(res.error.code).toBe("empty-model")
    // The empty value was NOT stored — resolve still returns the caller default.
    expect(r.resolve("executor", "boot-model")).toBe("boot-model")
    expect(r.listOverrides()).toEqual({})
  })

  test("unknown (type-erased) role string falls through — never throws", () => {
    const presets = createStickyPresetResolver()
    const r = buildPresetRoleModelResolver(presets)
    presets.select("opusplan")
    // A role not in the closed union arrives from a type-erased boundary.
    expect(r.resolve("totally-unknown-role" as never, "boot-model")).toBe("claude-sonnet-4-6")
  })
})
