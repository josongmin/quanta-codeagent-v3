import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { applyScriptedReplace, scriptedReplaceTool } from "@/tool/scripted-replace"

const dir = mkdtempSync(join(tmpdir(), "scripted-replace-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown, cwd: string = dir): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of scriptedReplaceTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("scriptedReplaceTool metadata", () => {
  test("name + flags", () => {
    expect(scriptedReplaceTool.name).toBe("scripted_replace")
    expect(scriptedReplaceTool.isReadOnly()).toBe(false)
    expect(
      scriptedReplaceTool.isConcurrencySafe({
        file: "x",
        pattern: "a",
        replacement: "b",
      }),
    ).toBe(false)
  })
})

describe("applyScriptedReplace (pure core)", () => {
  test("literal substring replaces every occurrence by default", () => {
    const r = applyScriptedReplace("foo bar foo baz foo", {
      pattern: "foo",
      replacement: "qux",
    })
    expect(r.ok).toBe(true)
    expect(r.next).toBe("qux bar qux baz qux")
    expect(r.replacements).toBe(3)
  })

  test("count caps the replacement number", () => {
    const r = applyScriptedReplace("foo foo foo foo", {
      pattern: "foo",
      replacement: "X",
      count: 2,
    })
    expect(r.ok).toBe(true)
    expect(r.next).toBe("X X foo foo")
    expect(r.replacements).toBe(2)
  })

  test("regex mode honours capture groups in replacement", () => {
    const r = applyScriptedReplace("foo_1 foo_22 foo_333", {
      pattern: "foo_(\\d+)",
      replacement: "bar_$1",
      isRegex: true,
    })
    expect(r.ok).toBe(true)
    expect(r.next).toBe("bar_1 bar_22 bar_333")
    expect(r.replacements).toBe(3)
  })

  test("regex mode supports $& whole-match expansion", () => {
    const r = applyScriptedReplace("apple banana cherry", {
      pattern: "\\w+",
      replacement: "<$&>",
      isRegex: true,
    })
    expect(r.ok).toBe(true)
    expect(r.next).toBe("<apple> <banana> <cherry>")
  })

  test("literal mode escapes regex metacharacters", () => {
    const r = applyScriptedReplace("a.b a.b a+b", {
      pattern: "a.b",
      replacement: "X",
    })
    // `.` should NOT act as a wildcard — literal mode escapes it.
    expect(r.ok).toBe(true)
    expect(r.next).toBe("X X a+b")
    expect(r.replacements).toBe(2)
  })

  test("empty pattern is rejected", () => {
    const r = applyScriptedReplace("hello", { pattern: "", replacement: "x" })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/must not be empty/)
  })

  test("invalid regex is rejected with a clear message", () => {
    const r = applyScriptedReplace("hello", {
      pattern: "(unclosed",
      replacement: "x",
      isRegex: true,
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/invalid regex/)
  })

  test("no match ⇒ ok:false with a clear message", () => {
    const r = applyScriptedReplace("hello", { pattern: "world", replacement: "x" })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not found/)
    expect(r.next).toBeUndefined()
  })

  test("$$ escapes a literal dollar", () => {
    const r = applyScriptedReplace("price=10", {
      pattern: "10",
      replacement: "$$10",
      isRegex: true,
    })
    expect(r.ok).toBe(true)
    expect(r.next).toBe("price=$10")
  })
})

describe("scriptedReplaceTool integration (FS)", () => {
  test("literal substring replacement, all occurrences", async () => {
    const f = join(dir, "lit-all.txt")
    writeFileSync(f, "foo bar foo baz foo")
    const r = await run({ file: f, pattern: "foo", replacement: "qux" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Replaced 3 occurrence(s)")
    expect(r.output).toContain("replacements=3")
    expect(readFileSync(f, "utf8")).toBe("qux bar qux baz qux")
  })

  test("literal with count: 2 limits replacements", async () => {
    const f = join(dir, "lit-cap.txt")
    writeFileSync(f, "foo foo foo foo")
    const r = await run({ file: f, pattern: "foo", replacement: "X", count: 2 })
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("X X foo foo")
    expect(r.output).toContain("replacements=2")
  })

  test("regex mode with capture-group replacement", async () => {
    const f = join(dir, "regex.txt")
    writeFileSync(f, "foo_1 + foo_22 + foo_333")
    const r = await run({
      file: f,
      pattern: "foo_(\\d+)",
      replacement: "bar_$1",
      isRegex: true,
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("bar_1 + bar_22 + bar_333")
  })

  test("file missing → error result, no write", async () => {
    const f = join(dir, "does-not-exist.txt")
    const r = await run({ file: f, pattern: "foo", replacement: "x" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/File not found/)
    expect(existsSync(f)).toBe(false)
  })

  test("pattern doesn't match → error result with clear message, file unchanged", async () => {
    const f = join(dir, "no-match.txt")
    writeFileSync(f, "hello world")
    const r = await run({ file: f, pattern: "absent_token", replacement: "x" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not found/)
    expect(readFileSync(f, "utf8")).toBe("hello world")
  })

  test("FS jail blocks paths outside cwd", async () => {
    // Create a jail subdir, target a sibling OUTSIDE it.
    const jail = mkdtempSync(join(tmpdir(), "scripted-replace-jail-"))
    const outside = mkdtempSync(join(tmpdir(), "scripted-replace-outside-"))
    const victim = join(outside, "secret.txt")
    writeFileSync(victim, "original-content")
    try {
      // Ensure the jail enforcement is on (default-on, but be explicit).
      const prev = process.env.QUANTA_FS_JAIL
      delete process.env.QUANTA_FS_JAIL
      const r = await run({ file: victim, pattern: "original", replacement: "x" }, jail)
      expect(r.ok).toBe(false)
      expect(r.output).toMatch(/jail/i)
      // Victim file is byte-identical.
      expect(readFileSync(victim, "utf8")).toBe("original-content")
      if (prev !== undefined) process.env.QUANTA_FS_JAIL = prev
    } finally {
      rmSync(jail, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("relative path resolves against ctx.cwd", async () => {
    writeFileSync(join(dir, "rel.txt"), "alpha beta alpha")
    const r = await run({ file: "rel.txt", pattern: "alpha", replacement: "gamma" })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "rel.txt"), "utf8")).toBe("gamma beta gamma")
  })

  test("schema rejects non-positive count", () => {
    expect(
      scriptedReplaceTool.inputSchema.safeParse({
        file: "f",
        pattern: "x",
        replacement: "y",
        count: 0,
      }).success,
    ).toBe(false)
    expect(
      scriptedReplaceTool.inputSchema.safeParse({
        file: "f",
        pattern: "x",
        replacement: "y",
        count: -1,
      }).success,
    ).toBe(false)
  })
})
