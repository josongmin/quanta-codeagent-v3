import { describe, expect, test } from "bun:test"
import {
  CLOSEOUT_4RULE_REMINDER,
  CLOSEOUT_REMINDER,
  CODE_MOD_CLOSEOUT_REMINDER,
  isCodeModificationSession,
} from "@/agent/closeout-guard"

describe("isCodeModificationSession", () => {
  test("empty history ⇒ false", () => {
    expect(isCodeModificationSession([])).toBe(false)
  })

  test("undefined history ⇒ false", () => {
    expect(isCodeModificationSession(undefined)).toBe(false)
  })

  test("only read ⇒ false", () => {
    expect(isCodeModificationSession([{ name: "read" }])).toBe(false)
  })

  test("only readonly tools ⇒ false", () => {
    expect(
      isCodeModificationSession([
        { name: "read" },
        { name: "grep" },
        { name: "glob" },
        { name: "diagnostics" },
      ]),
    ).toBe(false)
  })

  test("edit ⇒ true", () => {
    expect(isCodeModificationSession([{ name: "edit" }])).toBe(true)
  })

  test("write ⇒ true", () => {
    expect(isCodeModificationSession([{ name: "write" }])).toBe(true)
  })

  test("scripted_replace ⇒ true", () => {
    expect(isCodeModificationSession([{ name: "scripted_replace" }])).toBe(true)
  })

  test("mixed history with a mutating tool ⇒ true", () => {
    expect(
      isCodeModificationSession([
        { name: "read" },
        { name: "grep" },
        { name: "edit" },
        { name: "read" },
      ]),
    ).toBe(true)
  })

  test("entries with the extra `arg` field (ToolHistoryEntry duck-typed) still work", () => {
    // Duck-typed: the predicate only reads `.name`, so the real
    // ToolHistoryEntry shape with an optional `arg` must not break anything.
    expect(
      isCodeModificationSession([
        { name: "bash", arg: "ls" } as { name: string; arg?: string },
        { name: "scripted_replace" } as { name: string; arg?: string },
      ]),
    ).toBe(true)
  })

  test("`bash` alone is NOT classified as code-modification", () => {
    // verify-guard treats SOME bash commands as verification; here we only
    // care about the mutating set — bash is not in it.
    expect(isCodeModificationSession([{ name: "bash" }])).toBe(false)
  })
})

describe("CODE_MOD_CLOSEOUT_REMINDER", () => {
  test("names the four surfaces (type / owner / wire / test)", () => {
    expect(CODE_MOD_CLOSEOUT_REMINDER).toContain("type")
    expect(CODE_MOD_CLOSEOUT_REMINDER).toContain("owner")
    expect(CODE_MOD_CLOSEOUT_REMINDER).toContain("wire")
    expect(CODE_MOD_CLOSEOUT_REMINDER).toContain("test")
  })

  test("is distinct from the legacy reminders (Phase 2 contract preserved)", () => {
    expect(CODE_MOD_CLOSEOUT_REMINDER).not.toBe(CLOSEOUT_REMINDER)
    expect(CODE_MOD_CLOSEOUT_REMINDER).not.toBe(CLOSEOUT_4RULE_REMINDER)
  })

  test("mentions all four surface keywords in stop-condition framing", () => {
    // The reminder ends with a "Stop only after all four surfaces are clean"
    // line — a regression guard so future edits don't drop the closing
    // condition that anchors the model's finish behavior.
    expect(CODE_MOD_CLOSEOUT_REMINDER).toMatch(/all four/i)
  })
})
