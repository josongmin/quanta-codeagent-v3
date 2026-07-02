/**
 * jul-3 strategy-audit prompt fixes — A1 (R-ENV narrowing) + A3 (defect-gated
 * repro-first line). These pin the shared FROZEN system prompt text so a future
 * edit cannot silently drop the narrowing (A1) or make the repro directive
 * unconditional (A3), and confirm the DEFAULT-OFF guardrails survive.
 *
 * Both fixes touch the FROZEN prompt (the default every existing surface
 * renders), so `buildSystemPrompt()` with no opts is the surface under test.
 */

import { describe, expect, test } from "bun:test"
import { CORE_RULES } from "./prompt-rules/core"
import { buildSystemPrompt } from "./prompt"

const rEnvText = (): string => {
  const rule = CORE_RULES.find((r) => r.id === "R-ENV")
  if (rule === undefined) throw new Error("R-ENV rule missing")
  return rule.lines.join("\n")
}

describe("A1 — R-ENV stop-tail narrowing (third-party-only) + inline VAR=val exemption", () => {
  test("third-party install ban is KEPT (pip / npm / apt / conda still owned by the harness)", () => {
    const rEnv = rEnvText()
    for (const tool of ["pip", "npm", "apt", "conda"]) {
      expect(rEnv).toContain(`\`${tool}\``)
    }
    // Present in the rendered frozen prompt too.
    expect(buildSystemPrompt()).toContain("[R-ENV]")
  })

  test("persistent `export` is STILL banned (only the persistent form)", () => {
    const rEnv = rEnvText()
    expect(rEnv).toContain("persistent `export")
  })

  test("inline `VAR=val cmd` is now EXEMPTED (one-shot env scoped to a single command)", () => {
    const rEnv = rEnvText()
    // The exemption clause exists and names the canonical PYTHONPATH case.
    expect(rEnv).toContain("VAR=val cmd")
    expect(rEnv).toContain("PYTHONPATH=.")
    expect(rEnv.toLowerCase()).toContain("exception")
  })

  test("the STOP tail is NARROWED to a genuinely-missing THIRD-PARTY dep — not any missing package", () => {
    const rEnv = rEnvText()
    // The old unconditional trigger ("missing a package ... declare ... stop")
    // is replaced by a third-party-gated one.
    expect(rEnv).toContain("THIRD-PARTY package or a binary is genuinely missing")
    expect(rEnv).toContain("declare the environment unavailable")
    // The old broad wording is GONE (regression guard: this exact phrase drove
    // the R-ENV over-refusal on repo-own import failures).
    expect(rEnv).not.toContain("missing a package or a binary, declare")
  })

  test("repo-own import failure gets a PYTHONPATH=. retry BEFORE any stop (the narrowing's positive arm)", () => {
    const rEnv = rEnvText()
    expect(rEnv).toContain("repo's OWN package is not importable")
    expect(rEnv).toContain("retry once with")
  })
})

describe("A3 — defect-gated repro-first directive in the operating-principles body", () => {
  const prompt = buildSystemPrompt()

  test("the repro-first directive is PRESENT (reproduce the failure, then prove the fix)", () => {
    expect(prompt).toContain("reproduce the failure with the smallest failing case")
  })

  test("GUARD: the directive is CONDITIONAL on a defect/repro task — NOT unconditional", () => {
    // The line must open with a gate so it never fires on feature / refactor /
    // Q&A turns (the over-fire the audit flagged).
    expect(prompt).toContain("When (and ONLY when) the task is fixing a defect or reproducing a bug")
    // And it explicitly carves out the non-defect kinds.
    expect(prompt).toContain(
      "For a feature,\n  refactor, or a question, this does not apply — do not manufacture a repro.",
    )
  })
})
