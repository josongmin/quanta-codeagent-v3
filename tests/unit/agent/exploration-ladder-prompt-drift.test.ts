/**
 * ADR-0512 invariant #1 — prompt ↔ nav-base single source of truth.
 *
 * The system prompt's "Canonical analysis ladder" and the skill-scope nav-base
 * MUST name the same tools, or the `✕ file_tree_summary skill-scoped` bug
 * returns (prompt tells the model to orient with a tool the gate then denies).
 * This ratchet fails CI the instant the prompt's ladder line drifts from
 * `EXPLORATION_LADDER`, forcing the constant — and therefore the gate's
 * nav-base — to be updated in lock-step.
 */

import { describe, expect, test } from "bun:test"
import { isAlwaysInScope } from "@/agent/loop/skill-gate"
import { EXPLORATION_LADDER, READ_ONLY_EXPLORATION } from "@/agent/exploration-ladder"
import { BODY_AFTER_PERSONA } from "@/agent/prompt-body"

const promptBody = BODY_AFTER_PERSONA.join("\n")

describe("exploration-ladder ↔ prompt drift ratchet", () => {
  test("prompt's analysis-ladder line names exactly EXPLORATION_LADDER, in order", () => {
    // If someone edits the prompt ladder (adds/removes/reorders a tool) without
    // updating EXPLORATION_LADDER, this fails — which is the whole point.
    expect(promptBody).toContain(`ladder: ${EXPLORATION_LADDER.join(" → ")}`)
  })

  test("grep — the CONFIRM-step primitive — is named by the prompt and in the nav-base", () => {
    expect(promptBody).toContain("read/grep the candidates")
    expect(READ_ONLY_EXPLORATION).toContain("grep")
  })

  test("every prompt-mandated exploration tool is ALWAYS in scope (nav-base ⊇ ladder)", () => {
    for (const t of READ_ONLY_EXPLORATION) {
      expect(isAlwaysInScope(t)).toBe(true)
    }
  })

  test("nav-base is read-only ONLY — no mutating/exec tool leaked in", () => {
    for (const t of ["write", "edit", "bash", "git_commit", "apply_patch"]) {
      expect(isAlwaysInScope(t)).toBe(false)
    }
  })
})
