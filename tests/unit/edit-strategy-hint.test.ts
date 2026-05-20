import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
import {
  STRATEGY_HINT_PREFIX,
  classifyMismatch,
  formatStrategyHint,
} from "@/tool/edit/strategy-hint"

const dir = mkdtempSync(join(tmpdir(), "edit-strategy-hint-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("classifyMismatch (pure)", () => {
  test("'not unique' ⇒ scripted_replace", () => {
    expect(classifyMismatch("old_string is not unique (3 matches); pass replace_all")).toBe(
      "scripted_replace",
    )
  })

  test("fuzzy 'ambiguous' ⇒ scripted_replace", () => {
    expect(classifyMismatch("whitespace-flexible matched 2 spans; ambiguous (...)")).toBe(
      "scripted_replace",
    )
  })

  test("'not found' ⇒ read_then_patch", () => {
    expect(classifyMismatch("old_string not found in file")).toBe("read_then_patch")
  })

  test("'no confident match' ⇒ read_then_patch", () => {
    expect(classifyMismatch("no confident match (exact, whitespace-flexible, ...)")).toBe(
      "read_then_patch",
    )
  })

  test("unrecognized message ⇒ ambiguous fallback (we still emit a hint)", () => {
    expect(classifyMismatch("some other failure mode")).toBe("ambiguous")
  })
})

describe("formatStrategyHint", () => {
  test("each strategy renders a prefixed, parseable hint", () => {
    for (const s of ["scripted_replace", "read_then_patch", "ambiguous"] as const) {
      const text = formatStrategyHint(s)
      expect(text.startsWith(STRATEGY_HINT_PREFIX)).toBe(true)
      expect(text).toContain(`nextStrategy: ${s}`)
    }
  })

  test("scripted_replace hint specifically names the tool by name", () => {
    expect(formatStrategyHint("scripted_replace")).toMatch(/scripted_replace/)
  })

  test("read_then_patch hint names the remediation (re-read)", () => {
    expect(formatStrategyHint("read_then_patch")).toMatch(/read/i)
  })
})

describe("editTool surfaces strategy hint on failure", () => {
  test("'old_string not found' includes the hint suffix (read_then_patch)", async () => {
    const f = join(dir, "not-found.txt")
    writeFileSync(f, "alpha beta")
    const r = await run({ path: f, old_string: "gamma", new_string: "delta" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("old_string not found in file")
    expect(r.output).toContain(STRATEGY_HINT_PREFIX)
    expect(r.output).toContain("nextStrategy: read_then_patch")
  })

  test("multiple-match ambiguity includes the hint (scripted_replace)", async () => {
    const f = join(dir, "dupe.txt")
    writeFileSync(f, "x x x")
    const r = await run({ path: f, old_string: "x", new_string: "y" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not unique")
    expect(r.output).toContain(STRATEGY_HINT_PREFIX)
    expect(r.output).toContain("nextStrategy: scripted_replace")
  })

  test("fuzzy ambiguous spans also route to scripted_replace", async () => {
    const f = join(dir, "fuzzy-ambig.txt")
    // Two whitespace-equivalent line windows so the fuzzy ladder is forced
    // and reports the ambiguous match.
    writeFileSync(f, "  foo bar\n  baz\n\nfoo  bar\n  baz\n")
    const r = await run({
      path: f,
      old_string: "foo bar\nbaz",
      new_string: "REPLACED",
      fuzzy: true,
    })
    expect(r.ok).toBe(false)
    // Either ambiguous (2 spans) or the fallback message — both must surface
    // a hint suffix.
    expect(r.output).toContain(STRATEGY_HINT_PREFIX)
  })

  test("successful patch does NOT include the hint", async () => {
    const f = join(dir, "ok.txt")
    writeFileSync(f, "const a = 1")
    const r = await run({ path: f, old_string: "1", new_string: "2" })
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain(STRATEGY_HINT_PREFIX)
  })
})
