/**
 * §10.2 — argv tokenizer tests (Codex `prefix_rule(pattern=[...])` parity).
 *
 * `tokenizeArgv` splits a shell command STRING into its argv token vector so
 * the matcher can do token-prefix matching instead of byte-prefix matching.
 * It is deliberately a SMALL, AUDITABLE shell-word splitter (POSIX-ish):
 * whitespace separates tokens; single + double quotes group; backslash
 * escapes the next char outside single-quotes. It is NOT a full shell parser
 * (no expansion, no operators) — it never throws and degrades to a best-effort
 * split on malformed input.
 */
import { describe, expect, test } from "bun:test"
import { tokenizeArgv } from "@/rules"

describe("tokenizeArgv — basic splitting", () => {
  test("splits on single spaces", () => {
    expect(tokenizeArgv("git push origin")).toEqual(["git", "push", "origin"])
  })

  test("collapses runs of whitespace (spaces + tabs)", () => {
    expect(tokenizeArgv("git   push\t\torigin")).toEqual(["git", "push", "origin"])
  })

  test("strips leading + trailing whitespace", () => {
    expect(tokenizeArgv("   ls -la   ")).toEqual(["ls", "-la"])
  })

  test("empty string => empty argv", () => {
    expect(tokenizeArgv("")).toEqual([])
  })

  test("whitespace-only string => empty argv", () => {
    expect(tokenizeArgv("   \t  ")).toEqual([])
  })
})

describe("tokenizeArgv — quoting", () => {
  test("double quotes group a token with spaces", () => {
    expect(tokenizeArgv('git commit -m "fix the bug"')).toEqual([
      "git",
      "commit",
      "-m",
      "fix the bug",
    ])
  })

  test("single quotes group a token with spaces", () => {
    expect(tokenizeArgv("echo 'hello world'")).toEqual(["echo", "hello world"])
  })

  test("adjacent quoted + unquoted segments fuse into one token", () => {
    expect(tokenizeArgv('a"b c"d')).toEqual(["ab cd"])
  })

  test("backslash escapes a space outside quotes", () => {
    expect(tokenizeArgv("file\\ name")).toEqual(["file name"])
  })

  test("backslash inside single quotes is literal", () => {
    expect(tokenizeArgv("echo 'a\\b'")).toEqual(["echo", "a\\b"])
  })
})

describe("tokenizeArgv — no-throw / degenerate", () => {
  test("unterminated double quote degrades (best-effort, no throw)", () => {
    // Best-effort: the open quote consumes to end-of-string.
    expect(() => tokenizeArgv('git commit -m "unterminated')).not.toThrow()
    expect(tokenizeArgv('git commit -m "unterminated')).toEqual([
      "git",
      "commit",
      "-m",
      "unterminated",
    ])
  })

  test("non-string input => empty argv (no throw)", () => {
    // tokenizeArgv accepts `unknown` and runtime-guards non-strings.
    expect(tokenizeArgv(undefined)).toEqual([])
    expect(tokenizeArgv(123)).toEqual([])
  })

  test("trailing backslash is literal (no escape target)", () => {
    expect(tokenizeArgv("foo\\")).toEqual(["foo\\"])
  })
})
