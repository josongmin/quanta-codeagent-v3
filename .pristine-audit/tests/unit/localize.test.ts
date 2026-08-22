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

  test("invalid input: overlong query is rejected before rg fan-out", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      const { output, ok } = await drive({ query: "abc ".repeat(1200) }, root)
      expect(ok).toBe(false)
      expect(output).toContain("invalid input:")
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

  test("invalid input: max_results above cap is rejected", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(join(root, "winner.ts"), "// uniqsymbolxyz\n")
      const { output, ok } = await drive({ query: "uniqsymbolxyz", max_results: 201 }, root)
      expect(ok).toBe(false)
      expect(output).toContain("invalid input:")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // --- R-Phase10 ---

  test("sibling-.js penalty: src/x.ts outranks identical-content src/x.js", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      mkdirSync(join(root, "src"))
      const body = "export const validateToken = (t: string) => t.length > 0\n"
      writeFileSync(join(root, "src", "auth.ts"), body)
      writeFileSync(join(root, "src", "auth.js"), body)
      const { output, ok } = await drive({ query: "validateToken" }, root)
      expect(ok).toBe(true)
      const order = fileOrder(output)
      const tsIdx = order.findIndex((f) => f.endsWith("auth.ts"))
      const jsIdx = order.findIndex((f) => f.endsWith("auth.js"))
      expect(tsIdx).toBeGreaterThanOrEqual(0)
      expect(jsIdx).toBeGreaterThanOrEqual(0)
      expect(tsIdx).toBeLessThan(jsIdx)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("sibling-.js penalty: NO false trigger across directories (full-path stem)", async () => {
    // `src/auth.ts` and `other/auth.js` share a basename but live in different
    // directories — full-path stems (`src/auth` vs `other/auth`) differ, so
    // the .js MUST NOT be penalized. We compare against a CONTROL run with a
    // true sibling (`src/auth.js`): the control's .js score must be exactly
    // 10 less than the no-trigger run's .js score (the only delta is the
    // sibling penalty firing). Same query, same .js content, same BM25 idf.
    const triggerRoot = mkdtempSync(join(tmpdir(), "localize-trigger-"))
    const controlRoot = mkdtempSync(join(tmpdir(), "localize-control-"))
    try {
      const body = "validateToken('seed')\n"
      // Trigger: cross-directory (no sibling) — stem mismatch ⇒ no penalty.
      mkdirSync(join(triggerRoot, "src"))
      mkdirSync(join(triggerRoot, "other"))
      writeFileSync(
        join(triggerRoot, "src", "auth.ts"),
        "export const validateToken = (t: string) => t.length > 0\n",
      )
      writeFileSync(join(triggerRoot, "other", "auth.js"), body)
      // Control: same dir (sibling) — stem match ⇒ penalty fires.
      mkdirSync(join(controlRoot, "src"))
      writeFileSync(
        join(controlRoot, "src", "auth.ts"),
        "export const validateToken = (t: string) => t.length > 0\n",
      )
      writeFileSync(join(controlRoot, "src", "auth.js"), body)

      const trigger = await drive({ query: "validateToken", verbose: true }, triggerRoot)
      const control = await drive({ query: "validateToken", verbose: true }, controlRoot)
      expect(trigger.ok).toBe(true)
      expect(control.ok).toBe(true)
      const scoreOf = (out: string, suffix: string): number => {
        const row = out.split("\n").find((l) => l.includes(suffix))
        const m = row?.match(/score=(-?\d+\.\d+)/)
        return Number(m?.[1])
      }
      const triggerJs = scoreOf(trigger.output, "other/auth.js:")
      const controlJs = scoreOf(control.output, "src/auth.js:")
      expect(Number.isFinite(triggerJs)).toBe(true)
      expect(Number.isFinite(controlJs)).toBe(true)
      // Penalty is exactly −10 when it fires; same .js content + same idf
      // ⇒ delta is exactly the penalty itself (no other ranking input
      // changes between the two roots).
      expect(triggerJs - controlJs).toBeCloseTo(10, 6)
    } finally {
      rmSync(triggerRoot, { recursive: true, force: true })
      rmSync(controlRoot, { recursive: true, force: true })
    }
  })

  test("sibling-.jsx penalty: .tsx outranks identical-content .jsx twin", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      mkdirSync(join(root, "src"))
      const body = "export const validateToken = (t) => t.length > 0\n"
      writeFileSync(join(root, "src", "auth.tsx"), body)
      writeFileSync(join(root, "src", "auth.jsx"), body)
      const { output, ok } = await drive({ query: "validateToken" }, root)
      expect(ok).toBe(true)
      const order = fileOrder(output)
      const tsxIdx = order.findIndex((f) => f.endsWith("auth.tsx"))
      const jsxIdx = order.findIndex((f) => f.endsWith("auth.jsx"))
      expect(tsxIdx).toBeGreaterThanOrEqual(0)
      expect(jsxIdx).toBeGreaterThanOrEqual(0)
      expect(tsxIdx).toBeLessThan(jsxIdx)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("sibling-.js penalty: no .ts siblings anywhere ⇒ .js NOT penalized", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(join(root, "auth.js"), "export const validateToken = (t) => t.length > 0\n")
      const { output, ok } = await drive({ query: "validateToken" }, root)
      expect(ok).toBe(true)
      // .js is the only candidate and ranks first — penalty must not have fired
      // (tsStems is empty because there are zero .ts files in the scope).
      const order = fileOrder(output)
      expect(order[0]).toContain("auth.js")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("omitted-count marker: ranked hits > max_results surface an accurate M (total − shown)", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      // 8 distinct files each containing the symbol once = 8 ranked hits.
      // max_results=3 ⇒ 3 shown, M = 8 − 3 = 5 omitted.
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(root, `mod${i}.ts`), `export const handleRequest${i} = () => 0\n`)
      }
      const { output, ok } = await drive({ query: "handleRequest", max_results: 3 }, root)
      expect(ok).toBe(true)
      const rows = output.split("\n").filter((l) => l.startsWith("  "))
      expect(rows.length).toBe(3)
      // Marker present with the EXACT omitted count (5), and teeth: removing the
      // marker line would fail this assertion.
      expect(output).toContain("(5 lower-ranked candidates omitted")
      expect(output).toMatch(/raise max_results/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("omitted-count marker: a vendored hit pushed past the cap is COUNTED in M, not silently dropped", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      mkdirSync(join(root, "src"))
      mkdirSync(join(root, "node_modules"))
      // Two user-code hits + one vendored hit = 3 ranked. max_results=2 keeps the
      // two user hits (vendored is down-ranked −50) and omits the vendored one,
      // but it MUST be counted: M = 3 − 2 = 1.
      writeFileSync(join(root, "src", "a.ts"), "export const validateToken = (t: string) => 1\n")
      writeFileSync(join(root, "src", "b.ts"), "export const validateToken2 = (t: string) => 2\n")
      writeFileSync(
        join(root, "node_modules", "dep.ts"),
        "export const validateToken3 = (t: string) => 3\n",
      )
      const { output, ok } = await drive({ query: "validateToken", max_results: 2 }, root)
      expect(ok).toBe(true)
      // The vendored hit is omitted from the visible rows…
      expect(output).not.toContain("node_modules")
      // …but its count is surfaced (M = 1, singular form), so it is NOT silently
      // withheld. Teeth: a buggy slice that forgot the penalized hit would yield
      // M=0 (no marker) and fail this.
      expect(output).toContain("(1 lower-ranked candidate omitted")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no marker when ranked hits fit within max_results (no false omission claim)", async () => {
    const root = mkdtempSync(join(tmpdir(), "localize-"))
    try {
      writeFileSync(join(root, "only.ts"), "export const uniqsymbolxyz = () => 1\n")
      const { output, ok } = await drive({ query: "uniqsymbolxyz", max_results: 20 }, root)
      expect(ok).toBe(true)
      expect(output).not.toContain("omitted")
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
