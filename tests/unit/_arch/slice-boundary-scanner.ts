/**
 * Shared slice-boundary scanner (S4 hardening). One engine, per-slice config in
 * `slice-boundary-configs.ts`. Individual `*-slice-boundary.test.ts` files are
 * thin evidence/catalog entrypoints only.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const REPO_ROOT = join(import.meta.dir, "../../..")

export interface SliceBoundaryConfig {
  readonly slice: string
  /** Import specifiers denied under this slice (exact or `@/slice/...` prefix). */
  readonly denyImports: readonly string[]
  /** Documented carve-outs: imports that match a `denyImports` prefix but are
   *  explicitly allowed as named sub-barrels. Use sparingly — each entry is a
   *  declared cross-slice contract that must be defended at review time. */
  readonly allowImports?: readonly string[]
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

const parseSourceFile = (src: string): ts.SourceFile =>
  ts.createSourceFile("slice-boundary-scanner.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const lineOf = (sf: ts.SourceFile, pos: number): number =>
  sf.getLineAndCharacterOfPosition(pos).line + 1

const isPropertyAccessLike = (
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.PropertyAccessChain =>
  ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)

const getNodeLabel = (node: ts.Node): string | null => {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
    return node.getText()
  }
  return null
}

const matchesMember = (node: ts.Node, objectName: string, propertyName: string): boolean =>
  isPropertyAccessLike(node) &&
  getNodeLabel(node.expression) === objectName &&
  node.name.text === propertyName

const collectAstHits = (
  src: string,
  matcher: (node: ts.Node, sf: ts.SourceFile) => string | null,
): Array<{ line: number; hit: string }> => {
  const sf = parseSourceFile(src)
  const out: Array<{ line: number; hit: string }> = []
  const visit = (node: ts.Node): void => {
    const hit = matcher(node, sf)
    if (hit) out.push({ line: lineOf(sf, node.getStart(sf)), hit })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

export const extractImports = (src: string): Array<{ line: number; spec: string }> => {
  const out: Array<{ line: number; spec: string }> = []
  const sf = parseSourceFile(src)
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      // Skip `import type { X } from "..."` — type-only imports are erased
      // at compile time and don't create runtime cross-slice coupling.
      // (Slice purity invariant is about RUNTIME deps, not type shape contracts.)
      if (node.importClause?.isTypeOnly) {
        ts.forEachChild(node, visit)
        return
      }
      out.push({
        line: lineOf(sf, node.getStart(sf)),
        spec: node.moduleSpecifier.text,
      })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      // Same rule for `export type { X } from "..."`.
      if (node.isTypeOnly) {
        ts.forEachChild(node, visit)
        return
      }
      out.push({
        line: lineOf(sf, node.getStart(sf)),
        spec: node.moduleSpecifier.text,
      })
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const [firstArg] = node.arguments
      if (firstArg && ts.isStringLiteralLike(firstArg)) {
        out.push({
          line: lineOf(sf, node.getStart(sf)),
          spec: firstArg.text,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
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

const isDeniedImport = (
  spec: string,
  deny: ReadonlySet<string>,
  allow: ReadonlySet<string>,
): boolean => {
  // Allow-list checked first: documented carve-outs override deny prefix.
  if (allow.has(spec)) return false
  for (const a of allow) {
    if (spec === a || spec.startsWith(`${a}/`)) return false
  }
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

const scanProcessEnvArgv = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!isPropertyAccessLike(node)) return null
    if (!matchesMember(node, "process", "env") && !matchesMember(node, "process", "argv")) {
      return null
    }
    return node.expression.getText() === "process" ? `process.${node.name.text}` : null
  })

const scanProcessStdio = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!isPropertyAccessLike(node)) return null
    if (
      !matchesMember(node, "process", "stdin") &&
      !matchesMember(node, "process", "stdout") &&
      !matchesMember(node, "process", "stderr")
    ) {
      return null
    }
    return node.expression.getText() === "process" ? `process.${node.name.text}` : null
  })

const scanConsoleCalls = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!ts.isCallExpression(node) || !isPropertyAccessLike(node.expression)) return null
    const callee = node.expression
    if (getNodeLabel(callee.expression) !== "console") return null
    const method = callee.name.text
    if (!["log", "error", "warn", "info", "debug", "dir", "trace"].includes(method)) {
      return null
    }
    return `console.${method}(`
  })

const scanAltRuntimeEnvArgv = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!isPropertyAccessLike(node)) return null
    if (matchesMember(node, "Bun", "env") || matchesMember(node, "Bun", "argv")) {
      return `Bun.${node.name.text}`
    }
    if (matchesMember(node, "Deno", "env") || matchesMember(node, "Deno", "args")) {
      return `Deno.${node.name.text}`
    }
    if (matchesMember(node, "import.meta", "env")) {
      return "import.meta.env"
    }
    if (
      (node.name.text === "env" || node.name.text === "argv") &&
      isPropertyAccessLike(node.expression) &&
      matchesMember(node.expression, "globalThis", "process")
    ) {
      return `globalThis.process.${node.name.text}`
    }
    return null
  })

const scanNodeProcessNamedImports = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause || !node.moduleSpecifier) return null
    if (
      !ts.isStringLiteralLike(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "node:process"
    ) {
      return null
    }
    const bindings = node.importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return null
    return node.getText().replace(/\s+/g, " ").trim()
  })

/** Register the standard architecture-guard battery for one slice config. */
export const registerSliceBoundarySuite = (config: SliceBoundaryConfig): void => {
  const dir = sliceDir(config.slice)
  // Strip self-imports from deny-list: a slice referencing its own files via
  // `@/<slice>/X` is intra-slice (not a peer-library crossing). PEER_LIBRARY_DENY
  // lists every slice for cross-slice isolation; this filter makes self-import
  // intent universal without per-slice config maintenance.
  const selfPrefix = `@/${config.slice}`
  const deny = new Set(config.denyImports.filter((d) => d !== selfPrefix))
  const allow = new Set(config.allowImports ?? [])
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
          if (isDeniedImport(spec, deny, allow)) {
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
      for (const f of files) {
        const leaf = leafName(dir, f)
        if (envAllow.has(leaf)) continue
        for (const { line, hit } of scanProcessEnvArgv(readFileSync(f, "utf8"))) {
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
      for (const f of files) {
        const leaf = leafName(dir, f)
        if (stdioAllow.has(leaf)) continue
        for (const { line, hit } of scanProcessStdio(readFileSync(f, "utf8"))) {
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
      for (const f of files) {
        const leaf = leafName(dir, f)
        if (consoleAllow.has(leaf)) continue
        for (const { line, hit } of scanConsoleCalls(readFileSync(f, "utf8"))) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(`@/${config.slice} must not call console.*:\n\n${violations.join("\n")}`)
      }
    })

    test("no alt-runtime ENV/argv (Bun / Deno / import.meta.env / globalThis.process.*)", () => {
      const violations: string[] = []
      for (const f of files) {
        for (const { line, hit } of scanAltRuntimeEnvArgv(readFileSync(f, "utf8"))) {
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
      for (const f of files) {
        for (const { line, hit } of scanNodeProcessNamedImports(readFileSync(f, "utf8"))) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
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
