/**
 * System-prompt mode-variant hellgate (ADR-0211).
 *
 * Adversarial battery locking the mode-variant slice contract. 12 cases
 * cover the registry, the builder helper, the variant table, and the
 * OFF-parity invariant.
 *
 * Wire order:
 *   HELL-MV-01..06 — registry returns the correct variant for each of 6 modes
 *   HELL-MV-07     — unknown mode resolves to the typed UNKNOWN_MODE_VARIANT
 *                    (no crash, no silent default)
 *   HELL-MV-08     — overrides table validates lines (throws on \n / \r / empty)
 *   HELL-MV-09     — defensive copy on get (caller mutation cannot poison)
 *   HELL-MV-10     — OFF parity: building WITHOUT a variant is byte-identical
 *                    to the legacy `buildSystemPrompt()` (ADR-0198 contract)
 *   HELL-MV-11     — variant lines actually appear in the built prompt
 *   HELL-MV-12     — every variant line is unique (no copy-paste collision)
 */
import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"
import {
  buildSystemPromptForMode,
  DEFAULT_MODE_VARIANTS,
  defaultModeVariantRegistry,
  MODE_VARIANT_KEYS,
  type ModeVariantKey,
  ModeVariantLineError,
} from "@/agent/system-prompt"

describe("system-prompt mode-variant hellgate (ADR-0211)", () => {
  test("HELL-MV-01..06 — registry returns the correct variant for each of 6 modes", () => {
    const r = defaultModeVariantRegistry()
    // Per-mode posture word that MUST appear in the variant body (sanity
    // that the table is not shuffled). "default" is the legacy
    // assume-and-execute posture and intentionally does NOT mention the
    // string "default" — its anchor is "pragmatic". Each entry asserts
    // the mode-specific anchor word(s).
    const POSTURE_ANCHOR: Record<string, readonly string[]> = {
      default: ["pragmatic"],
      plan: ["plan mode"],
      review: ["review mode"],
      audit: ["audit mode"],
      architect: ["architect mode"],
      editor: ["editor mode"],
    }
    for (const mode of MODE_VARIANT_KEYS) {
      const v = r.variantFor(mode)
      expect(v.mode).toBe(mode)
      expect(v.identity.length).toBeGreaterThanOrEqual(1)
      const joined = v.identity.join(" ").toLowerCase()
      const anchors = POSTURE_ANCHOR[mode] ?? []
      const matched = anchors.some((a) => joined.includes(a))
      expect(matched).toBe(true)
    }
  })

  test("HELL-MV-07 — unknown mode resolves to the typed UNKNOWN_MODE_VARIANT (no throw)", () => {
    const r = defaultModeVariantRegistry()
    // Cast through unknown — the test simulates a stale enum extension at
    // runtime; the registry must NOT crash the prompt path.
    const v = r.variantFor("debug" as unknown as ModeVariantKey)
    expect(v.identity.length).toBeGreaterThanOrEqual(1)
    expect(v.identity[0]).toContain("unknown-mode")
  })

  test("HELL-MV-08 — override validation throws on empty / LF / CR lines", () => {
    expect(() => defaultModeVariantRegistry({ plan: ["valid line", ""] })).toThrow(
      ModeVariantLineError,
    )
    expect(() => defaultModeVariantRegistry({ plan: ["line with \n inside"] })).toThrow(
      ModeVariantLineError,
    )
    expect(() => defaultModeVariantRegistry({ plan: ["line with \r inside"] })).toThrow(
      ModeVariantLineError,
    )
  })

  test("HELL-MV-09 — defensive copy on get (caller mutation does not poison)", () => {
    const r = defaultModeVariantRegistry()
    const v1 = r.variantFor("default")
    ;(v1.identity as string[]).push("INJECTED MUTATION")
    const v2 = r.variantFor("default")
    expect(v2.identity).not.toContain("INJECTED MUTATION")
  })

  test("HELL-MV-10 — OFF parity: buildSystemPrompt() WITHOUT identity is byte-identical", () => {
    // The legacy path (no opts at all) and the legacy path with explicit
    // `identity: []` must produce byte-identical output (ADR-0198
    // contract). The mode-variant slice is ADDITIVE — it does NOT change
    // the legacy default.
    const legacy = buildSystemPrompt()
    const explicitEmpty = buildSystemPrompt(undefined, { identity: [] })
    expect(explicitEmpty).toBe(legacy)
  })

  test("HELL-MV-11 — variant lines actually appear in the built prompt", () => {
    for (const mode of MODE_VARIANT_KEYS) {
      const prompt = buildSystemPromptForMode({ mode })
      const variantLine = DEFAULT_MODE_VARIANTS[mode][0]
      expect(variantLine).toBeDefined()
      if (variantLine !== undefined) {
        expect(prompt.includes(variantLine)).toBe(true)
      }
    }
  })

  test("HELL-MV-12 — every variant identity body is unique across modes", () => {
    // No two modes may share the same identity body — a copy-paste error
    // would silently make two modes indistinguishable to the model. This
    // cross-check fails loudly on drift.
    const seen = new Map<string, ModeVariantKey>()
    for (const mode of MODE_VARIANT_KEYS) {
      const body = DEFAULT_MODE_VARIANTS[mode].join("\n")
      const prior = seen.get(body)
      if (prior !== undefined) {
        throw new Error(
          `Variant collision: mode "${mode}" has identical identity to mode "${prior}".`,
        )
      }
      seen.set(body, mode)
    }
    expect(seen.size).toBe(MODE_VARIANT_KEYS.length)
  })

  test("HELL-MV-13 — override threads through to the built prompt", () => {
    const registry = defaultModeVariantRegistry({
      plan: ["CUSTOM PLAN IDENTITY for hellgate testing."],
    })
    const prompt = buildSystemPromptForMode({ mode: "plan", registry })
    expect(prompt.includes("CUSTOM PLAN IDENTITY for hellgate testing.")).toBe(true)
    // Non-overridden modes still get the default body.
    const reviewPrompt = buildSystemPromptForMode({ mode: "review", registry })
    const reviewFirstLine = DEFAULT_MODE_VARIANTS.review[0] ?? ""
    expect(reviewFirstLine.length).toBeGreaterThan(0)
    expect(reviewPrompt.includes(reviewFirstLine)).toBe(true)
  })

  test("HELL-MV-14 — architect + editor variants exist and differ in posture wording", () => {
    // ADR-0211 explicitly extends the variant table with architect (deep
    // reasoning, read-only) and editor (minimal diffs, mutating). The
    // wording MUST surface their distinctive posture or the prompt is
    // useless to the model.
    const r = defaultModeVariantRegistry()
    const architect = r.variantFor("architect").identity.join(" ").toLowerCase()
    const editor = r.variantFor("editor").identity.join(" ").toLowerCase()
    expect(architect.includes("design")).toBe(true)
    expect(editor.includes("minimal") || editor.includes("surgical")).toBe(true)
    // Mutually-exclusive posture words: editor must NOT carry the
    // "defer edits" architect language.
    expect(editor.includes("defer edits")).toBe(false)
  })
})
