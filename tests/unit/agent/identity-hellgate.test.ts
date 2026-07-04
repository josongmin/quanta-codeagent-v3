/**
 * Identity mode-variant (ADR-0198) — hellgate battery.
 *
 * 10 adversarial cases sealing the per-mode identity slot's invariants:
 *   1. Byte-identical default path (no identity ⇒ legacy prompt unchanged).
 *   2. 5-mode default-table snapshot lock (no cross-mode leak).
 *   3. opts.identity override ignores the default table.
 *   4. Empty-array identity is identical to absent identity.
 *   5. Splice position: identity precedes persona, both precede policy stack.
 *   6. Unknown mode value ⇒ typed `unknown-mode` (no throw, no default fallback).
 *   7. Newline injection in an identity line ⇒ construction-time rejection.
 *   8. Override map merges shallowly — only the supplied mode is replaced.
 *   9. Each default identity is 1..=3 non-empty lines.
 *  10. defaultIdentityProvider returns a pure function (no IO / no mutation
 *      across repeated calls).
 */

import { describe, expect, test } from "bun:test"
import {
  defaultIdentityProvider,
  IDENTITY_MODES,
  IdentityLineError,
  identityForToken,
  isIdentityMode,
  type IdentityMode,
  type IdentityProvider,
} from "@/agent/identity"
import { buildSystemPrompt } from "@/agent/prompt"

describe("ADR-0198 identity mode-variant — HELLGATE", () => {
  test("HELL-ID-01: identity absent ⇒ buildSystemPrompt byte-identical to legacy", () => {
    const legacy = buildSystemPrompt()
    const withoutIdentity = buildSystemPrompt(undefined, {})
    expect(withoutIdentity).toBe(legacy)
  })

  test("HELL-ID-02: each default identity locked; no other mode's line leaks", () => {
    const provider = defaultIdentityProvider()
    const seen = new Map<IdentityMode, readonly string[]>()
    for (const mode of IDENTITY_MODES) {
      const lines = provider.identityFor(mode)
      expect(Array.isArray(lines)).toBe(true)
      expect(lines.length).toBeGreaterThan(0)
      seen.set(mode, lines)
    }
    // Cross-mode leak check: every line text appears in EXACTLY one mode.
    const allLines = [...seen.entries()].flatMap(([m, ls]) => ls.map((l) => ({ mode: m, line: l })))
    for (const { mode, line } of allLines) {
      const owners = allLines.filter((x) => x.line === line).map((x) => x.mode)
      const unique = [...new Set(owners)]
      expect(unique).toEqual([mode])
    }
    // Snapshot lock — each default identity body must contain the mode token.
    expect(seen.get("default")?.[0]).toContain("Quanta")
    expect(seen.get("plan")?.[0]).toContain("plan mode")
    expect(seen.get("review")?.[0]).toContain("review mode")
    expect(seen.get("audit")?.[0]).toContain("audit mode")
    expect(seen.get("onboarding")?.[0]).toContain("new user")
  })

  test("HELL-ID-03: opts.identity override ignores the default table", () => {
    const override = ["You are NOT-QUANTA, an override identity.", "Second line override."]
    const legacy = buildSystemPrompt()
    const out = buildSystemPrompt(undefined, { identity: override })
    expect(out).toContain("You are NOT-QUANTA, an override identity.")
    expect(out).toContain("Second line override.")
    expect(out).not.toBe(legacy)
    // None of the default-table identity tokens leak when an override is set
    // (override path is fully authoritative, not "merge-on-top").
    const provider = defaultIdentityProvider()
    expect(out).not.toContain(provider.identityFor("plan")[0] ?? "__never__")
  })

  test("HELL-ID-04: empty-array identity ⇒ byte-identical to absent identity", () => {
    const legacy = buildSystemPrompt()
    const withEmpty = buildSystemPrompt(undefined, { identity: [] })
    expect(withEmpty).toBe(legacy)
  })

  test("HELL-ID-05: splice position — identity precedes persona, both precede Policy stack", () => {
    const identityLine = "IDENTITY_SENTINEL_LINE_X42"
    const out = buildSystemPrompt(undefined, {
      identity: [identityLine],
      persona: "pragmatic",
    })
    const idxIdentity = out.indexOf(identityLine)
    const idxPersona = out.indexOf("Persona: deeply pragmatic")
    const idxPolicy = out.indexOf("Policy stack")
    expect(idxIdentity).toBeGreaterThan(-1)
    expect(idxPersona).toBeGreaterThan(-1)
    expect(idxPolicy).toBeGreaterThan(-1)
    expect(idxIdentity).toBeLessThan(idxPersona)
    expect(idxPersona).toBeLessThan(idxPolicy)
    // Identity rides AFTER the INTRO opening lines.
    const idxIntro = out.indexOf("You are Quanta, an autonomous coding agent")
    expect(idxIntro).toBeGreaterThan(-1)
    expect(idxIntro).toBeLessThan(idxIdentity)
  })

  test("HELL-ID-06: unknown mode ⇒ typed unknown-mode line, no throw", () => {
    const provider = defaultIdentityProvider()
    // Cast unknown string to IdentityMode to simulate stale-mode drift from
    // a future mode flag the table forgot to update.
    const lines = provider.identityFor("debug" as unknown as IdentityMode)
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]?.toLowerCase()).toContain("unknown-mode")
  })

  test("HELL-ID-07: identity line with embedded newline ⇒ rejected at build time", () => {
    expect(() =>
      buildSystemPrompt(undefined, { identity: ["legit line", "with\nembedded newline"] }),
    ).toThrow(IdentityLineError)
    // Lone-CR also rejected (CRLF and CR are equally dangerous for splice).
    expect(() => buildSystemPrompt(undefined, { identity: ["bad\rline"] })).toThrow(
      IdentityLineError,
    )
    // Empty-string entry rejected (would emit a blank splice that visually
    // collides with the persona/Policy separator).
    expect(() => buildSystemPrompt(undefined, { identity: ["ok", ""] })).toThrow(IdentityLineError)
  })

  test("HELL-ID-08: override map merges shallowly — only supplied mode replaced", () => {
    const baseProvider = defaultIdentityProvider()
    const planOverride = ["You are Quanta, plan-mode OVERRIDDEN."]
    const provider = defaultIdentityProvider({ plan: planOverride })
    expect(provider.identityFor("plan")).toEqual(planOverride)
    for (const mode of IDENTITY_MODES) {
      if (mode === "plan") continue
      expect(provider.identityFor(mode)).toEqual(baseProvider.identityFor(mode))
    }
  })

  test("HELL-ID-09: each default identity is 1..=3 non-empty lines", () => {
    const provider = defaultIdentityProvider()
    for (const mode of IDENTITY_MODES) {
      const lines = provider.identityFor(mode)
      expect(lines.length).toBeGreaterThanOrEqual(1)
      expect(lines.length).toBeLessThanOrEqual(3)
      for (const line of lines) {
        expect(typeof line).toBe("string")
        expect(line.trim().length).toBeGreaterThan(0)
        expect(line).not.toContain("\n")
        expect(line).not.toContain("\r")
      }
    }
  })

  test("HELL-ID-10: identityFor is pure — repeated calls return equal arrays, no mutation", () => {
    const provider: IdentityProvider = defaultIdentityProvider()
    for (const mode of IDENTITY_MODES) {
      const a = provider.identityFor(mode)
      const b = provider.identityFor(mode)
      expect(a).toEqual(b)
      // Mutate the returned array (or attempt to) — second call MUST still
      // return the original content.
      const mutable = [...a]
      mutable.push("SENTINEL_MUTATE")
      const c = provider.identityFor(mode)
      expect(c).toEqual(a)
      expect(c).not.toContain("SENTINEL_MUTATE")
    }
  })

  test("HELL-ID-11: isIdentityMode mirrors the SSOT token table", () => {
    for (const mode of IDENTITY_MODES) {
      expect(isIdentityMode(mode)).toBe(true)
    }
    expect(isIdentityMode("onboarding-XYZ")).toBe(false)
    expect(isIdentityMode(42)).toBe(false)
  })

  test("HELL-ID-12: identityForToken preserves unknown-mode fallback without external casts", () => {
    const provider = defaultIdentityProvider()
    expect(identityForToken("plan", provider)).toEqual(provider.identityFor("plan"))
    const unknown = identityForToken("debug", provider)
    expect(unknown.length).toBeGreaterThan(0)
    expect(unknown[0]?.toLowerCase()).toContain("unknown-mode")
  })
})
