import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CLOSEOUT_REMINDER,
  createCloseoutGuardState,
  decideCloseoutGuard,
} from "@/agent/closeout-guard"

describe("decideCloseoutGuard", () => {
  test("(1) cfg undefined ⇒ no block, trips stays 0", () => {
    const state = createCloseoutGuardState()
    expect(decideCloseoutGuard({ state, cfg: undefined })).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("(2a) cfg.enabled === false ⇒ no block, trips stays 0", () => {
    const state = createCloseoutGuardState()
    expect(decideCloseoutGuard({ state, cfg: { enabled: false } })).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("(2b) cfg.enabled undefined ⇒ no block, trips stays 0", () => {
    const state = createCloseoutGuardState()
    expect(decideCloseoutGuard({ state, cfg: {} })).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("(3) cfg.enabled true, trips === 0 ⇒ blocks with reminder text, trips becomes 1", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true } })
    expect(r).toEqual({ block: true, text: CLOSEOUT_REMINDER })
    expect(r.text).toBe(CLOSEOUT_REMINDER)
    expect(state.trips).toBe(1)
  })

  test("(4) cfg.enabled true, trips === 1 (post-first-trip) ⇒ no block (single-shot cap)", () => {
    const state = createCloseoutGuardState()
    // First call trips.
    const first = decideCloseoutGuard({ state, cfg: { enabled: true } })
    expect(first).toEqual({ block: true, text: CLOSEOUT_REMINDER })
    expect(state.trips).toBe(1)
    // Second call: cap reached ⇒ no block, trips stays 1.
    const second = decideCloseoutGuard({ state, cfg: { enabled: true } })
    expect(second).toEqual({ block: false })
    expect(state.trips).toBe(1)
  })

  test("(4b) third+ calls also stay capped (single-shot is permanent for the run)", () => {
    const state = createCloseoutGuardState()
    decideCloseoutGuard({ state, cfg: { enabled: true } })
    decideCloseoutGuard({ state, cfg: { enabled: true } })
    const third = decideCloseoutGuard({ state, cfg: { enabled: true } })
    expect(third).toEqual({ block: false })
    expect(state.trips).toBe(1)
  })

  test("(5) CLOSEOUT_REMINDER contains all four CloseoutLens directives", () => {
    expect(CLOSEOUT_REMINDER).toContain("defended claims")
    expect(CLOSEOUT_REMINDER).toContain("verification")
    expect(CLOSEOUT_REMINDER).toContain("fact from inference")
    expect(CLOSEOUT_REMINDER).toContain("reporting shape")
  })
})

describe("closeout-guard module purity", () => {
  // Pure-module guarantees: no I/O, no clocks, no randomness, no cross-module
  // coupling beyond (at most) the sibling `./types`. Asserted by inspecting the
  // module source rather than runtime so the contract holds in CI without
  // sandbox tricks.
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "src", "agent", "closeout-guard.ts"),
    "utf8",
  )

  test("imports nothing from node:* or @/*", () => {
    // The module currently has no imports at all. If a future edit adds one, it
    // must be from `./types` ONLY — anything else fails this assertion.
    const importLines = source
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /^\s*export\s+.*\bfrom\b/.test(l))
    for (const line of importLines) {
      expect(line).not.toMatch(/from\s+["']node:/)
      expect(line).not.toMatch(/from\s+["']@\//)
      // Only `./types` is permitted as an internal import.
      const fromMatch = line.match(/from\s+["']([^"']+)["']/)
      if (fromMatch?.[1]) {
        expect(fromMatch[1]).toBe("./types")
      }
    }
  })

  test("contains no Bun.spawn / Date / Math.random / fetch", () => {
    expect(source).not.toMatch(/\bBun\.spawn\b/)
    expect(source).not.toMatch(/\bnew\s+Date\b/)
    expect(source).not.toMatch(/\bDate\.now\b/)
    expect(source).not.toMatch(/\bMath\.random\b/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
  })
})
