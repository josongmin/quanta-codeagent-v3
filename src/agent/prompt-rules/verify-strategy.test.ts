/**
 * Verify-strategy axis (jul-4, third slot) — RED-on-injection + no-leak hellgate.
 *
 * Pins that the verify axis is (1) exhaustive and exact per strategy, (2) OFF ⇒
 * byte-identical (an absent strategy renders zero lines), (3) ON ⇒ the EXACT rule
 * spliced after the task axis, (4) forwarded through the SurfaceProfile seam, and
 * (5) no-leak: reproduce-first works from the public issue text and explicitly
 * forbids seeking any hidden / grader / reference test.
 */
import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../prompt"
import { composeSystemPromptForSurface, SWE_SURFACE_PROFILE } from "../surface-profile"
import {
  GRADER_ONLY_RULE,
  REPRODUCE_FIRST_RULE,
  renderVerifyStrategy,
  VERIFY_AFTER_EDIT_RULE,
  type VerifyStrategy,
} from "./verify-strategy"

describe("renderVerifyStrategy — exhaustive + exact", () => {
  test("undefined ⇒ [] (no lines, the byte-identical default)", () => {
    expect(renderVerifyStrategy(undefined)).toEqual([])
  })
  test("reproduce-first ⇒ exactly REPRODUCE_FIRST_RULE.lines", () => {
    expect(renderVerifyStrategy("reproduce-first")).toEqual(REPRODUCE_FIRST_RULE.lines)
  })
  test("verify-after-edit ⇒ exactly VERIFY_AFTER_EDIT_RULE.lines", () => {
    expect(renderVerifyStrategy("verify-after-edit")).toEqual(VERIFY_AFTER_EDIT_RULE.lines)
  })
  test("each strategy renders a DISTINCT non-empty rule (no accidental aliasing)", () => {
    const rf = renderVerifyStrategy("reproduce-first").join("\n")
    const va = renderVerifyStrategy("verify-after-edit").join("\n")
    expect(rf.length).toBeGreaterThan(0)
    expect(va.length).toBeGreaterThan(0)
    expect(rf).not.toBe(va)
  })
})

describe("buildSystemPrompt — verify axis (slot 3)", () => {
  test("OFF (absent verifyStrategy) ⇒ NO verify rule present in any posture/pack", () => {
    // exactOptionalPropertyTypes forbids passing `verifyStrategy: undefined`, so ABSENCE
    // is the only OFF representation — and it must leak zero verify lines. (There is no
    // absolute-byte golden pin of the whole prompt; byte-identity is asserted structurally
    // via the seam self-equivalence tests below + the 3-axis parity guard, not by a hash.)
    const OFF_OPTS: Array<Parameters<typeof buildSystemPrompt>[1]> = [
      {},
      { promptPack: "batch" },
      { envPosture: "owned" },
      { promptPack: "ci-bot" },
    ]
    for (const opt of OFF_OPTS) {
      const p = buildSystemPrompt("/w", opt)
      expect(p).not.toContain("[R-REPRODUCE-FIRST]")
      expect(p).not.toContain("[R-VERIFY-AFTER-EDIT]")
    }
  })
  test("ON ⇒ the EXACT rule text is spliced, and the prompt grows by exactly the rule", () => {
    const off = buildSystemPrompt("/w", { promptPack: "batch" })
    const on = buildSystemPrompt("/w", { promptPack: "batch", verifyStrategy: "reproduce-first" })
    expect(on).toContain(REPRODUCE_FIRST_RULE.lines.join("\n"))
    expect(on).not.toBe(off)
    // The delta is exactly the rule (+ the joining newline) — the axis adds nothing else.
    expect(on.length).toBe(off.length + REPRODUCE_FIRST_RULE.lines.join("\n").length + 1)
  })
  test("verify axis is INDEPENDENT of posture — composes under owned too", () => {
    const on = buildSystemPrompt("/w", { envPosture: "owned", verifyStrategy: "verify-after-edit" })
    expect(on).toContain(VERIFY_AFTER_EDIT_RULE.lines.join("\n"))
  })
})

describe("SurfaceProfile seam forwards the verify axis", () => {
  test("SWE + reproduce-first via seam == buildSystemPrompt with both (byte-identical)", () => {
    const viaSeam = composeSystemPromptForSurface(
      { ...SWE_SURFACE_PROFILE, verifyStrategy: "reproduce-first" },
      { cwd: "/w" },
    )
    expect(viaSeam).toBe(
      buildSystemPrompt("/w", { promptPack: "batch", verifyStrategy: "reproduce-first" }),
    )
    expect(viaSeam).toContain(REPRODUCE_FIRST_RULE.lines.join("\n"))
  })
  test("SWE profile WITHOUT the field ⇒ no verify rule (byte-identical to plain batch)", () => {
    expect(composeSystemPromptForSurface(SWE_SURFACE_PROFILE, { cwd: "/w" })).not.toContain(
      "[R-REPRODUCE-FIRST]",
    )
  })
})

describe("no-leak — reproduce-first never points at hidden/grader/reference tests", () => {
  const text = REPRODUCE_FIRST_RULE.lines.join("\n")
  test("reproduces from the PUBLIC issue text and says so", () => {
    expect(text).toContain("public issue text")
  })
  test("explicitly FORBIDS seeking any hidden / grader / reference test (RED if the guard is dropped)", () => {
    expect(text.toLowerCase()).toContain("do not seek")
    expect(text.toLowerCase()).toContain("hidden")
    expect(text.toLowerCase()).toContain("grader")
    expect(text.toLowerCase()).toContain("reference test")
  })
  test("does not instruct reading/opening a concealed test file", () => {
    // The rule may NAME hidden/grader tests only inside the negative clause; it must
    // never issue a positive 'read/open/inspect the hidden test' directive.
    expect(text).not.toMatch(/\b(read|open|inspect|cat)\b[^.]*\bhidden\b/i)
    expect(text).not.toMatch(/\banswer key\b/i)
  })
})

// Type-level exhaustiveness witness: every VerifyStrategy value has a render arm.
const _exhaustive: Record<VerifyStrategy, readonly string[]> = {
  "reproduce-first": renderVerifyStrategy("reproduce-first"),
  "verify-after-edit": renderVerifyStrategy("verify-after-edit"),
  "grader-only": renderVerifyStrategy("grader-only"),
}
void _exhaustive

describe("grader-only (P6 SWE hidden-grader) — exact + no-leak", () => {
  const text = GRADER_ONLY_RULE.lines.join("\n")
  test("renderVerifyStrategy('grader-only') == GRADER_ONLY_RULE.lines", () => {
    expect(renderVerifyStrategy("grader-only")).toEqual(GRADER_ONLY_RULE.lines)
  })
  test("command form: has Do NOT / Do / Stop when / Final", () => {
    expect(text).toContain("Do NOT:")
    expect(text).toContain("Do:")
    expect(text).toContain("Stop when:")
    expect(text).toContain("Final:")
  })
  test("no-leak: forbids seeking hidden/grader/reference test; no read-the-hidden-test directive", () => {
    expect(text.toLowerCase()).toContain("seek any hidden, grader, or reference test")
    expect(text).not.toMatch(/\b(read|open|inspect|cat)\b[^.]*\bhidden\b/i)
    expect(text).not.toMatch(/\banswer key\b/i)
  })
  test("forbids running pytest/tox + overclaiming", () => {
    expect(text.toLowerCase()).toContain("pytest")
    expect(text.toLowerCase()).toContain("tox")
    expect(text.toLowerCase()).toContain("verified / passing / green / done")
  })
  test("buildSystemPrompt: grader-only SUPPRESSES every local-verification body rule, adds rule (conflict fix)", () => {
    const off = buildSystemPrompt("/w", { promptPack: "batch" })
    const on = buildSystemPrompt("/w", { promptPack: "batch", verifyStrategy: "grader-only" })
    // baseline carries the conflicting body rules …
    expect(off).toContain("first reproduce the failure with the smallest")
    expect(off).toContain("Completion bar: finish only when")
    expect(off).toContain("Verification report (use when you ran or considered running verification)")
    // … grader-only removes ALL conflicting body rules and adds the single coherent grader rule
    expect(on).not.toContain("first reproduce the failure with the smallest")
    expect(on).not.toContain("Completion bar: finish only when")
    // R3 audit: the "run the project's tests" verify discipline also contradicts grader-only
    expect(on).not.toContain("After changing code, verify it: run the project")
    // R4 self-audit: the structured Verification report block (rail: pytest / verdict / exit)
    // presupposes a local run grader-only forbids — it too must be suppressed. RED before the
    // fix (only completion-bar was dropped, the report block survived and re-injected the conflict).
    expect(on).not.toContain("Verification report (use when you ran or considered running verification)")
    expect(on).not.toContain("rail:      <e.g. bun test, pytest, tsc --noEmit, manual repro>")
    expect(on).toContain("[R-GRADER-ONLY]")
    // but grader-only supplies its OWN honest final-verification format (not a silent drop)
    expect(on).toContain("verification: not run")
    // opposite of reproduce-first — they never coexist
    expect(on).not.toContain("[R-REPRODUCE-FIRST]")
  })

  test("buildSystemPrompt: grader-only ALSO suppresses the jul-6 residual conflicts", () => {
    const off = buildSystemPrompt("/w", { promptPack: "batch" })
    const on = buildSystemPrompt("/w", { promptPack: "batch", verifyStrategy: "grader-only" })
    // baseline carries all four …
    expect(off).toContain("Validation budget: build/test/type-check")
    expect(off).toContain("5–10 tool calls before producing the final summary")
    expect(off).toContain("Durable state belongs in workspace files")
    expect(off).toContain("Vision priority")
    // … grader-only drops all four (local-verify budget, over-exploration framing, docs-write
    // artifact rule, and vision noise) — each contradicts or is dead weight under hidden-grader.
    expect(on).not.toContain("Validation budget: build/test/type-check")
    expect(on).not.toContain("5–10 tool calls before producing the final summary")
    expect(on).not.toContain("Durable state belongs in workspace files")
    expect(on).not.toContain("Vision priority")
    // …and the surrounding sections + their blank separators survive (block-removal, not
    // line-set: the prior withoutLines collapsed EVERY blank in the tail).
    expect(on).toContain("Honesty rail")
    expect(on).toContain("\nHonesty rail")
    expect(on).toContain("Budget discipline (every call is expensive)")
  })

  test("grader-only block-removal does NOT collapse unrelated blank separators", () => {
    const on = buildSystemPrompt("/w", { promptPack: "batch", verifyStrategy: "grader-only" })
    // Regression guard for the jul-6 blank-collapse bug: the pack-tail sections must still be
    // blank-separated (Honesty preceded by an empty line, not mashed onto the prior line).
    const lines = on.split("\n")
    const hi = lines.findIndex((l) => l.startsWith("Honesty rail"))
    expect(hi).toBeGreaterThan(0)
    expect(lines[hi - 1]).toBe("")
  })

  // Self-audit render-scan, codified: EVERY line that DEMANDS the model run local
  // verification (or claim green after running) must be absent from the grader-only
  // prompt — except inside R-GRADER-ONLY's own "Do NOT" forbid clause. The reproduce-first
  // control proves the scan is LIVE (non-vacuous): the same demands are present there.
  const HARD_CONFLICT_DEMANDS: readonly RegExp[] = [
    /reproduce the failure with the smallest/i,
    /Completion bar: finish only when/i,
    /Verification report \(use when you ran/i,
    /rail:\s+<e\.g\. bun test/i,
    /the relevant tests pass/i,
    /After changing code, verify it: run the project/i,
  ]
  const hardConflictLines = (prompt: string): string[] => {
    const lines = prompt.split("\n")
    const gStart = lines.findIndex((l) => l.includes("[R-GRADER-ONLY]"))
    let gEnd = gStart
    if (gStart >= 0)
      for (let i = gStart; i < lines.length && i < gStart + 25; i++)
        if (lines[i]?.includes("Do not overclaim")) {
          gEnd = i
          break
        }
    const inGrader = (i: number): boolean => gStart >= 0 && i >= gStart && i <= gEnd
    return lines.filter(
      (l, i) => !inGrader(i) && HARD_CONFLICT_DEMANDS.some((rx) => rx.test(l)),
    )
  }
  test("scenario: grader-only prompt has ZERO local-verification DEMANDS outside the grader rule", () => {
    const on = buildSystemPrompt("/w", { promptPack: "batch", verifyStrategy: "grader-only" })
    expect(hardConflictLines(on)).toEqual([])
  })
  test("scenario CONTROL: reproduce-first KEEPS those demands (proves the scan is non-vacuous)", () => {
    // If this ever drops to 0, the scan above is measuring nothing — this control fails LOUD.
    const control = buildSystemPrompt("/w", {
      promptPack: "batch",
      verifyStrategy: "reproduce-first",
    })
    expect(hardConflictLines(control).length).toBeGreaterThanOrEqual(5)
  })
})
