/**
 * Architecture guard for the `@/agent` slice — mirror of
 * `tests/unit/runner-slice-boundary.test.ts` (S4 hardening: extend the
 * 10-invariant runtime guard from runner/ipc to every library slice).
 *
 * `@/agent` is the assembly point that LEGITIMATELY reaches every peer
 * library slice (`@/tool`, `@/memory`, `@/llm`, …). So the slice deny-list
 * is narrow: it only blocks one-off translator / surface-adjacent slices
 * (`@/migration`) and the apps surface.
 *
 * Invariants 1-9 (see runner-slice-boundary for the full rationale). #10
 * (sub-slice barrels) is skipped: `@/agent` has many sub-folders but no
 * required barrel layout — sub-files import each other directly.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SLICE = "agent"
const SLICE_DIR = join(import.meta.dir, `../../src/${SLICE}`)

/** Recursively enumerate every `*.ts` file under the slice (excluding
 *  `.d.ts`, `.from-worktree.*`, `.my-backup.*` carve-outs that are not
 *  shipped source). */
const listSliceTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listSliceTsFiles(full))
    } else if (
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

/** Slice deny-list — conservative: only block translator + truly-cross-cutting
 *  surfaces. `@/agent` legitimately reaches every other library slice. */
const SLICE_DENY = new Set<string>(["@/migration"])

const isDenied = (spec: string): boolean => {
  if (SLICE_DENY.has(spec)) return true
  for (const denied of SLICE_DENY) {
    if (spec === denied || spec.startsWith(`${denied}/`)) return true
  }
  return false
}

const NODE_SURFACE_MODULES = new Set<string>([
  "node:readline",
  "node:readline/promises",
  "node:tty",
  "node:repl",
])

/** Explicit per-file allowlists for legitimate stderr-write fallbacks.
 *  Each entry must be a named carve-out (no regex) so audits stay honest. */
const STDIO_ALLOW_FILES = new Set<string>([
  // Both files write to `process.stderr` as a last-resort warn fallback
  // (HITL onHandoff throw / overrides parse failure). Routing these through
  // `@/shared#logger` would itself depend on `process.stderr` — same effect,
  // longer call chain. Kept as named carve-outs so any new use is flagged.
  "admissibility-gate.ts",
  "hitl-tier-registry.ts",
])

describe(`@/${SLICE} — architecture guard`, () => {
  const files = listSliceTsFiles(SLICE_DIR)

  test("at least one file in the slice (sanity)", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  test("no file imports from any `apps/**` (surface isolation)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (SURFACE_PATTERNS.some((p) => p.test(spec))) {
          violations.push(`${relative(SLICE_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not import from apps/** (surface isolation):\n\n${violations.join(
          "\n",
        )}\n\nMove ENV/argv/HTTP/IPC parsing into the surface entry and pass typed config in.`,
      )
    }
  })

  test("no file imports from the deny-list (@/migration)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (isDenied(spec)) {
          violations.push(`${relative(SLICE_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} deny-list violation:\n\n${violations.join(
          "\n",
        )}\n\nIf you genuinely need it here, widen the carve-out in this test + biome.json AND document the rationale.`,
      )
    }
  })

  test("no file reads process.env or process.argv (must take plain config)", () => {
    const violations: string[] = []
    const procRe = /\bprocess\.(env|argv)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), procRe)) {
        violations.push(`${relative(SLICE_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not read process.env / process.argv directly:\n\n${violations.join(
          "\n",
        )}\n\nFix: take typed config; the surface entry maps env → config and passes it in.`,
      )
    }
  })

  test("no file touches process.stdin / process.stdout / process.stderr (use injected port)", () => {
    const violations: string[] = []
    const stdioRe = /\bprocess\.(stdin|stdout|stderr)\b/g
    for (const f of files) {
      const base = relative(SLICE_DIR, f)
      const leaf = base.split("/").pop() ?? base
      if (STDIO_ALLOW_FILES.has(leaf)) continue
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), stdioRe)) {
        violations.push(`${base}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not access raw process stdio (use WriteSink / @/shared#logger):\n\n${violations.join(
          "\n",
        )}\n\nIf this is a genuine last-resort fallback, add the file to STDIO_ALLOW_FILES with a justifying comment.`,
      )
    }
  })

  test("no file calls console.log / error / warn / info / debug / dir / trace", () => {
    const violations: string[] = []
    const consoleRe = /\bconsole\.(log|error|warn|info|debug|dir|trace)\s*\(/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), consoleRe)) {
        violations.push(`${relative(SLICE_DIR, f)}:${line}  ${hit.replace(/\s*\($/, "(")}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not call console.* directly — surface-specific output:\n\n${violations.join(
          "\n",
        )}\n\nRoute through @/shared#logger or an injected log port.`,
      )
    }
  })

  test("no alt-runtime ENV/argv (Bun.env / Deno.env / import.meta.env / globalThis.process.*)", () => {
    const violations: string[] = []
    const altRe =
      /\bBun\.(env|argv)\b|\bDeno\.(env\b|args\b)|\bimport\.meta\.env\b|\bglobalThis\.process\.(env|argv)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), altRe)) {
        violations.push(`${relative(SLICE_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not read alt-runtime ENV/argv (same surface-coupling rule as process.env):\n\n${violations.join(
          "\n",
        )}`,
      )
    }
  })

  test("no surface-coupled node modules (node:readline / readline/promises / tty / repl)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (NODE_SURFACE_MODULES.has(spec)) {
          violations.push(`${relative(SLICE_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not import CLI-specific node modules:\n\n${violations.join("\n")}`,
      )
    }
  })

  test('no `node:process` named imports (literal-rename bypass of process.* invariants)', () => {
    const violations: string[] = []
    const namedRe = /\bimport\s*(?:type\s*)?\{[^}]*\}\s*from\s+["']node:process["']/g
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      const lines = src.split("\n")
      namedRe.lastIndex = 0
      let m: RegExpExecArray | null
      // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex API
      while ((m = namedRe.exec(src)) !== null) {
        const lineNum = src.slice(0, m.index).split("\n").length
        const snippet = (lines[lineNum - 1] ?? m[0]).trim()
        violations.push(`${relative(SLICE_DIR, f)}:${lineNum}  ${snippet}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/${SLICE} must not use named imports from "node:process":\n\n${violations.join("\n")}`,
      )
    }
  })

  test("slice barrel exists (src/agent/index.ts)", () => {
    let ok = false
    try {
      ok = statSync(join(SLICE_DIR, "index.ts")).isFile()
    } catch {
      ok = false
    }
    if (!ok) {
      throw new Error("Slice barrel missing at src/agent/index.ts.")
    }
  })
})
