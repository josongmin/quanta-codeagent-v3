/**
 * Parser tests — locks the DSL grammar (allow|deny|ask + prefix), the
 * comment / blank-line skip semantics, the duplicate-vs-conflict
 * distinction, and the named-error contract.
 *
 * These tests are the SSOT for what malformed input looks like at the
 * boundary between human-edited rule files and the matcher. Any change
 * here MUST be reflected in ADR-0031.
 */
import { describe, expect, test } from "bun:test"
import { parseRules, RuleParseError } from "@/rules"

describe("parseRules — happy path: closed action enum", () => {
  test("parses an `allow` rule with a simple single-token prefix", () => {
    const rules = parseRules("allow ls", "system", "system.rules")
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      action: "allow",
      prefix: "ls",
      layer: "system",
      sourceLine: 1,
      sourceFile: "system.rules",
    })
  })

  test("parses a `deny` rule with a multi-token prefix", () => {
    const rules = parseRules("deny rm -rf", "user", "user.rules")
    expect(rules).toHaveLength(1)
    expect(rules[0]?.action).toBe("deny")
    expect(rules[0]?.prefix).toBe("rm -rf")
  })

  test("parses an `ask` rule", () => {
    const rules = parseRules("ask git push", "project", "project.rules")
    expect(rules).toHaveLength(1)
    expect(rules[0]?.action).toBe("ask")
    expect(rules[0]?.prefix).toBe("git push")
  })

  test("tags every parsed rule with the caller-supplied layer", () => {
    const rules = parseRules("allow a\nallow b\nallow c", "project", "p.rules")
    expect(rules).toHaveLength(3)
    expect(rules.every((r) => r.layer === "project")).toBe(true)
  })

  test("emits 1-indexed sourceLine numbers in source order", () => {
    const rules = parseRules("allow a\nallow b\nallow c", "system", "x.rules")
    expect(rules.map((r) => r.sourceLine)).toEqual([1, 2, 3])
  })

  test("preserves internal whitespace inside the prefix", () => {
    const rules = parseRules("allow git  status", "system", "x.rules")
    expect(rules[0]?.prefix).toBe("git  status")
  })

  test("strips leading and trailing whitespace from prefix tokens", () => {
    const rules = parseRules("   allow    git status   ", "system", "x.rules")
    expect(rules[0]?.prefix).toBe("git status")
  })

  test("accepts CRLF line endings byte-identically to LF", () => {
    const lf = parseRules("allow a\nallow b", "system", "x.rules")
    const crlf = parseRules("allow a\r\nallow b", "system", "x.rules")
    expect(crlf).toEqual(lf)
  })
})

describe("parseRules — skip rules", () => {
  test("ignores blank lines", () => {
    const rules = parseRules("\n\nallow a\n\n\nallow b\n", "system", "x.rules")
    expect(rules.map((r) => r.prefix)).toEqual(["a", "b"])
  })

  test("ignores comment lines starting with `#`", () => {
    const rules = parseRules("# header\nallow a\n# trailing\n", "system", "x.rules")
    expect(rules.map((r) => r.prefix)).toEqual(["a"])
  })

  test("ignores comments with leading whitespace", () => {
    const rules = parseRules("   # indented comment\nallow a", "system", "x.rules")
    expect(rules).toHaveLength(1)
  })

  test("treats trailing `#` inside a rule line as part of the prefix", () => {
    // DSL is whitespace-delimited only — trailing `#` is NOT a comment marker
    // in the middle of a line. This locks deterministic behaviour.
    const rules = parseRules("allow echo # not a comment", "system", "x.rules")
    expect(rules[0]?.prefix).toBe("echo # not a comment")
  })

  test("handles an entirely empty document", () => {
    const rules = parseRules("", "system", "x.rules")
    expect(rules).toEqual([])
  })

  test("handles a comment-only document", () => {
    const rules = parseRules("# a\n# b\n# c\n", "system", "x.rules")
    expect(rules).toEqual([])
  })
})

describe("parseRules — error cases (RuleParseError, no fallback)", () => {
  test("throws on an unknown action token", () => {
    expect(() => parseRules("permit ls", "system", "x.rules")).toThrow(RuleParseError)
  })

  test("error carries the 1-indexed lineNumber of the offending line", () => {
    try {
      parseRules("allow a\nallow b\nbogus c", "system", "x.rules")
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RuleParseError)
      const parseErr = err as RuleParseError
      expect(parseErr.lineNumber).toBe(3)
      expect(parseErr.sourceFile).toBe("x.rules")
    }
  })

  test("throws when an action is present but the prefix is missing", () => {
    expect(() => parseRules("allow", "system", "x.rules")).toThrow(RuleParseError)
  })

  test("throws when an action has only trailing whitespace (empty prefix)", () => {
    expect(() => parseRules("allow    ", "system", "x.rules")).toThrow(RuleParseError)
  })

  test("conflicting actions on the same prefix throw RuleParseError", () => {
    expect(() => parseRules("allow git push\ndeny git push", "system", "x.rules")).toThrow(
      RuleParseError,
    )
  })

  test("conflict error carries the SECOND occurrence's lineNumber", () => {
    try {
      parseRules("allow git push\ndeny git push", "system", "x.rules")
      throw new Error("expected throw")
    } catch (err) {
      const parseErr = err as RuleParseError
      expect(parseErr.lineNumber).toBe(2)
      expect(parseErr.message).toContain("conflicting actions")
      expect(parseErr.message).toContain("git push")
    }
  })

  test("error message names the unknown token", () => {
    try {
      parseRules("warn ls", "system", "x.rules")
      throw new Error("expected throw")
    } catch (err) {
      expect((err as Error).message).toContain('"warn"')
    }
  })

  test("case-sensitive action tokens — `Allow` is NOT recognised", () => {
    // Deterministic = case-sensitive. No magical case-folding.
    expect(() => parseRules("Allow ls", "system", "x.rules")).toThrow(RuleParseError)
  })
})

describe("parseRules — same-action dedupe", () => {
  test("same-action duplicate is silently deduped (no error)", () => {
    const rules = parseRules("allow git status\nallow git status", "system", "x.rules")
    expect(rules).toHaveLength(1)
    expect(rules[0]?.sourceLine).toBe(1)
  })

  test("dedupe is per-prefix — different prefixes coexist", () => {
    const rules = parseRules("allow a\nallow b\nallow a", "system", "x.rules")
    expect(rules.map((r) => r.prefix)).toEqual(["a", "b"])
  })
})

describe("parseRules — return-value immutability", () => {
  test("returned array is frozen", () => {
    const rules = parseRules("allow a", "system", "x.rules")
    expect(Object.isFrozen(rules)).toBe(true)
  })

  test("individual rule objects are frozen", () => {
    const rules = parseRules("allow a", "system", "x.rules")
    expect(Object.isFrozen(rules[0])).toBe(true)
  })
})
