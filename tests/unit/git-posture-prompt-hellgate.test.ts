/**
 * ADR-0099 hellgate — Git posture (default fail-closed) prompt section
 *
 * Codex §18.2 (Default-NO-git) + §18.4 (destructive verbatim ban) + §18.5
 * (naming convention) absorption. These are prompt-only rules — no HARD_DENY
 * regex enforcement at this layer (A3 covers that). The test asserts the
 * prompt contains the LLM-readable verbatim ban so the model has the policy
 * even before any tool gate.
 *
 * 10 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent"

describe("ADR-0099 Git posture prompt section (hellgate)", () => {
  const prompt = buildSystemPrompt()

  test("HELL-1: section is present (titled 'Git posture')", () => {
    expect(prompt).toContain("Git posture")
  })

  // ── Default-NO-git posture (§18.2) ────────────────────────────────────

  test("HELL-2: explicit 'DO NOT git commit ... unless explicitly requested'", () => {
    // Verbatim from Codex §18.2 — model MUST see this exact directive.
    // `s` flag = dotAll so `.+` crosses newlines (the bullet wraps lines).
    expect(prompt).toMatch(/DO NOT git commit.+unless.+explicitly requested/is)
  })

  test("HELL-3: read-only ops listed as free (status/log/diff/blame)", () => {
    // The model must know inspection is free; otherwise it might refuse even
    // diagnostic calls. Verbatim list defends against over-restriction.
    expect(prompt).toMatch(/status.+log.+diff.+blame/)
  })

  test("HELL-4: 'save your work' / 'clean up' / 'sync' explicitly NOT consent", () => {
    // Adversarial: vague phrasing must not be treated as commit consent.
    expect(prompt).toMatch(/save your work.+not.+explicit|not.+explicit.+save your work/is)
  })

  // ── Destructive verbatim ban (§18.4) ──────────────────────────────────

  test("HELL-5: `git reset --hard` banned verbatim", () => {
    expect(prompt).toContain("git reset --hard")
  })

  test("HELL-6: `git checkout -- ` banned verbatim", () => {
    expect(prompt).toContain("git checkout -- ")
  })

  test("HELL-7: `git commit --amend` banned verbatim", () => {
    expect(prompt).toContain("git commit --amend")
  })

  test("HELL-8: `git push --force` / `--force-with-lease` banned verbatim", () => {
    expect(prompt).toContain("git push --force")
    expect(prompt).toContain("--force-with-lease")
  })

  test("HELL-9: `git rebase -i` banned verbatim", () => {
    expect(prompt).toContain("git rebase -i")
  })

  // ── Hook bypass + unrelated revert ───────────────────────────────────

  test("HELL-10: `--no-verify` discipline + 'do not revert unrelated' present", () => {
    // Codex §18.4: never skip hooks; never revert unrelated user changes.
    expect(prompt).toMatch(/--no-verify/)
    expect(prompt).toMatch(/unrelated|not yours/i)
  })

  // ── Naming convention (§18.5) ─────────────────────────────────────────

  test("HELL-11: branch/PR naming convention present (`quanta/<desc>`, `[quanta] <desc>`)", () => {
    expect(prompt).toContain("quanta/")
    expect(prompt).toContain("[quanta]")
  })
})

/**
 * HELL-16..18 — the verbatim ban is SYMMETRIC under the checkout/restore
 * spelling.
 *
 * `git checkout -- <path>` and `git restore <path>` are the same operation:
 * both overwrite an uncommitted edit to a named path, and neither leaves a
 * reflog entry for what was lost. `git restore` is simply the modern spelling
 * git itself recommends.
 *
 * The runtime agrees, and has since 2026-08-28. Measured through the real
 * operator entry point with the shell grammar initialized:
 *
 *   sensitive-known/git-checkout-discard-path  hardDenied=no  :: git checkout -- src/foo.ts
 *   sensitive-known/git-restore-discard-path   hardDenied=no  :: git restore src/foo.ts
 *   hard-deny/git-checkout-discard             hardDenied=YES :: git checkout .
 *   hard-deny/git-restore-discard              hardDenied=YES :: git restore .
 *
 * The PROMPT did not. Its verbatim-ban bullet named `git checkout -- <path>`
 * and `git checkout .` and neither restore spelling, so the model was taught
 * that one spelling needs to be requested by name while its exact synonym
 * needs only an ordinary explicit request. That is the same spelling tax the
 * permission layer just spent a commit deleting, surviving one layer up.
 *
 * The asymmetry is closed by TIGHTENING, not by loosening: both spellings
 * belong in a bullet whose stated criterion is "overwrite uncommitted work or
 * rewrite published history", and both do.
 *
 * These arms are written as a PAIR — every ban here must hold for both
 * spellings — so a future edit that adds one and forgets the other fails,
 * which is the failure mode this whole class keeps producing.
 */
describe("verbatim ban — checkout and restore are the same operation", () => {
  const prompt = buildSystemPrompt()
  const NAMED_PATH_PAIR = ["git checkout -- ", "git restore <path>"] as const
  const WHOLE_TREE_PAIR = ["git checkout .", "git restore ."] as const

  test("HELL-16: the NAMED-PATH discard is banned in BOTH spellings", () => {
    for (const form of NAMED_PATH_PAIR)
      expect({ form, banned: prompt.includes(form) }).toEqual({ form, banned: true })
  })

  test("HELL-17: the WHOLE-TREE discard is banned in BOTH spellings", () => {
    for (const form of WHOLE_TREE_PAIR)
      expect({ form, banned: prompt.includes(form) }).toEqual({ form, banned: true })
  })

  test("HELL-18: PAIRED CONTROL — the ban did not swallow read-only inspection", () => {
    // Tightening one bullet must not turn the prompt into "never touch git".
    // `git status`/`log`/`diff` are explicitly free, and the model needs to
    // keep being told so or it stops inspecting before it acts.
    expect(prompt).toMatch(/status, log, diff/)
    for (const safe of ["git status", "git log"]) {
      // ...and they must NOT appear inside the destructive verbatim list.
      const banBullet = prompt.slice(prompt.indexOf("NEVER use these destructive forms"))
      const bulletEnd = banBullet.indexOf("\n- ")
      expect({ safe, inBan: banBullet.slice(0, bulletEnd).includes(safe) }).toEqual({
        safe,
        inBan: false,
      })
    }
  })
})
