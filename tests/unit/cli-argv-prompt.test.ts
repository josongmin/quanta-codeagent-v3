import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { argvImages, argvPrompt } from "../../src/apps/cli/internal"

/**
 * `argvPrompt` allowlist regression suite (audit may-22, MEDIUM-12 fix).
 *
 * The prior implementation used a DENYLIST: it stripped a hardcoded set of known
 * flags and joined the REST into the seed prompt sent to the LLM. Any flag NOT
 * in that list (a typo, or a newly-added top-level flag) leaked verbatim into
 * the model prompt. The fix inverts to an ALLOWLIST: only positional (non-`-`)
 * argv tokens become the prompt, and values consumed by known `--flag <value>`
 * pairs are still skipped. These tests pin both the byte-identical common case
 * AND the leak-prevention behavior.
 */
describe("argvPrompt — allowlist semantics", () => {
  let argvSnapshot: string[]
  beforeEach(() => {
    argvSnapshot = process.argv.slice()
  })
  afterEach(() => {
    process.argv = argvSnapshot
  })

  const setArgv = (...args: string[]): void => {
    process.argv = ["bun", "quanta", ...args]
  }

  test("plain positional prompt is unchanged (byte-identical common case)", () => {
    setArgv("fix", "the", "bug")
    expect(argvPrompt()).toBe("fix the bug")
  })

  test("a single quoted positional is preserved verbatim", () => {
    setArgv("fix the login bug")
    expect(argvPrompt()).toBe("fix the login bug")
  })

  test("known boolean flags are stripped, positional prompt survives", () => {
    setArgv("--plan", "--lsp", "implement", "the", "feature")
    expect(argvPrompt()).toBe("implement the feature")
  })

  test("known valued flags drop BOTH flag and value", () => {
    setArgv("--state", "/tmp/s.json", "--resume", "abc-id", "do", "the", "thing")
    expect(argvPrompt()).toBe("do the thing")
  })

  test("LEAK FIX: an unknown/new top-level flag never reaches the prompt", () => {
    // `--worktree` (and any future flag) is NOT a known positional → excluded.
    // Under the old denylist a flag missing from the list leaked verbatim.
    setArgv("--worktree", "summarize", "the", "diff")
    const prompt = argvPrompt()
    expect(prompt).toBe("summarize the diff")
    expect(prompt).not.toContain("--worktree")
  })

  test("LEAK FIX: a totally novel flag is excluded too", () => {
    setArgv("--brand-new-flag", "hello")
    const prompt = argvPrompt()
    expect(prompt).toBe("hello")
    expect(prompt).not.toContain("--brand-new-flag")
  })

  test("LEAK FIX: --flag=value form is excluded (no leak)", () => {
    setArgv("--mode=batch", "run", "it")
    const prompt = argvPrompt()
    expect(prompt).toBe("run it")
    expect(prompt).not.toContain("--mode")
  })

  test("--image value is dropped from the prompt (still extractable via argvImages)", () => {
    setArgv("--image", "/tmp/a.png", "describe", "this")
    expect(argvPrompt()).toBe("describe this")
    expect(argvImages()).toEqual(["/tmp/a.png"])
  })

  test("no args ⇒ empty prompt", () => {
    setArgv()
    expect(argvPrompt()).toBe("")
  })

  test("only flags ⇒ empty prompt (nothing leaks)", () => {
    setArgv("--plan", "--git-tools")
    expect(argvPrompt()).toBe("")
  })

  test("a stray bare `-` token is excluded (treated as a flag)", () => {
    setArgv("-", "real", "prompt")
    expect(argvPrompt()).toBe("real prompt")
  })
})
