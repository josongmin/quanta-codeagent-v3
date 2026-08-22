import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"

/**
 * H12 e2e hellgate — drive the real `edit` tool against a real tmp file that
 * contains repeated code. Prove on DISK that a `line_ranges`-scoped edit mutates
 * ONLY the targeted occurrence, and that the same ambiguous input WITHOUT a
 * range fails with the line-count hint (no disk mutation).
 */

const dir = mkdtempSync(join(tmpdir(), "edit-lr-e2e-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// Real-ish source: three identical helper functions; only the middle one (in a
// known line window) should be touched.
const SOURCE = [
  "function helperA() {", //   1
  "  return compute(x)", //    2
  "}", //                      3
  "", //                       4
  "function helperB() {", //   5
  "  return compute(x)", //    6
  "}", //                      7
  "", //                       8
  "function helperC() {", //   9
  "  return compute(x)", //   10
  "}", //                     11
].join("\n")

describe("H12 e2e — disk-level scoped edit on repeated code", () => {
  test("line_ranges selecting the middle copy edits ONLY it on disk", async () => {
    const f = join(dir, "helpers.ts")
    writeFileSync(f, SOURCE)

    // The middle `return compute(x)` is line 6.
    const r = await run({
      path: f,
      old_string: "  return compute(x)",
      new_string: "  return compute(y)",
      line_ranges: [{ start: 5, end: 7 }],
    })
    expect(r.ok).toBe(true)

    const onDisk = readFileSync(f, "utf8").split("\n")
    expect(onDisk[1]).toBe("  return compute(x)") // helperA untouched
    expect(onDisk[5]).toBe("  return compute(y)") // helperB edited
    expect(onDisk[9]).toBe("  return compute(x)") // helperC untouched
    // Exactly one occurrence changed.
    expect(readFileSync(f, "utf8").split("compute(y)").length - 1).toBe(1)
    expect(readFileSync(f, "utf8").split("compute(x)").length - 1).toBe(2)
  })

  test("same ambiguous input WITHOUT line_ranges fails with the line-count hint + no disk change", async () => {
    const f = join(dir, "helpers-noscope.ts")
    writeFileSync(f, SOURCE)

    const r = await run({
      path: f,
      old_string: "  return compute(x)",
      new_string: "  return compute(y)",
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("not_found")
    // Paired improvement: ambiguous failure tells the model how many lines the
    // file has so it can pick a line_ranges value on retry.
    expect(r.output).toContain("the file has 11 lines")
    // Nothing written.
    expect(readFileSync(f, "utf8")).toBe(SOURCE)
  })

  test("retry of the SAME file with a line_ranges value derived from the hint succeeds", async () => {
    const f = join(dir, "helpers-retry.ts")
    writeFileSync(f, SOURCE)

    // First attempt fails ambiguous (no range).
    const fail = await run({
      path: f,
      old_string: "  return compute(x)",
      new_string: "  return compute(z)",
    })
    expect(fail.ok).toBe(false)

    // Model picks the first window (lines 1-3) from the hint; succeeds.
    const ok = await run({
      path: f,
      old_string: "  return compute(x)",
      new_string: "  return compute(z)",
      line_ranges: [{ start: 1, end: 3 }],
    })
    expect(ok.ok).toBe(true)
    const onDisk = readFileSync(f, "utf8").split("\n")
    expect(onDisk[1]).toBe("  return compute(z)") // helperA edited
    expect(onDisk[5]).toBe("  return compute(x)") // helperB untouched
    expect(onDisk[9]).toBe("  return compute(x)") // helperC untouched
  })
})
