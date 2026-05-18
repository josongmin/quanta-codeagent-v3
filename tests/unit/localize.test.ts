import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localizeTool } from "../../src/tool/localize"
import type { ToolEvent } from "../../src/tool/types"

const drive = async (
  input: { query: string; path?: string; max_results?: number },
  cwd: string,
): Promise<{ progress: string[]; output: string; ok: boolean }> => {
  const progress: string[] = []
  let output = ""
  let ok = false
  for await (const ev of localizeTool.execute(input, {
    cwd,
    signal: new AbortController().signal,
  }) as AsyncIterable<ToolEvent>) {
    if (ev.type === "progress") progress.push(ev.message)
    else {
      output = ev.result.output
      ok = ev.result.ok
    }
  }
  return { progress, output, ok }
}

describe("localizeTool", () => {
  test("interface flags", () => {
    expect(localizeTool.isReadOnly()).toBe(true)
    expect(localizeTool.isConcurrencySafe({ query: "x" })).toBe(true)
  })

  test("ranks the file containing the planted symbol and respects max_results", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(
        join(root, "auth_handler.ts"),
        "export const validateToken = (t: string) => {\n  return t.length > 0\n}\n",
      )
      writeFileSync(join(root, "unrelated.ts"), "export const hello = 1\n")
      writeFileSync(join(root, "extra.ts"), "// validateToken mentioned in a comment too\n")

      const { progress, output, ok } = await drive(
        { query: "validateToken auth", max_results: 5 },
        root,
      )
      expect(ok).toBe(true)
      expect(progress).toContain("localizing: validateToken auth")
      expect(output).toContain("auth_handler.ts")
      expect(output).toMatch(/auth_handler\.ts:1/)
      // Capped: at most max_results data rows (lines starting with two spaces).
      const rows = output.split("\n").filter((l) => l.startsWith("  "))
      expect(rows.length).toBeLessThanOrEqual(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no-match yields ok with (no candidates)", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(join(root, "a.ts"), "const x = 1\n")
      const { output, ok } = await drive({ query: "zzzqqqnotpresent" }, root)
      expect(ok).toBe(true)
      expect(output).toContain("(no candidates)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("empty/too-short query → no candidates, still ok", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      const { output, ok } = await drive({ query: "a b" }, root)
      expect(ok).toBe(true)
      expect(output).toContain("(no candidates")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
