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
 *   5. **No raw process stdio** — `process.stdin` / `process.stdout` /
 *      `process.stderr` are surface-specific (CLI raw streams vs Web
 *      `Response.write` vs Tauri frontend channel). Runner must use a
 *      `WriteSink` / `InputStream` port and let the surface inject the
 *      concrete impl. (`process.exit`, `process.on`, `process.cwd` remain
 *      allowed — they are not surface-coupled.)
 *
 *   6. **No `console.*` direct calls** — surface-specific output. Runner
 *      must route through `@/shared#logger` (or an injected log port) so a
 *      non-CLI surface can redirect.
 *
 *   7. **No alt-runtime ENV/argv** — `Bun.env`, `Bun.argv`, `Deno.env.*`,
 *      `Deno.args`, `import.meta.env` (Vite/Astro), and
 *      `globalThis.process.(env|argv)` are all surface-coupled bypasses of
 *      invariant #3. Same fix: surface entry parses, runner takes config.
 *
 *   8. **No surface-coupled node modules** — `node:readline`,
 *      `node:readline/promises`, `node:tty`, `node:repl` are CLI-only.
 *      They must live in apps/cli; runner uses a port (`PromptSource`,
 *      `InputStream`) and lets the surface inject.
 *
 *   9. **No `node:process` named imports** — `import { env, argv, stdin }
 *      from "node:process"` is a literal-rename bypass of invariant #3/#5.
 *      The default-import form (`import process from "node:process"` →
 *      `process.env`) is already caught by invariant #3's `process.env`
 *      regex.
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

/** Scan source lines for every match of `pattern`, returning `(line, hit)`
 *  pairs. Operates on comment-stripped source. */
const scanLines = (
  src: string,
  pattern: RegExp,
): Array<{ line: number; hit: string }> => {
  const out: Array<{ line: number; hit: string }> = []
  const stripped = stripComments(src)
  const lines = stripped.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.length === 0) continue
    // Ensure the pattern carries the global flag so exec advances.
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

/** Surface-coupled node modules: CLI-only stdlib slices. */
const NODE_SURFACE_MODULES = new Set<string>([
  "node:readline",
  "node:readline/promises",
  "node:tty",
  "node:repl",
])

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
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), procRe)) {
        violations.push(`${relative(RUNNER_DIR, f)}:${line}  ${hit}`)
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

  test("no file touches process.stdin / process.stdout / process.stderr (use WriteSink/InputStream port)", () => {
    const violations: string[] = []
    // Match `process.stdin` / `process.stdout` / `process.stderr` as a
    // property access. This catches both bare access and method/property
    // chains (`process.stdout.write(...)`, `process.stderr.isTTY`, …).
    // `process.exit`/`process.on`/`process.cwd` are NOT matched.
    const stdioRe = /\bprocess\.(stdin|stdout|stderr)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), stdioRe)) {
        violations.push(`${relative(RUNNER_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner must not access raw process stdio. CLI uses Node streams, Web uses Response.write, Tauri uses a frontend channel — all are surface-specific.\n\n${violations.join(
          "\n",
        )}\n\nAccept a WriteSink (\`(chunk: string) => void\`) or InputStream port via the assemble factory and let the surface inject the concrete implementation.`,
      )
    }
  })

  test("no file calls console.log / error / warn / info / debug / dir / trace (use @/shared#logger or an injected log port)", () => {
    const violations: string[] = []
    // Match `console.<method>(` — require the open-paren so `console.info`-
    // shaped *signatures* in type annotations / comments (already stripped)
    // are not flagged.
    const consoleRe = /\bconsole\.(log|error|warn|info|debug|dir|trace)\s*\(/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), consoleRe)) {
        violations.push(`${relative(RUNNER_DIR, f)}:${line}  ${hit.replace(/\s*\($/, "(")}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner must not call console.* directly — surface-specific output. Route through @/shared#logger (or an injected log port) so a non-CLI surface can redirect.\n\n${violations.join(
          "\n",
        )}\n\nFix: import { logger } from "@/shared" and use logger.info/.warn/.error, OR add an onX?: (line: string) => void port to the relevant factory options.`,
      )
    }
  })

  test("no alt-runtime ENV/argv (Bun.env / Bun.argv / Deno.env / Deno.args / import.meta.env / globalThis.process.{env,argv})", () => {
    const violations: string[] = []
    // Combined regex matches any of the bypass forms. Capture group 0 is
    // the offending token (used verbatim in the error).
    const altRe =
      /\bBun\.(env|argv)\b|\bDeno\.(env\b|args\b)|\bimport\.meta\.env\b|\bglobalThis\.process\.(env|argv)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), altRe)) {
        violations.push(`${relative(RUNNER_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner must not read alt-runtime ENV/argv — same surface-coupling rule as process.env. Bun.env, Deno.env, import.meta.env, and globalThis.process.* are bypasses, not exceptions.\n\n${violations.join(
          "\n",
        )}\n\nFix: the surface (apps/cli, apps/web, apps/tauri) maps its runtime's env/argv into the typed config that @/runner consumes.`,
      )
    }
  })

  test("no file imports surface-coupled node modules (node:readline / readline/promises / tty / repl)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (NODE_SURFACE_MODULES.has(spec)) {
          violations.push(`${relative(RUNNER_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner must not import CLI-specific node modules. readline/tty/repl are terminal-only — Web/Tauri surfaces cannot run this slice.\n\n${violations.join(
          "\n",
        )}\n\nMove the readline/tty/repl call into apps/cli and pass a PromptSource / InputStream port into @/runner. The surface chooses how to source input (Node TTY / WebSocket / Tauri command).`,
      )
    }
  })

  test("no `node:process` named imports (would bypass the process.env/stdin invariants)", () => {
    const violations: string[] = []
    // Match `import { ... } from "node:process"` — i.e. a named-import form.
    // The default form (`import process from "node:process"` → `process.env`)
    // is already caught by the process.env / process.stdin invariants above.
    // Pattern: `import` + `{...}` + `from "node:process"`.
    const namedRe = /\bimport\s*(?:type\s*)?\{[^}]*\}\s*from\s+["']node:process["']/g
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      const lines = src.split("\n")
      // Multiline-aware: re-scan the whole file, then map back to line via
      // offset. Named-import braces can span lines.
      namedRe.lastIndex = 0
      let m: RegExpExecArray | null
      // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex API
      while ((m = namedRe.exec(src)) !== null) {
        // Compute 1-based line number from byte offset.
        const lineNum = src.slice(0, m.index).split("\n").length
        const snippet = (lines[lineNum - 1] ?? m[0]).trim()
        violations.push(`${relative(RUNNER_DIR, f)}:${lineNum}  ${snippet}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/runner must not use named imports from "node:process". That is a literal-rename bypass of the process.env / process.stdin invariants:\n\n${violations.join(
          "\n",
        )}\n\nFix: take typed config (env-like fields) or a WriteSink/InputStream port. The surface entry parses node:process and passes the values in.`,
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
