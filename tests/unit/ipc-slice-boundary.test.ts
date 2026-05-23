/**
 * Architecture guard for the `@/ipc` slice (deep-dive:A11 absorption —
 * surface-agnostic CLI ↔ Web ↔ Tauri event bridge).
 *
 * Mirror of `tests/unit/runner-slice-boundary.test.ts` with one calibrated
 * difference: `@/ipc` is the slice that LEGITIMATELY frames process stdio
 * (CLI ↔ daemon) — so `process.stdin` / `process.stdout` access is permitted
 * INDIRECTLY via injected `StdioReader` / `StdioWriter` ports. The slice
 * itself never reads `process.stdio.*` directly; it accepts ports.
 *
 * Invariants enforced here:
 *
 *   1. **Surface isolation** — no file under `src/ipc/**` may import from
 *      `apps/**`. Surface entries depend ON `@/ipc`, never the reverse.
 *
 *   2. **Slice deny-list** — ipc must not reach `@/rules` / `@/patch` /
 *      `@/migration` directly.
 *
 *   3. **No `process.env` / `process.argv` reads** — ipc is surface-
 *      AGNOSTIC. ENV/argv parsing belongs in the surface entry.
 *
 *   4. **No raw process.stdin/stdout/stderr access** — even though stdio
 *      framing is the slice's purpose, the IMPLEMENTATION must accept
 *      `StdioReader` / `StdioWriter` ports and let the surface inject the
 *      real Node streams.
 *
 *   5. **No `console.*` direct calls** — surface-specific output. Use a
 *      `@/shared#logger` or an injected log port.
 *
 *   6. **No alt-runtime ENV/argv** — same rule as `@/runner`.
 *
 *   7. **No surface-coupled node modules** — readline / tty / repl are
 *      CLI-only.
 *
 *   8. **No `node:process` named imports** — literal-rename bypass.
 *
 *   9. **Barrel exists** — `src/ipc/index.ts` is the contract.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const IPC_DIR = join(import.meta.dir, "../../src/ipc")

/** Recursively enumerate every `*.ts` file under `src/ipc/`. */
const listIpcTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listIpcTsFiles(full))
    } else if (st.isFile() && name.endsWith(".ts")) {
      out.push(full)
    }
  }
  return out.sort()
}

/** Strip block + line comments so string literals inside docstrings don't
 *  false-positive against our pattern matchers. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Extract `(lineNumber, specifier)` for every `import ... "X"` / `from "X"` token. */
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

/** Scan source lines for every match of `pattern`. */
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

const SLICE_DENY = new Set<string>(["@/rules", "@/patch", "@/migration"])

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

describe("@/ipc — architecture guard", () => {
  const files = listIpcTsFiles(IPC_DIR)

  test("at least one file in the slice (sanity)", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  test("no file imports from any `apps/**` (surface isolation)", () => {
    const isAppsImport = (spec: string): boolean => SURFACE_PATTERNS.some((p) => p.test(spec))
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (isAppsImport(spec)) {
          violations.push(`${relative(IPC_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc is surface-AGNOSTIC. It must NOT import from any apps/**:\n\n${violations.join(
          "\n",
        )}\n\nMove ENV/argv/HTTP/IPC parsing into the surface (apps/cli, apps/web, …) and pass typed config + transports into @/ipc.`,
      )
    }
  })

  test("no file imports from the ipc deny-list (@/rules / @/patch / @/migration)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (isDenied(spec)) {
          violations.push(`${relative(IPC_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc deny-list violation. The following slices must be reached only via @/agent:\n\n${violations.join(
          "\n",
        )}`,
      )
    }
  })

  test("no file reads process.env or process.argv (must take plain config)", () => {
    const violations: string[] = []
    const procRe = /\bprocess\.(env|argv)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), procRe)) {
        violations.push(`${relative(IPC_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc must not read process.env / process.argv directly — that is surface-specific input parsing:\n\n${violations.join(
          "\n",
        )}`,
      )
    }
  })

  test("no file touches process.stdin / process.stdout / process.stderr (use StdioReader/Writer port)", () => {
    const violations: string[] = []
    const stdioRe = /\bprocess\.(stdin|stdout|stderr)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), stdioRe)) {
        violations.push(`${relative(IPC_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc must not access raw process stdio. CLI uses Node streams, Web uses WebSocket, Tauri uses a frontend channel — all surface-specific.\n\n${violations.join(
          "\n",
        )}\n\nAccept a StdioReader / StdioWriter port and let the surface inject the concrete implementation.`,
      )
    }
  })

  test("no file calls console.log / error / warn / info / debug / dir / trace (use @/shared#logger or an injected log port)", () => {
    const violations: string[] = []
    const consoleRe = /\bconsole\.(log|error|warn|info|debug|dir|trace)\s*\(/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), consoleRe)) {
        violations.push(`${relative(IPC_DIR, f)}:${line}  ${hit.replace(/\s*\($/, "(")}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc must not call console.* directly — surface-specific output:\n\n${violations.join(
          "\n",
        )}`,
      )
    }
  })

  test("no alt-runtime ENV/argv (Bun.env / Bun.argv / Deno.env / Deno.args / import.meta.env / globalThis.process.{env,argv})", () => {
    const violations: string[] = []
    const altRe =
      /\bBun\.(env|argv)\b|\bDeno\.(env\b|args\b)|\bimport\.meta\.env\b|\bglobalThis\.process\.(env|argv)\b/g
    for (const f of files) {
      for (const { line, hit } of scanLines(readFileSync(f, "utf8"), altRe)) {
        violations.push(`${relative(IPC_DIR, f)}:${line}  ${hit}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(`@/ipc must not read alt-runtime ENV/argv:\n\n${violations.join("\n")}`)
    }
  })

  test("no file imports surface-coupled node modules (node:readline / readline/promises / tty / repl)", () => {
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const { line, spec } of extractImports(src)) {
        if (NODE_SURFACE_MODULES.has(spec)) {
          violations.push(`${relative(IPC_DIR, f)}:${line}  import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc must not import CLI-specific node modules:\n\n${violations.join("\n")}`,
      )
    }
  })

  test("no `node:process` named imports (would bypass the process.env/stdin invariants)", () => {
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
        violations.push(`${relative(IPC_DIR, f)}:${lineNum}  ${snippet}`)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `@/ipc must not use named imports from "node:process":\n\n${violations.join("\n")}`,
      )
    }
  })

  test("slice barrel exists (src/ipc/index.ts)", () => {
    let ok = false
    try {
      ok = statSync(join(IPC_DIR, "index.ts")).isFile()
    } catch {
      ok = false
    }
    if (!ok) {
      throw new Error(
        "Slice barrel missing at src/ipc/index.ts — consumers must depend on the contract, not file paths.",
      )
    }
  })
})
