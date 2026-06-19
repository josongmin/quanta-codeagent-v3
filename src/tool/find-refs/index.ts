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
    .describe("The identifier to find references for (matched as a whole word, literal — no regex)"),
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
 * Heuristic: does this matched line DECLARE `symbol` (vs merely use it)?
 * Pure + language-spread (py/js/ts/rust/go/java/cpp). Conservative — a false
 * "use" only costs ordering, never correctness. The line is the raw match
 * content (after `path:line:`), `symbol` the searched identifier.
 */
export const isDefinitionLine = (content: string, symbol: string): boolean => {
  // Escape the symbol for use inside a RegExp (it's a literal identifier, but be safe).
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // `def foo` / `class foo` / `function foo` / `fn foo` / `func foo` / `interface foo` / `type foo` / `struct foo` / `trait foo` / `enum foo`
  const declKeyword = new RegExp(
    `\\b(?:def|class|function|fn|func|interface|type|struct|trait|enum)\\s+${s}\\b`,
  )
  if (declKeyword.test(content)) return true
  // Assignment / annotation at a statement-ish position: leading ws then `foo =` / `foo:` / `foo: T =`.
  // Excludes `==`/`!=`/`<=`/`>=` (comparisons) and `:=` walrus is still a bind so allowed.
  const assign = new RegExp(`^\\s*${s}\\s*(?::[^=]|=(?![=]))`)
  return assign.test(content)
}

/** Render rg `path:line:content` rows into a grouped, def-first, capped report. */
export const formatFindRefs = (stdout: string, symbol: string): string => {
  const rows = stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.length > 0)
  const defs: string[] = []
  const uses: string[] = []
  for (const row of rows) {
    // rg row = `path:line:content` (content may itself contain colons).
    const m = row.match(/^(.*?):(\d+):(.*)$/)
    const content = m ? (m[3] as string) : row
    if (m && isDefinitionLine(content, symbol)) defs.push(`[def] ${row}`)
    else uses.push(row)
  }
  const ordered = [...defs, ...uses]
  const fileCount = new Set(rows.map((r) => r.split(":", 1)[0])).size
  const header = `${symbol} — ${rows.length} reference(s) in ${fileCount} file(s)${defs.length ? ` (${defs.length} definition-like)` : ""}`
  const shown = ordered.slice(0, MAX_ROWS).join("\n")
  const more = ordered.length > MAX_ROWS ? `\n… (${ordered.length - MAX_ROWS} more; NARROW with \`path\` or \`type\`)` : ""
  return `${header}\n${shown}${more}`
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
