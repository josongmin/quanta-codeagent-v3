/**
 * Shared slice-boundary scanner (S4 hardening). One engine, per-slice config in
 * `slice-boundary-configs.ts`. Individual `*-slice-boundary.test.ts` files are
 * thin evidence/catalog entrypoints only.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../..")

export interface SliceBoundaryConfig {
  readonly slice: string
  /** Import specifiers denied under this slice (exact or `@/slice/...` prefix). */
  readonly denyImports: readonly string[]
  readonly stdioAllowFiles?: readonly string[]
  readonly envAllowFiles?: readonly string[]
  readonly consoleAllowFiles?: readonly string[]
  /** Skip `.from-worktree` / `.my-backup` filename carve-outs (runner/ipc). */
  readonly includeBackupArtifacts?: boolean
  /** Require `src/<slice>/index.ts`. */
  readonly requireSliceBarrel?: boolean
  /** Require sub-slice barrels relative to `src/<slice>/`. */
  readonly requireSubSliceBarrels?: readonly string[]
}

const SURFACE_PATTERNS = [/^@\/apps\b/, /(^|\/)apps\//, /(^|\/)src\/apps\//] as const

const NODE_SURFACE_MODULES = new Set<string>([
  "node:readline",
  "node:readline/promises",
  "node:tty",
  "node:repl",
])

export const sliceDir = (slice: string): string => join(REPO_ROOT, "src", slice)

export const listSliceTsFiles = (dir: string, includeBackupArtifacts: boolean): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listSliceTsFiles(full, includeBackupArtifacts))
    } else if (st.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      if (
        !includeBackupArtifacts &&
        (name.includes(".from-worktree") || name.includes(".my-backup"))
      ) {
        continue
      }
      out.push(full)
    }
  }
  return out.sort()
}

export const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

export const extractImports = (src: string): Array<{ line: number; spec: string }> => {
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

export const scanLines = (
  src: string,
  pattern: RegExp,
): Array<{ line: number; hit: string }> => {
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

const isDeniedImport = (spec: string, deny: ReadonlySet<string>): boolean => {
  if (deny.has(spec)) return true
  for (const d of deny) {
    if (spec === d || spec.startsWith(`${d}/`)) return true
  }
  return false
}

const leafName = (sliceDirPath: string, filePath: string): string => {
  const base = relative(sliceDirPath, filePath)
  return base.split("/").pop() ?? base
}

/** Register the standard architecture-guard battery for one slice config. */
export const registerSliceBoundarySuite = (config: SliceBoundaryConfig): void => {
  const dir = sliceDir(config.slice)
  const deny = new Set(config.denyImports)
  const stdioAllow = new Set(config.stdioAllowFiles ?? [])
  const envAllow = new Set(config.envAllowFiles ?? [])
  const consoleAllow = new Set(config.consoleAllowFiles ?? [])
  const includeBackup = config.includeBackupArtifacts ?? false

  describe(`@/${config.slice} — architecture guard`, () => {
    const files = listSliceTsFiles(dir, includeBackup)

    test("at least one file in the slice (sanity)", () => {
      expect(files.length).toBeGreaterThan(0)
    })

    test("no file imports from any `apps/**` (surface isolation)", () => {
      const violations: string[] = []
      for (const f of files) {
        for (const { line, spec } of extractImports(readFileSync(f, "utf8"))) {
          if (SURFACE_PATTERNS.some((p) => p.test(spec))) {
            violations.push(`${relative(dir, f)}:${line}  import "${spec}"`)
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not import from apps/**:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no file imports from the slice deny-list", () => {
      const violations: string[] = []
      for (const f of files) {
        for (const { line, spec } of extractImports(readFileSync(f, "utf8"))) {
          if (isDeniedImport(spec, deny)) {
            violations.push(`${relative(dir, f)}:${line}  import "${spec}"`)
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(`@/${config.slice} deny-list violation:\n\n${violations.join("\n")}`)
      }
    })

    test("no file reads process.env or process.argv (must take plain config)", () => {
      const violations: string[] = []
      const procRe = /\bprocess\.(env|argv)\b/g
      for (const f of files) {
        const leaf = leafName(dir, f)
        if (envAllow.has(leaf)) continue
        for (const { line, hit } of scanLines(readFileSync(f, "utf8"), procRe)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not read process.env / process.argv:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no file touches process.stdin / process.stdout / process.stderr", () => {
      const violations: string[] = []
      const stdioRe = /\bprocess\.(stdin|stdout|stderr)\b/g
      for (const f of files) {
        const leaf = leafName(dir, f)
        if (stdioAllow.has(leaf)) continue
        for (const { line, hit } of scanLines(readFileSync(f, "utf8"), stdioRe)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not access raw process stdio:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no file calls console.log / error / warn / info / debug / dir / trace", () => {
      const violations: string[] = []
      const consoleRe = /\bconsole\.(log|error|warn|info|debug|dir|trace)\s*\(/g
      for (const f of files) {
        const leaf = leafName(dir, f)
        if (consoleAllow.has(leaf)) continue
        for (const { line, hit } of scanLines(readFileSync(f, "utf8"), consoleRe)) {
          violations.push(
            `${relative(dir, f)}:${line}  ${hit.replace(/\s*\($/, "(")}`,
          )
        }
      }
      if (violations.length > 0) {
        throw new Error(`@/${config.slice} must not call console.*:\n\n${violations.join("\n")}`)
      }
    })

    test("no alt-runtime ENV/argv (Bun / Deno / import.meta.env / globalThis.process.*)", () => {
      const violations: string[] = []
      const altRe =
        /\bBun\.(env|argv)\b|\bDeno\.(env\b|args\b)|\bimport\.meta\.env\b|\bglobalThis\.process\.(env|argv)\b/g
      for (const f of files) {
        for (const { line, hit } of scanLines(readFileSync(f, "utf8"), altRe)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not read alt-runtime ENV/argv:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no surface-coupled node modules (node:readline / tty / repl)", () => {
      const violations: string[] = []
      for (const f of files) {
        for (const { line, spec } of extractImports(readFileSync(f, "utf8"))) {
          if (NODE_SURFACE_MODULES.has(spec)) {
            violations.push(`${relative(dir, f)}:${line}  import "${spec}"`)
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not import CLI-coupled node modules:\n\n${violations.join("\n")}`,
        )
      }
    })

    test('no `node:process` named imports', () => {
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
          violations.push(
            `${relative(dir, f)}:${lineNum}  ${(lines[lineNum - 1] ?? m[0]).trim()}`,
          )
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not use named imports from "node:process":\n\n${violations.join("\n")}`,
        )
      }
    })

    if (config.requireSliceBarrel) {
      test(`slice barrel exists (src/${config.slice}/index.ts)`, () => {
        let ok = false
        try {
          ok = statSync(join(dir, "index.ts")).isFile()
        } catch {
          ok = false
        }
        if (!ok) {
          throw new Error(`Slice barrel missing at src/${config.slice}/index.ts.`)
        }
      })
    }

    if (config.requireSubSliceBarrels && config.requireSubSliceBarrels.length > 0) {
      test(`sub-slice barrels exist (${config.requireSubSliceBarrels.join(", ")})`, () => {
        const missing = config.requireSubSliceBarrels!.filter((p) => {
          try {
            return !statSync(join(dir, p)).isFile()
          } catch {
            return true
          }
        })
        if (missing.length > 0) {
          throw new Error(
            `Sub-slice barrels missing under src/${config.slice}/: ${missing.join(", ")}`,
          )
        }
      })
    }
  })
}
