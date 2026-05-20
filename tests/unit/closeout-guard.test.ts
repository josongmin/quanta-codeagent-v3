import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CLOSEOUT_4RULE_REMINDER,
  CLOSEOUT_REMINDER,
  CODE_MOD_CLOSEOUT_REMINDER,
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

  // W2 audit fix: (5) was a substring-keyword tautology over the same module's
  // own `CLOSEOUT_REMINDER` constant — passing meant the test author and the
  // implementation author hard-coded the same words. The routing tests
  // `(3)`-`(4b)` already `toBe(CLOSEOUT_REMINDER)` for object-equality, and the
  // e2e at `tests/integration/sota-codex-full.test.ts` checks reminder
  // injection through the loop. The keyword test was deleted as vapor.

  // Phase 2 absorption: 4-rule defended-claim checklist (Codex
  // `response-assembly-and-closeout.md §5.2`). The `fourRule:true` flag swaps
  // the one-liner for the full checklist + VerificationCloseout cue.
  test("(6) cfg.fourRule=true ⇒ blocks with 4-rule checklist instead of one-liner", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: true } })
    expect(r.block).toBe(true)
    expect(r.text).toBe(CLOSEOUT_4RULE_REMINDER)
    expect(r.text).not.toBe(CLOSEOUT_REMINDER)
    expect(state.trips).toBe(1)
  })

  test("(7) cfg.fourRule=false (or absent) keeps the legacy one-liner", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: false } })
    expect(r.text).toBe(CLOSEOUT_REMINDER)
  })

  test("(8) fourRule mode is still single-shot per run", () => {
    const state = createCloseoutGuardState()
    const first = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: true } })
    expect(first.block).toBe(true)
    const second = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: true } })
    expect(second).toEqual({ block: false })
    expect(state.trips).toBe(1)
  })

  // W2 audit fix: (9) deleted — same substring-keyword tautology pattern as
  // (5). Routing tests (6)/(7)/(8) `toBe(CLOSEOUT_4RULE_REMINDER)` already
  // pin the constant by identity; the sota-codex-full e2e asserts that the
  // 4-rule text reaches the agent transcript through closeout-guard fire.

  // Phase 4 absorption: code-modification routing precedence. A history that
  // contains a mutating tool call (`edit` / `write` / `scripted_replace`)
  // routes to the Phase 4 four-truth-surface reminder, taking precedence over
  // `cfg.fourRule`. Non-code-mod sessions fall through to the legacy choice.
  test("(10) history contains {name:'edit'} + fourRule:false ⇒ CODE_MOD reminder (not legacy)", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true, fourRule: false },
      history: [{ name: "edit" }],
    })
    expect(r.block).toBe(true)
    expect(r.text).toBe(CODE_MOD_CLOSEOUT_REMINDER)
    expect(r.text).not.toBe(CLOSEOUT_REMINDER)
    expect(state.trips).toBe(1)
  })

  test("(11) history contains {name:'scripted_replace'} ⇒ CODE_MOD reminder", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true },
      history: [{ name: "bash" }, { name: "scripted_replace" }],
    })
    expect(r.text).toBe(CODE_MOD_CLOSEOUT_REMINDER)
    expect(state.trips).toBe(1)
  })

  test("(11b) history contains {name:'write'} ⇒ CODE_MOD reminder", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true },
      history: [{ name: "write" }],
    })
    expect(r.text).toBe(CODE_MOD_CLOSEOUT_REMINDER)
  })

  test("(12) empty history + fourRule:true ⇒ legacy 4-rule (not CODE_MOD)", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true, fourRule: true },
      history: [],
    })
    expect(r.text).toBe(CLOSEOUT_4RULE_REMINDER)
    expect(r.text).not.toBe(CODE_MOD_CLOSEOUT_REMINDER)
  })

  test("(12b) undefined history + fourRule:true ⇒ legacy 4-rule", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: true } })
    expect(r.text).toBe(CLOSEOUT_4RULE_REMINDER)
  })

  test("(13) empty history + fourRule:false ⇒ legacy one-liner CLOSEOUT_REMINDER", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true, fourRule: false },
      history: [{ name: "bash" }, { name: "read" }],
    })
    expect(r.text).toBe(CLOSEOUT_REMINDER)
    expect(r.text).not.toBe(CODE_MOD_CLOSEOUT_REMINDER)
  })

  // CR1 P1 fix (Round 3): explicit-over-implicit. A caller that EXPLICITLY
  // sets `fourRule:true` chose the 4-rule discipline; the code-mod
  // auto-detector must NOT silently overwrite that intent. The Round 1
  // precedence (code-mod > fourRule) was wrong — it silently overrode user
  // intent in the exact case where intent matters most.
  test("(14) code-mod session + fourRule:true ⇒ 4-rule wins (explicit-over-implicit)", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true, fourRule: true },
      history: [{ name: "edit" }],
    })
    expect(r.text).toBe(CLOSEOUT_4RULE_REMINDER)
    expect(r.text).not.toBe(CODE_MOD_CLOSEOUT_REMINDER)
  })

  test("(14b) code-mod session WITHOUT explicit fourRule ⇒ four-surface (default)", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({
      state,
      cfg: { enabled: true },
      history: [{ name: "edit" }],
    })
    expect(r.text).toBe(CODE_MOD_CLOSEOUT_REMINDER)
  })

  // W2 audit fix: (15) deleted — same substring-keyword tautology. Routing
  // tests (10)-(14b) `toBe(CODE_MOD_CLOSEOUT_REMINDER)` already pin the
  // constant; `tests/integration/sota-codex-full.test.ts` "code-mod closeout
  // routing through the loop" verifies the four-surface text reaches the
  // forced meta-user message in the agent transcript.
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
