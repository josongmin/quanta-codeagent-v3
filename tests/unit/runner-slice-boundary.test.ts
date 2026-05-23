/**
 * Architecture guard for the `@/runner` slice (RFC may-22 §X — Layer-2
 * surface-agnostic orchestration).
 *
 * Invariants enforced here:
 *
 *   1. **Surface isolation** — no file under `src/runner/**` may import from
 *      `apps/**` (or `src/apps/**`). Surface entries (CLI/Web/Tauri) depend
 *      ON `@/runner`, never the reverse. This is also enforced by biome.json's
 *      slice-isolation rule, but a runtime test gives a clearer failure with
 *      file:line + the offending specifier.
 *
 *   2. **Slice deny-list** — runner must not reach `@/rules` / `@/patch` /
 *      `@/migration` directly (those slices have narrower owners — see
 *      biome.json). Mirrors the lint rule with a runtime check.
 *
 *   3. **No `process.env` / `process.argv` reads** — runner is the
 *      surface-AGNOSTIC layer. ENV/argv parsing belongs in the surface entry;
 *      the runner takes plain typed config. (Test seams like
 *      `runtimeConfig()` from `@/shared` are allowed because they encapsulate
 *      env behind a port.)
 *
 *   4. **Sub-slice barrels** — every `src/runner/<subslice>/index.ts` must
 *      exist (assemble/, orchestrate/, session-ops/), so consumers always
 *      depend on the slice contract, not internal file paths.
 *
 * Each failure cites file:line + offending specifier so a future refactor
 * regression is one-step diagnosable.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "bun:test"

const RUNNER_DIR = join(import.meta.dir, "../../src/runner")

/** Recursively enumerate every `*.ts` file under `src/runner/`. */
const listRunnerTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listRunnerTsFiles(full))
    } else if (st.isFile() && name.endsWith(".ts")) {
      out.push(full)
    }
  }
  return out.sort()
}

/** Strip block comments `/* ... *​/` and line comments `// ...` so a string
 *  literal mentioning `apps/` inside a docstring doesn't false-positive. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Extract `(lineNumber, specifier)` for every `import ... "X"` or
 *  `from "X"` token in `src`. */
const extractImports = (src: string): Array<{ line: number; spec: string }> => {
  const out: Array<{ line: number; spec: string }> = []
  const stripped = stripComments(src)
  const lines = stripped.split("\n")
  const re = /(?:^|\s)(?:import\s[\s\S]*?from\s+|import\s+|export\s[\s\S]*?from\s+)["']([^"']+)["']/g
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

const SURFACE_PATTERNS = [
  /^@\/apps\b/, // @/apps/* alias (none today, but guard anyway)
  /(^|\/)apps\//, // bare relative `../../apps/...` or any `apps/...` segment
  /(^|\/)src\/apps\//, // explicit src/apps prefix
]

const SLICE_DENY = new Set<string>([
  "@/rules",
  "@/patch",
  "@/migration",
])

const isDenied = (spec: string): boolean => {
  if (SLICE_DENY.has(spec)) return true
  // Match `@/rules/...`, `@/patch/...`, `@/migration/...` subpaths too.
  for (const denied of SLICE_DENY) {
    if (spec === denied || spec.startsWith(`${denied}/`)) return true
  }
  return false
}

describe("@/runner — architecture guard", () => {
  const files = listRunnerTsFiles(RUNNER_DIR)

  test("at least one file in the slice (sanity)", () => {
    // Catch a future accidental delete of the whole slice (test silently
    // would 0-pass otherwise).
    expect(files.length).toBeGreaterThan(0)
  })

  test("no file imports from any `apps/**` (surface isolation)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      const imports = extractImports(src)
      for (const { line, spec } of imports) {
        for (const pat of SURFACE_PATTERNS) {
          if (pat.test(spec)) {
            violations.push(`${relative(RUNNER_DIR, f)}:${line}  import "${spec}"`)
            break
          }
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner is Layer-2 surface-AGNOSTIC. It must NOT import from any apps/**:\n\n${violations.join(
          "\n",
        )}\n\nMove ENV/argv/HTTP/IPC parsing into the surface (apps/cli, apps/web, …) and pass typed config into @/runner.`,
      )
    }
  })

  test("no file imports from the runner deny-list (@/rules / @/patch / @/migration)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      const imports = extractImports(src)
      for (const { line, spec } of imports) {
        if (isDenied(spec)) {
          violations.push(`${relative(RUNNER_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner deny-list violation. The following slices must be reached only via @/agent:\n\n${violations.join(
          "\n",
        )}\n\nIf you genuinely need them here, the right fix is to (a) widen the corresponding library slice's contract via @/agent, or (b) document the carve-out in biome.json AND this test.`,
      )
    }
  })

  test("no file reads process.env or process.argv (must take plain config)", () => {
    const violations: string[] = []
    // Match `process.env` and `process.argv` standalone (not inside a string).
    // We do NOT block `process.exit` / `process.on` / `process.cwd()` —
    // those are reasonable runtime escape hatches and don't make the slice
    // surface-coupled.
    const procRe = /\bprocess\.(env|argv)\b/g
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      const lines = src.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ""
        procRe.lastIndex = 0
        let m: RegExpExecArray | null
        // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex API
        while ((m = procRe.exec(line)) !== null) {
          violations.push(`${relative(RUNNER_DIR, f)}:${i + 1}  ${m[0]}`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner must not read process.env / process.argv directly — that is surface-specific input parsing. Take plain typed config instead:\n\n${violations.join(
          "\n",
        )}\n\nIf the value really comes from env, the surface (apps/cli/internal.ts etc.) maps env → config and passes it in.`,
      )
    }
  })

  test("sub-slice barrels exist (assemble/, orchestrate/, session-ops/)", () => {
    const required = ["assemble/index.ts", "orchestrate/index.ts", "session-ops/index.ts"]
    const missing = required.filter((p) => {
      try {
        return !statSync(join(RUNNER_DIR, p)).isFile()
      } catch {
        return true
      }
    })
    if (missing.length > 0) {
      throw new Error(
        `Sub-slice barrels missing under src/runner/: ${missing.join(", ")}.\n` +
          "Each sub-slice MUST expose a top-level index.ts so consumers depend on the contract, not file paths.",
      )
    }
  })
})
