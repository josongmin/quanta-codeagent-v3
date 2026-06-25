import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CLOSEOUT_4RULE_REMINDER,
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

  // De-heuristicized routing: the closeout reminder is NO LONGER selected by a
  // tool-name scan over history. The default (non-`fourRule`) path always
  // injects the UNION self-check ({@link CLOSEOUT_REMINDER}), which carries
  // both the general defended-claim guidance AND the self-select code-mod
  // four-surface walk. `decideCloseoutGuard` no longer accepts a `history`
  // argument at all — the route is a single explicit switch on `fourRule`.
  test("(10) default (fourRule absent) ⇒ UNION reminder, regardless of how files were changed", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true } })
    expect(r.block).toBe(true)
    expect(r.text).toBe(CLOSEOUT_REMINDER)
    // The union carries the code-mod walk inline — no separate constant.
    expect(r.text).toContain("If you modified code")
    expect(r.text).toContain("four truth surfaces")
    expect(state.trips).toBe(1)
  })

  test("(11) fourRule:false ⇒ same UNION reminder (no history dependence)", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: false } })
    expect(r.text).toBe(CLOSEOUT_REMINDER)
  })

  // Teeth: an `edit`-tool session and a `bash sed -i` session that the old
  // heuristic classified DIFFERENTLY now get byte-identical self-check text,
  // because the route no longer inspects history at all. Both go through the
  // single non-fourRule branch.
  test("(11b) edit-tool session and bash-sed session get the SAME complete self-check", () => {
    const editSession = createCloseoutGuardState()
    const sedSession = createCloseoutGuardState()
    // Old heuristic: edit ⇒ code-mod reminder; bash ⇒ legacy one-liner.
    const edit = decideCloseoutGuard({ state: editSession, cfg: { enabled: true } })
    const sed = decideCloseoutGuard({ state: sedSession, cfg: { enabled: true } })
    expect(edit.text).toBe(sed.text)
    expect(edit.text).toBe(CLOSEOUT_REMINDER)
  })

  test("(12) fourRule:true ⇒ explicit 4-rule reminder (the only non-default route)", () => {
    const state = createCloseoutGuardState()
    const r = decideCloseoutGuard({ state, cfg: { enabled: true, fourRule: true } })
    expect(r.text).toBe(CLOSEOUT_4RULE_REMINDER)
    expect(r.text).not.toBe(CLOSEOUT_REMINDER)
  })

  // Teeth: `decideCloseoutGuard` takes NO `history` parameter — the source of
  // the removed interpretive route. A future re-introduction of a tool-name
  // scan would reappear in this signature; this asserts it stays absent.
  test("(13) decideCloseoutGuard signature carries no `history` route", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "agent", "closeout-guard.ts"),
      "utf8",
    )
    const sig = source.slice(
      source.indexOf("export const decideCloseoutGuard"),
      source.indexOf("): { block: boolean; text?: string }"),
    )
    expect(sig).not.toContain("history")
    // And no branch on mutating tool names anywhere in the body.
    expect(source).not.toContain("isCodeModificationSession")
    expect(source).not.toContain("scripted_replace")
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
