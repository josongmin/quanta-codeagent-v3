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
    // is the only OFF representation — and it must leak zero verify lines. (The exact
    // byte-identical 5-target hashes are pinned separately in the byte-identical check.)
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
}
void _exhaustive
