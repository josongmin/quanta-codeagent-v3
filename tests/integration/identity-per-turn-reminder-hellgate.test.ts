/**
 * ADR-0239 §C hellgate — identity per-turn reminder splice
 * (loop-helpers `shouldSpliceIdentityReminder` + `buildIdentityReminderText`).
 *
 * 11 closed cases pinning:
 *
 *   §C1 architect mode + default knob ⇒ reminder rendered (mode-conditional auto-ON).
 *   §C2 editor mode + default knob ⇒ reminder rendered (mode-conditional auto-ON).
 *   §C3 default mode + default knob ⇒ NO reminder (mode-conditional auto-OFF).
 *   §C4 plan / review / audit + default knob ⇒ NO reminder (already get modeNotice).
 *   §C5 perTurnReminderEnabled=false ⇒ NO reminder for any mode (explicit opt-out).
 *   §C6 perTurnReminderEnabled=true + non-architect/editor mode ⇒ reminder rendered.
 *   §C7 absent identityModeVariant slot ⇒ NO reminder (default-OFF byte-identical).
 *   §C8 reminder text wrapped in <system-reminder>...</system-reminder>.
 *   §C9 reminder body matches the variant's identity lines (multi-line join).
 *   §C10 empty-identity variant ⇒ NO reminder (no useful nudge).
 *   §C11 throwing registry ⇒ NO reminder (defense-in-depth, no crash).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildIdentityReminderText, shouldSpliceIdentityReminder } from "@/agent/loop-helpers"
import type { AgentMode } from "@/agent/prompt"
import { defaultModeVariantRegistry, type SystemPromptVariantRegistry } from "@/agent/system-prompt"

const cfgWith = (block: NonNullable<AgentConfig["identityModeVariant"]> | undefined): AgentConfig =>
  ({
    identityModeVariant: block,
  }) as unknown as AgentConfig

describe("ADR-0239 §C — identity per-turn reminder splice", () => {
  // ── §C1 ── architect + default knob ⇒ reminder ───────────────────────────
  test("C1: architect mode with default knob renders the reminder", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    expect(shouldSpliceIdentityReminder(cfgWith(block), "architect")).toBe(true)
    const text = buildIdentityReminderText(cfgWith(block), "architect")
    expect(text).toBeDefined()
    expect(text).toContain("Architect")
  })

  // ── §C2 ── editor + default knob ⇒ reminder ──────────────────────────────
  test("C2: editor mode with default knob renders the reminder", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    expect(shouldSpliceIdentityReminder(cfgWith(block), "editor")).toBe(true)
    const text = buildIdentityReminderText(cfgWith(block), "editor")
    expect(text).toBeDefined()
    expect(text).toContain("Editor")
  })

  // ── §C3 ── default mode + default knob ⇒ NO reminder ─────────────────────
  test("C3: default mode with default knob does NOT render (auto-OFF)", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    expect(shouldSpliceIdentityReminder(cfgWith(block), "default")).toBe(false)
    const text = buildIdentityReminderText(cfgWith(block), "default")
    expect(text).toBeUndefined()
  })

  // ── §C4 ── plan / review / audit + default knob ⇒ NO reminder ────────────
  test("C4: plan / review / audit with default knob do NOT render (modeNotice owns those)", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    for (const mode of ["plan", "review", "audit"] as const satisfies readonly AgentMode[]) {
      expect(shouldSpliceIdentityReminder(cfgWith(block), mode)).toBe(false)
      expect(buildIdentityReminderText(cfgWith(block), mode)).toBeUndefined()
    }
  })

  // ── §C5 ── explicit false ⇒ NO reminder for any mode ─────────────────────
  test("C5: perTurnReminderEnabled=false suppresses every mode", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
      perTurnReminderEnabled: false,
    }
    for (const mode of [
      "default",
      "plan",
      "review",
      "audit",
      "architect",
      "editor",
    ] as const satisfies readonly AgentMode[]) {
      expect(shouldSpliceIdentityReminder(cfgWith(block), mode)).toBe(false)
      expect(buildIdentityReminderText(cfgWith(block), mode)).toBeUndefined()
    }
  })

  // ── §C6 ── explicit true ⇒ reminder for non-architect/editor too ─────────
  test("C6: perTurnReminderEnabled=true enables every mode (explicit opt-in)", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
      perTurnReminderEnabled: true,
    }
    for (const mode of [
      "default",
      "plan",
      "review",
      "audit",
      "architect",
      "editor",
    ] as const satisfies readonly AgentMode[]) {
      expect(shouldSpliceIdentityReminder(cfgWith(block), mode)).toBe(true)
      const text = buildIdentityReminderText(cfgWith(block), mode)
      expect(text).toBeDefined()
      expect(text!.startsWith("<system-reminder>")).toBe(true)
    }
  })

  // ── §C7 ── absent slot ⇒ NO reminder (default-OFF byte-identical) ────────
  test("C7: absent identityModeVariant slot ⇒ no reminder, no allocation", () => {
    const cfg = cfgWith(undefined)
    expect(shouldSpliceIdentityReminder(cfg, "architect")).toBe(false)
    expect(buildIdentityReminderText(cfg, "architect")).toBeUndefined()
    expect(shouldSpliceIdentityReminder(cfg, "editor")).toBe(false)
    expect(buildIdentityReminderText(cfg, "editor")).toBeUndefined()
  })

  // ── §C8 ── reminder is wrapped in <system-reminder>...</system-reminder> ─
  test("C8: reminder text wrapped in <system-reminder> markers", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    const text = buildIdentityReminderText(cfgWith(block), "architect")
    expect(text!.startsWith("<system-reminder>\n")).toBe(true)
    expect(text!.endsWith("\n</system-reminder>")).toBe(true)
  })

  // ── §C9 ── reminder body matches the variant's identity lines ────────────
  test("C9: reminder body is the variant's identity lines joined by newline", () => {
    // Custom registry with a multi-line identity to pin join semantics.
    const customRegistry: SystemPromptVariantRegistry = {
      variantFor(mode) {
        return {
          mode: mode as never,
          identity: ["line A", "line B", "line C"],
        } as never
      },
    }
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: customRegistry,
      perTurnReminderEnabled: true,
    }
    const text = buildIdentityReminderText(cfgWith(block), "default")
    expect(text).toBe("<system-reminder>\nline A\nline B\nline C\n</system-reminder>")
  })

  // ── §C10 ── empty-identity variant ⇒ NO reminder ─────────────────────────
  test("C10: a variant with empty identity lines yields NO reminder", () => {
    const emptyRegistry: SystemPromptVariantRegistry = {
      variantFor(mode) {
        return { mode: mode as never, identity: [] as readonly string[] } as never
      },
    }
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: emptyRegistry,
      perTurnReminderEnabled: true,
    }
    // shouldSpliceIdentityReminder is true (knob says yes), but text builder
    // returns undefined because the variant carries no useful line.
    expect(shouldSpliceIdentityReminder(cfgWith(block), "architect")).toBe(true)
    expect(buildIdentityReminderText(cfgWith(block), "architect")).toBeUndefined()
  })

  // ── §C11 ── throwing registry ⇒ NO reminder, NO crash ────────────────────
  test("C11: a throwing registry.variantFor surfaces as no reminder (defense-in-depth)", () => {
    const throwingRegistry: SystemPromptVariantRegistry = {
      variantFor() {
        throw new Error("registry bug")
      },
    }
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: throwingRegistry,
      perTurnReminderEnabled: true,
    }
    expect(() => buildIdentityReminderText(cfgWith(block), "architect")).not.toThrow()
    expect(buildIdentityReminderText(cfgWith(block), "architect")).toBeUndefined()
  })
})
