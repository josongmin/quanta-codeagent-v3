/**
 * Architecture guard for the `@/permission` slice (S4 hardening — mirror
 * of runner-slice-boundary.test.ts). `@/permission` depends on `@/shared`
 * only per RFC 3.1.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SLICE = "permission"
const SLICE_DIR = join(import.meta.dir, `../../src/${SLICE}`)

const listSliceTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listSliceTsFiles(full))
    else if (
      st.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".from-worktree") &&
      !name.includes(".my-backup")
    ) {
      out.push(full)
    }
  }
  return out.sort()
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const extractImports = (src: string): Array<{ line: number; spec: string }> => {
  const out: Array<{ line: number; spec: string }> = []
  const stripped = stripComments(src)
  const lines = stripped.split("\n")
  const re =
    /(?:^|\s)(?:import\s[\s\S]*?from\s+|import\s+|export\s[\s\S]*?from\s+)["']([^"']+)["']/g
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.length === 0) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex API
    while ((m = re.exec(line)) !== null) {
      out.push({ line: i + 1, spec: m[1] ?? "" })
    }
  }
  return out
}

const scanLines = (src: string, pattern: RegExp): Array<{ line: number; hit: string }> => {
  const out: Array<{ line: number; hit: string }> = []
  const stripped = stripComments(src)
  const lines = stripped.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.length === 0) continue
    const re = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex API
    while ((m = re.exec(line)) !== null) {
      out.push({ line: i + 1, hit: m[0] })
    }
  }
  return out
}

const SURFACE_PATTERNS = [/^@\/apps\b/, /(^|\/)apps\//, /(^|\/)src\/apps\//]
const SLICE_DENY = new Set<string>([
  "@/agent",
  "@/tool",
  "@/mcp",
  "@/rules",
  "@/migration",
  "@/memory",
  "@/session",
  "@/subagent",
  "@/skill",
  "@/observability",
  "@/llm",
  "@/lsp",
  "@/stream",
  "@/storage",
])
const isDenied = (spec: string): boolean => {
  if (SLICE_DENY.has(spec)) return true
  for (const d of SLICE_DENY) if (spec === d || spec.startsWith(`${d}/`)) return true
  return false
}
const NODE_SURFACE_MODULES = new Set<string>([
  "node:readline",
  "node:readline/promises",
  "node:tty",
  "node:repl",
])

/** `json-state-file.ts` writes a one-line `[quanta] permission-store: …`
 *  warning to `process.stderr` when the JSON state file can't be parsed.
 *  This is a last-resort fallback BEFORE any logger could be wired (the
 *  store is initialised at composition time). Named carve-out keeps audit
 *  honest. */
const STDIO_ALLOW_FILES = new Set<string>(["json-state-file.ts"])

describe(`@/${SLICE} — architecture guard`, () => {
  const files = listSliceTsFiles(SLICE_DIR)

  test("at least one file in the slice (sanity)", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  test("no apps/** imports", () => {
    const violations: string[] = []
    for (const f of files)
      for (const { line, spec } of extractImports(readFileSync(f, "utf8")))
        if (SURFACE_PATTERNS.some((p) => p.test(spec)))
          violations.push(`${relative(SLICE_DIR, f)}:${line}  import "${spec}"`)
    if (violations.length > 0)
      throw new Error(`@/${SLICE} must not import apps/**:\n\n${violations.join("\n")}`)
  })

  test("no deny-list imports", () => {
    const violations: string[] = []
    for (const f of files)
      for (const { line, spec } of extractImports(readFileSync(f, "utf8")))
        if (isDenied(spec))
          violations.push(`${relative(SLICE_DIR, f)}:${line}  import "${spec}"`)
    if (violations.length > 0)
      throw new Error(`@/${SLICE} deny-list violation:\n\n${violations.join("\n")}`)
  })

  test("no process.env / process.argv", () => {
    const violations: string[] = []
    const re = /\bprocess\.(env|argv)\b/g
    for (const f of files)
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), re))
        violations.push(`${relative(SLICE_DIR, f)}:${line}  ${hit}`)
    if (violations.length > 0)
      throw new Error(`@/${SLICE} must not read process.env/argv:\n\n${violations.join("\n")}`)
  })

  test("no process.stdin / stdout / stderr", () => {
    const violations: string[] = []
    const re = /\bprocess\.(stdin|stdout|stderr)\b/g
    for (const f of files) {
      const base = relative(SLICE_DIR, f)
      const leaf = base.split("/").pop() ?? base
      if (STDIO_ALLOW_FILES.has(leaf)) continue
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), re))
        violations.push(`${base}:${line}  ${hit}`)
    }
    if (violations.length > 0)
      throw new Error(`@/${SLICE} must not use raw process stdio:\n\n${violations.join("\n")}`)
  })

  test("no console.* calls", () => {
    const violations: string[] = []
    const re = /\bconsole\.(log|error|warn|info|debug|dir|trace)\s*\(/g
    for (const f of files)
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), re))
        violations.push(`${relative(SLICE_DIR, f)}:${line}  ${hit.replace(/\s*\($/, "(")}`)
    if (violations.length > 0)
      throw new Error(`@/${SLICE} must not call console.*:\n\n${violations.join("\n")}`)
  })

  test("no alt-runtime ENV/argv", () => {
    const violations: string[] = []
    const re =
      /\bBun\.(env|argv)\b|\bDeno\.(env\b|args\b)|\bimport\.meta\.env\b|\bglobalThis\.process\.(env|argv)\b/g
    for (const f of files)
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), re))
        violations.push(`${relative(SLICE_DIR, f)}:${line}  ${hit}`)
    if (violations.length > 0)
      throw new Error(`@/${SLICE} alt-runtime env:\n\n${violations.join("\n")}`)
  })

  test("no node:readline / tty / repl", () => {
    const violations: string[] = []
    for (const f of files)
      for (const { line, spec } of extractImports(readFileSync(f, "utf8")))
        if (NODE_SURFACE_MODULES.has(spec))
          violations.push(`${relative(SLICE_DIR, f)}:${line}  import "${spec}"`)
    if (violations.length > 0)
      throw new Error(`@/${SLICE} surface node module:\n\n${violations.join("\n")}`)
  })

  test('no node:process named imports', () => {
    const violations: string[] = []
    const re = /\bimport\s*(?:type\s*)?\{[^}]*\}\s*from\s+["']node:process["']/g
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      const lines = src.split("\n")
      re.lastIndex = 0
      let m: RegExpExecArray | null
      // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex API
      while ((m = re.exec(src)) !== null) {
        const lineNum = src.slice(0, m.index).split("\n").length
        violations.push(`${relative(SLICE_DIR, f)}:${lineNum}  ${(lines[lineNum - 1] ?? m[0]).trim()}`)
      }
    }
    if (violations.length > 0)
      throw new Error(`@/${SLICE} node:process named imports:\n\n${violations.join("\n")}`)
  })

  test(`slice barrel exists (src/${SLICE}/index.ts)`, () => {
    let ok = false
    try {
      ok = statSync(join(SLICE_DIR, "index.ts")).isFile()
    } catch {
      ok = false
    }
    if (!ok) throw new Error(`Slice barrel missing at src/${SLICE}/index.ts.`)
  })
})
