/**
 * ADR-0512 invariant #1 — prompt ↔ nav-base single source of truth.
 *
 * The system prompt's "Canonical analysis ladder" and the skill-scope nav-base
 * MUST name the same tools, or the `✕ file_tree_summary skill-scoped` bug
 * returns (prompt tells the model to orient with a tool the gate then denies).
 *
 * NON-TAUTOLOGICAL by design: the test pins an INDEPENDENT hardcoded literal
 * ({@link PROMPT_LADDER_LITERAL}) and asserts BOTH the prompt AND the constant
 * match it. A drift in EITHER source — or an added/removed/reordered tool in the
 * prompt line — fails CI, because neither side is derived from the other inside
 * the test. (The earlier version derived both sides from `EXPLORATION_LADDER`,
 * so it could never catch the prompt drifting — audit finding.)
 */

import { describe, expect, test } from "bun:test"
import { isAlwaysInScope } from "@/agent/loop/skill-gate"
import { EXPLORATION_LADDER, READ_ONLY_EXPLORATION } from "@/agent/exploration-ladder"
import { BODY_AFTER_PERSONA } from "@/agent/prompt-body"

const promptBody = BODY_AFTER_PERSONA.join("\n")

/** Hardcoded, independent of both the prompt and the constant. Update this AND
 *  the two sources together — that three-way agreement is the ratchet. */
const PROMPT_LADDER_LITERAL = "file_tree_summary → glob → ls → read"

/** The exact tool list the prompt's "ladder:" line names, parsed from the
 *  prompt text (independent of `EXPLORATION_LADDER`). Captures everything
 *  between "ladder: " and the sentence-ending ".". */
const promptLadderTools = (() => {
  const m = promptBody.match(/ladder:\s*([^.]+)\./)
  return (m?.[1] ?? "").split("→").map((s) => s.trim()).filter(Boolean)
})()

describe("exploration-ladder ↔ prompt drift ratchet", () => {
  test("prompt's ladder line names EXACTLY the literal (catches add / remove / reorder)", () => {
    // Exact-equality on the parsed line — `toContain` would miss an appended 6th
    // tool, so we compare the whole parsed list.
    expect(promptLadderTools.join(" → ")).toBe(PROMPT_LADDER_LITERAL)
  })

  test("EXPLORATION_LADDER constant equals the same literal (single source of truth)", () => {
    expect(EXPLORATION_LADDER.join(" → ")).toBe(PROMPT_LADDER_LITERAL)
  })

  test("grep — the CONFIRM-step primitive — is named by the prompt and in the nav-base", () => {
    expect(promptBody).toContain("read/grep the candidates")
    expect(READ_ONLY_EXPLORATION).toContain("grep")
  })

  test("EVERY tool the PROMPT names in its ladder is always-in-scope (gate honors the prompt)", () => {
    // Parses the prompt (not the constant) and checks the GATE — so a prompt edit
    // that adds a tool the nav-base does not cover fails here, independently.
    expect(promptLadderTools.length).toBeGreaterThan(0)
    for (const t of promptLadderTools) {
      expect(isAlwaysInScope(t)).toBe(true)
    }
  })

  test("nav-base is read-only ONLY — no mutating/exec tool leaked in", () => {
    for (const t of ["write", "edit", "bash", "git_commit", "apply_patch"]) {
      expect(isAlwaysInScope(t)).toBe(false)
    }
  })

  test("nav-base matching is case-insensitive (meta + ladder normalized)", () => {
    // Audit finding: meta was matched raw while nav-base was normalized.
    expect(isAlwaysInScope("FILE_TREE_SUMMARY")).toBe(true)
    expect(isAlwaysInScope("Read")).toBe(true)
    expect(isAlwaysInScope("skill")).toBe(true) // lowercased meta still matches
    expect(isAlwaysInScope("TOOLSEARCH")).toBe(true)
  })
})
