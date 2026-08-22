import { existsSync } from "node:fs"
import { z } from "zod"
import { runShell } from "@/runtime"
import { FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { ToolContext, ToolEvent } from "../types"

/**
 * `find_references` — FAST whole-word reference search (ripgrep, fixed-string).
 *
 * WHY THIS EXISTS (jun-19, measured): pyright's semantic `textDocument/references`
 * is INTRACTABLE on large repos — it timed out on sympy at BOTH 15s and 60s
 * (full-remote, gpt-5.5), because it must type-analyze every possibly-referencing
 * file on demand. The localize-phase steer told the model to use `lsp_references`
 * for multi-file co-change, but on a big repo that call just times out and the
 * model falls back to ad-hoc grep and mislocates (symptom site vs root cause).
 *
 * This tool is the timeout-immune replacement: ripgrep `-F -w` (fixed-string,
 * whole-word) returns every textual occurrence of the symbol as a WORD across the
 * repo in milliseconds, repo-size-independent. It is LEXICAL/approximate — a same-
 * named symbol in a different scope also matches, and a dynamically-built name
 * will be missed — so it is NOT a semantic resolver. But "instant + approximate"
 * beats "precise + never returns" for the co-change-mapping job: the model gets a
 * usable cross-file map and confirms the true owner with `lsp_definition` (a fast
 * point-query that does NOT time out).
 *
 * Definition-looking lines (def/class/function/… SYMBOL, or `SYMBOL =`/`SYMBOL:`)
 * are marked `[def]` and listed first so the declaration site is easy to spot
 * among the call sites.
 */

const schema = z.object({
  symbol: z
    .string()
    .min(1)
    .describe(
      "The identifier to find references for (matched as a whole word, literal — no regex)",
    ),
  path: z
    .string()
    .optional()
    .describe("File or directory to scope the search (default: whole workspace)"),
  type: z
    .string()
    .optional()
    .describe("Restrict to a ripgrep file type, e.g. 'py', 'ts' (optional)"),
})

type Input = z.infer<typeof schema>

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

const MAX_ROWS = 200

/**
 * Pure argv builder — the injection boundary, exhaustively testable without FS.
 * `-F` (fixed string) makes the symbol a LITERAL (regex metachars are inert, so a
 * symbol like `__r__` or `a.b` cannot inject a pattern), and `-w` constrains to a
 * whole-word match (so `Add` does NOT match `MatAdd`/`Address`). `jailedPath` is
 * already jail-resolved by the caller; this function never touches the FS.
 */
export const buildFindRefsArgv = (input: Input, jailedPath?: string): string[] => {
  const parts = ["rg", "--line-number", "--no-heading", "--color=never", "-F", "-w"]
  if (input.type !== undefined) parts.push("--type", sq(input.type))
  parts.push("-e", sq(input.symbol))
  if (jailedPath !== undefined) parts.push(sq(jailedPath))
  return parts
}

/**
 * Compile the two definition-matching regexes for `symbol` ONCE (they are
 * symbol-specific so cannot be module-level). `formatFindRefs` builds these a
 * single time and reuses them across every row — avoiding the per-row `new
 * RegExp` compile that the adversarial perf audit flagged on pathological input
 * (a 1-char symbol on a huge repo). The symbol is escaped for RegExp safety even
 * though it is a literal identifier.
 *   - `decl`:   `def|class|function|fn|func|interface|type|struct|trait|enum  foo`
 *   - `assign`: leading-ws `foo =` / `foo:` / `foo: T =` at a statement position.
 *     Excludes comparisons (`==`/`!=`/`<=`/`>=`); walrus `foo := x` is classified
 *     as a USE (the `:=` matches neither branch) — cosmetic only, never drops rows.
 */
const buildDefMatchers = (symbol: string): { decl: RegExp; assign: RegExp } => {
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return {
    decl: new RegExp(
      `\\b(?:def|class|function|fn|func|interface|type|struct|trait|enum)\\s+${s}\\b`,
    ),
    assign: new RegExp(`^\\s*${s}\\s*(?::[^=]|=(?![=]))`),
  }
}

/**
 * Heuristic: does this matched line DECLARE `symbol` (vs merely use it)?
 * Pure + language-spread (py/js/ts/rust/go/java/cpp). Conservative — a false
 * "use" only costs ordering, never correctness (every row is still reported).
 */
export const isDefinitionLine = (content: string, symbol: string): boolean => {
  const m = buildDefMatchers(symbol)
  return m.decl.test(content) || m.assign.test(content)
}

const FILE_CAP = 25

/**
 * Render rg `path:line:content` rows into a CO-CHANGE-oriented report:
 *   1. header — total refs / file count / def count
 *   2. **Files (co-change candidates)** — per-file ref counts, sorted by
 *      (has-definition, ref-count). This is the actionable signal for a
 *      multi-file fix: it tells the model WHICH files use the symbol and so may
 *      have to change together (the exact gap `lsp_references` was meant to fill
 *      before it started timing out). Capped at 25 files.
 *   3. Matches — the raw `path:line:content` rows, definition-like first, cap 200.
 */
export const formatFindRefs = (stdout: string, symbol: string): string => {
  const rows = stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.length > 0)
  const { decl, assign } = buildDefMatchers(symbol) // compile ONCE, reuse per row
  const defs: string[] = []
  const uses: string[] = []
  const perFile = new Map<string, { count: number; hasDef: boolean }>()
  for (const row of rows) {
    // rg row = `path:line:content` (content may itself contain colons).
    const m = row.match(/^(.*?):(\d+):(.*)$/)
    const file = m ? (m[1] as string) : (row.split(":", 1)[0] as string)
    const content = m ? (m[3] as string) : row
    const isDef = m !== null && (decl.test(content) || assign.test(content))
    if (isDef) defs.push(`[def] ${row}`)
    else uses.push(row)
    const f = perFile.get(file) ?? { count: 0, hasDef: false }
    f.count += 1
    f.hasDef = f.hasDef || isDef
    perFile.set(file, f)
  }
  const header = `${symbol} — ${rows.length} reference(s) in ${perFile.size} file(s)${defs.length ? ` (${defs.length} definition-like)` : ""}`
  // Co-change candidate map: files with a definition first, then by ref count.
  const files = [...perFile.entries()].sort(
    (a, b) => Number(b[1].hasDef) - Number(a[1].hasDef) || b[1].count - a[1].count,
  )
  const fileLines = files
    .filter((_, index) => index < FILE_CAP)
    .map(
      ([f, s]) =>
        `  ${f} — ${s.count} ref${s.count === 1 ? "" : "s"}${s.hasDef ? " (def here)" : ""}`,
    )
    .join("\n")
  const fileMore =
    files.length > FILE_CAP
      ? `\n  … (${files.length - FILE_CAP} more files; sorted by definition-presence then ref-count — narrow with \`path\`/\`type\` to surface buried owners)`
      : ""
  const fileBlock = `Files (co-change candidates — verify each that should change together):\n${fileLines}${fileMore}`
  const ordered = [...defs, ...uses]
  const shown = ordered.filter((_, index) => index < MAX_ROWS).join("\n")
  const more =
    ordered.length > MAX_ROWS
      ? `\n… (${ordered.length - MAX_ROWS} more rows; NARROW with \`path\`/\`type\`)`
      : ""
  return `${header}\n\n${fileBlock}\n\nMatches:\n${shown}${more}`
}

export const findReferencesTool = defineTool<Input>({
  name: "find_references",
  description:
    "Fast whole-word reference search across the codebase (ripgrep, literal symbol). " +
    "Returns every `path:line:match` where SYMBOL appears as a word, with definition-" +
    "looking lines marked `[def]` and listed first. INSTANT and never times out — " +
    "PREFER this over `lsp_references` on large repos (lsp_references type-analyzes the " +
    "whole project and can time out). It is lexical/approximate (a same-named symbol in " +
    "another scope also matches); confirm the true owner with `lsp_definition`. Capped at " +
    "200 rows — narrow with `path`/`type` if you hit the cap.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: `finding references to ${input.symbol}…` }

    // Jail-validate the model-supplied path BEFORE building argv (a `path:"/etc"`
    // would otherwise escape the workspace via the ripgrep subprocess).
    let jailedPath: string | undefined
    if (input.path !== undefined) {
      try {
        jailedPath = resolveJailed(input.path, ctx.cwd)
        if (!existsSync(jailedPath)) {
          yield {
            type: "result",
            result: {
              ok: false,
              output: `find_references path must name one existing file or directory; received: ${input.path}`,
            },
          }
          return
        }
      } catch (e) {
        if (e instanceof FsJailError) {
          yield { type: "result", result: { ok: false, output: e.message } }
          return
        }
        throw e
      }
    }

    const parts = buildFindRefsArgv(input, jailedPath)
    const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })

    // rg exit 1 + empty stdout = no matches (not an error).
    if (r.exitCode === 1 && !r.stdout) {
      yield {
        type: "result",
        result: {
          ok: true,
          output: `${input.symbol} — 0 references found (it may be dynamically constructed, or check the spelling).`,
        },
      }
      return
    }
    if (r.exitCode > 1 || r.timedOut) {
      yield {
        type: "result",
        result: { ok: false, output: r.stderr.trim() || `ripgrep failed (exit ${r.exitCode})` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: formatFindRefs(r.stdout, input.symbol) } }
  },
})
