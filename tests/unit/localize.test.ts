import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localizeTool } from "../../src/tool/localize"
import type { ToolEvent } from "../../src/tool/types"

const drive = async (
  input: { query: string; path?: string; max_results?: number; verbose?: boolean },
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

/** Order of files as they appear in `output` (first occurrence wins). */
const fileOrder = (output: string): string[] => {
  const seen: string[] = []
  for (const line of output.split("\n")) {
    if (line.startsWith("  ")) {
      const m = line.match(/^ {2}(\S+):\d+/)
      if (m?.[1] && !seen.includes(m[1])) seen.push(m[1])
    }
  }
  return seen
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

  // --- R-Phase9 ---

  test("camelCase symmetry: `validateUser` matches `validateUserInput`", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(
        join(root, "service.ts"),
        "export const validateUserInput = (x: string) => x.length > 0\n",
      )
      const { output, ok } = await drive({ query: "validateUser" }, root)
      expect(ok).toBe(true)
      expect(output).toMatch(/service\.ts:1/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("snake↔camel symmetry: `validate_user` matches `validateUserInput`", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(
        join(root, "service.ts"),
        "export const validateUserInput = (x: string) => x.length > 0\n",
      )
      const { output, ok } = await drive({ query: "validate_user" }, root)
      expect(ok).toBe(true)
      expect(output).toMatch(/service\.ts:1/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("vendored penalty: src/ outranks node_modules/ for the same symbol", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      mkdirSync(join(root, "src"))
      mkdirSync(join(root, "node_modules"))
      mkdirSync(join(root, "node_modules", "lib"))
      writeFileSync(
        join(root, "src", "x.ts"),
        "export const validateToken = (t: string) => t.length > 0\n",
      )
      writeFileSync(
        join(root, "node_modules", "lib", "x.ts"),
        "export const validateToken = (t: string) => t.length > 0\n",
      )
      const { output, ok } = await drive({ query: "validateToken" }, root)
      expect(ok).toBe(true)
      const order = fileOrder(output)
      const srcIdx = order.findIndex((f) => f.includes("src/x.ts"))
      const nmIdx = order.findIndex((f) => f.includes("node_modules"))
      expect(srcIdx).toBeGreaterThanOrEqual(0)
      expect(nmIdx).toBeGreaterThanOrEqual(0)
      expect(srcIdx).toBeLessThan(nmIdx)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("def boost: definition site outranks call site", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(join(root, "a.ts"), "export const parseConfig = (x: string) => x\n")
      writeFileSync(join(root, "b.ts"), "import { parseConfig } from './a'\nparseConfig('y')\n")
      const { output, ok } = await drive({ query: "parseConfig" }, root)
      expect(ok).toBe(true)
      const order = fileOrder(output)
      const aIdx = order.findIndex((f) => f.endsWith("a.ts"))
      const bIdx = order.findIndex((f) => f.endsWith("b.ts"))
      expect(aIdx).toBeGreaterThanOrEqual(0)
      expect(bIdx).toBeGreaterThanOrEqual(0)
      expect(aIdx).toBeLessThan(bIdx)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("determinism: same inputs produce byte-identical output across runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(join(root, "a.ts"), "export const parseConfig = (x: string) => x\n")
      writeFileSync(join(root, "b.ts"), "import { parseConfig } from './a'\nparseConfig('y')\n")
      writeFileSync(
        join(root, "c.ts"),
        "export const validateUserInput = (x: string) => x.length > 0\n",
      )
      const a = await drive({ query: "parseConfig validateUser" }, root)
      const b = await drive({ query: "parseConfig validateUser" }, root)
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      expect(a.output).toBe(b.output)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("noise self-drop: a saturating token contributes zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      // 50 files each containing `commontoken` — that token will appear in
      // every file. Self-measured noise floor should zero its IDF (or treat
      // it as non-discriminating), so the file that ALSO contains the unique
      // `uniqsymbolxyz` token must rank at the top.
      for (let i = 0; i < 50; i++) {
        writeFileSync(join(root, `f${i}.ts`), "// commontoken\n")
      }
      writeFileSync(join(root, "winner.ts"), "// commontoken uniqsymbolxyz\n")
      const { output, ok } = await drive(
        { query: "commontoken uniqsymbolxyz", max_results: 60 },
        root,
      )
      expect(ok).toBe(true)
      const order = fileOrder(output)
      expect(order[0]).toContain("winner.ts")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("verbose flag toggles per-row score + tier", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(
        join(root, "auth_handler.ts"),
        "export const validateToken = (t: string) => t.length > 0\n",
      )
      const plain = await drive({ query: "validateToken" }, root)
      const verbose = await drive({ query: "validateToken", verbose: true }, root)
      expect(plain.ok).toBe(true)
      expect(verbose.ok).toBe(true)
      expect(plain.output).not.toContain("score=")
      expect(plain.output).not.toContain("tier=")
      expect(verbose.output).toContain("score=")
      expect(verbose.output).toContain("tier=user")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
