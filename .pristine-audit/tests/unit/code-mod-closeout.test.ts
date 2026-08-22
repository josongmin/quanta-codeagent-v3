import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as closeoutGuard from "@/agent/closeout-guard"
import { CLOSEOUT_4RULE_REMINDER, CLOSEOUT_REMINDER } from "@/agent/closeout-guard"

// This suite formerly tested the `isCodeModificationSession` tool-name scan and
// the separate `CODE_MOD_CLOSEOUT_REMINDER` constant. Both were REMOVED: the
// scan routed the closeout self-check by guessing from tool names (over- AND
// under-inclusive — a stray scratch `write` looked like a code change, while
// `bash sed -i` mutations were invisible). The default reminder is now a UNION
// that carries the code-mod walk inline, self-selected by the model. These
// tests are the teeth that the interpretive route is gone.

describe("code-mod closeout — interpretive routing removed (teeth)", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "src", "agent", "closeout-guard.ts"),
    "utf8",
  )

  test("the `isCodeModificationSession` heuristic export no longer exists", () => {
    expect("isCodeModificationSession" in closeoutGuard).toBe(false)
  })

  test("the separate `CODE_MOD_CLOSEOUT_REMINDER` constant no longer exists", () => {
    expect("CODE_MOD_CLOSEOUT_REMINDER" in closeoutGuard).toBe(false)
  })

  test("the source contains no tool-name scan over edit/write/scripted_replace", () => {
    // The removed heuristic was a Set membership test over mutating tool NAMES.
    // If a future edit reintroduces a route on those names, this fails.
    expect(source).not.toContain("scripted_replace")
    expect(source).not.toMatch(/new\s+Set\(\s*\[\s*["']edit["']/)
    expect(source).not.toContain("isCodeModificationSession")
    expect(source).not.toContain("CODE_MOD_TOOLS")
  })

  test("the default reminder is the UNION: general guidance + self-select code-mod walk", () => {
    // General defended-claim portion.
    expect(CLOSEOUT_REMINDER).toContain("defended claims")
    expect(CLOSEOUT_REMINDER).toContain("verification was not run")
    // Self-select code-modification four-surface portion, inline.
    expect(CLOSEOUT_REMINDER).toContain("If you modified code")
    expect(CLOSEOUT_REMINDER).toContain("four truth surfaces")
    for (const surface of ["type", "owner", "wire", "test"]) {
      expect(CLOSEOUT_REMINDER).toContain(surface)
    }
  })

  test("the union default is distinct from the explicit 4-rule reminder", () => {
    expect(CLOSEOUT_REMINDER).not.toBe(CLOSEOUT_4RULE_REMINDER)
  })
})
