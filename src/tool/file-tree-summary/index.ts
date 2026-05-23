import { existsSync } from "node:fs"
import { z } from "zod"
import { runShell } from "@/runtime"
import { byteCompare } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

/**
 * `file_tree_summary` — Stage-1 fault-localization aid (Codex "file topology"
 * signal, 7/6 freq/trust; `docs/reviews-codex-agent/may-20-codex-signal.md`).
 *
 * Returns a depth-bounded, .gitignore-respecting directory tree with per-
 * directory file counts. The model uses this to understand a repo's module
 * layout BEFORE choosing which files to read — the "where do things live"
 * question that a flat `grep` cannot answer. Read-only and concurrency-safe
 * (ripgrep `--files` has no side effects).
 *
 * NOT a content summarizer — it reports STRUCTURE (paths + counts), not file
 * purpose. Purpose comes from reading the file (Stage 2). Keeping it
 * structure-only makes it deterministic, cheap, and language-agnostic.
 */

const schema = z.object({
  path: z.string().optional().describe("Directory to summarize (default cwd)"),
  max_depth: z
    .number()
    .int()
    .positive()
    .max(10)
    .optional()
    .describe("Max directory depth to descend (default 3, max 10)"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe("Cap total files listed (default 400, max 2000)"),
  summarize: z
    .boolean()
    .optional()
    .describe(
      "Annotate each file with its first declaration/comment line (purpose hint). " +
        "Adds one ripgrep pass; capped at 200 files for cost.",
    ),
})

type Input = z.infer<typeof schema>

const DEFAULT_DEPTH = 3
const DEFAULT_MAX_FILES = 400
/** Hard cap on per-file purpose extraction (summarize mode) — bounds the
 *  second ripgrep pass + render width on huge trees. */
const SUMMARY_FILE_CAP = 200
/** Truncate a purpose hint so the tree stays scannable. */
const SUMMARY_LEN = 80

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/**
 * Collect jail-validated absolute paths of existing ignore files under
 * `scopeRoot`. Checks, in declared order:
 *   1. `.quantaignore`       — quanta's own ignore file
 *   2. `.cursorignore`       — Cursor compat (do-not-process)
 *   3. `.cursorindexignore`  — Cursor compat (do-not-index)
 *
 * Each candidate is resolved via `resolveJailed(name, jailRoot)` where
 * `jailRoot` is `ctxCwd`. A symlink pointing outside the jail throws
 * `FsJailError`, which is caught and silently skipped. Missing files are
 * silently skipped. Returns only the paths that both pass the jail check AND
 * exist on disk, preserving declaration order.
 */
export const collectIgnoreFiles = (scopeRoot: string, ctxCwd: string): string[] => {
  const names = [".quantaignore", ".cursorignore", ".cursorindexignore"]
  const result: string[] = []
  for (const name of names) {
    const candidate = `${scopeRoot}/${name}`
    try {
      const jailed = resolveJailed(candidate, ctxCwd)
      if (existsSync(jailed)) {
        result.push(jailed)
      }
    } catch (e) {
      if (e instanceof FsJailError) continue
      throw e
    }
  }
  return result
}

/** Count path depth relative to the scope root (number of `/` segments). */
const depthOf = (rel: string): number => rel.split("/").length - 1

/** Build a `dir → file[]` map from the flat ripgrep file list, capped by
 *  depth. Files at or below `maxDepth` segments are kept; deeper ones are
 *  rolled up into a `…/` rollup marker on their nearest in-scope ancestor. */
interface TreeAgg {
  byDir: Map<string, string[]>
  deepRollup: Map<string, number>
  total: number
  truncated: boolean
}

const aggregate = (files: string[], maxDepth: number, maxFiles: number): TreeAgg => {
  const byDir = new Map<string, string[]>()
  const deepRollup = new Map<string, number>()
  let total = 0
  let truncated = false

  for (const rel of files) {
    if (total >= maxFiles) {
      truncated = true
      break
    }
    const d = depthOf(rel)
    const slash = rel.lastIndexOf("/")
    const dir = slash === -1 ? "." : rel.slice(0, slash)
    const base = slash === -1 ? rel : rel.slice(slash + 1)
    if (d > maxDepth) {
      // Roll up into the nearest ancestor at maxDepth.
      const segs = rel.split("/")
      const ancestor = segs.slice(0, maxDepth).join("/")
      deepRollup.set(ancestor, (deepRollup.get(ancestor) ?? 0) + 1)
      continue
    }
    const bucket = byDir.get(dir) ?? []
    bucket.push(base)
    byDir.set(dir, bucket)
    total += 1
  }
  return { byDir, deepRollup, total, truncated }
}

/** First declaration / docstring / comment line per file is a cheap "purpose"
 *  signal (Codex file-topology). Language-agnostic alternation: a leading
 *  export/def/class/func/interface/type/fn/public/module.exports, OR the first
 *  line/block comment. One ripgrep `-m1` pass extracts the first match per
 *  file. */
const PURPOSE_RE = String.raw`^\s*(?:export\s|def\s|class\s|func\s|function\s|interface\s|type\s|fn\s|pub\s|public\s|module\.exports|//|#\s|/\*\*?)`

/** Parse `path:line:text` rows from the purpose pass into a `relpath → hint`
 *  map. The hint is the trimmed match line, capped. Exported pure for tests. */
export const parsePurposeRows = (stdout: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const row of stdout.split("\n")) {
    const m = row.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue
    const file = m[1]
    const text = (m[3] ?? "").trim()
    if (!file || text.length === 0 || map.has(file)) continue
    map.set(file, text.length > SUMMARY_LEN ? `${text.slice(0, SUMMARY_LEN)}…` : text)
  }
  return map
}

/** Render the aggregate as an indented tree, directories sorted, files sorted
 *  within each directory, per-directory count shown. When `summaries` is
 *  given, each file gets a ` — <first-decl/comment>` purpose annotation. */
const render = (
  agg: TreeAgg,
  maxFiles: number,
  summaries: Map<string, string> | undefined,
): string => {
  if (agg.byDir.size === 0 && agg.deepRollup.size === 0) return "(no files)"
  const dirs = [...agg.byDir.keys()].sort((a, b) => byteCompare(a, b))
  const out: string[] = []
  const purposeOf = (dir: string, base: string): string => {
    if (summaries === undefined) return ""
    const rel = dir === "." ? base : `${dir}/${base}`
    const hint = summaries.get(rel)
    return hint ? `  — ${hint}` : ""
  }
  for (const dir of dirs) {
    const files = (agg.byDir.get(dir) ?? []).sort((a, b) => byteCompare(a, b))
    const indent = dir === "." ? "" : "  ".repeat(dir.split("/").length)
    out.push(`${indent}${dir}/ (${files.length})`)
    const fileIndent = `${indent}  `
    for (const f of files) out.push(`${fileIndent}${f}${purposeOf(dir, f)}`)
    const rolled = agg.deepRollup.get(dir)
    if (rolled !== undefined) out.push(`${fileIndent}…/ (+${rolled} deeper, increase max_depth)`)
  }
  // Deep rollups whose ancestor was itself beyond maxDepth (no byDir entry).
  for (const [ancestor, count] of [...agg.deepRollup.entries()].sort()) {
    if (agg.byDir.has(ancestor)) continue
    out.push(`${ancestor}/ …/ (+${count} deeper, increase max_depth)`)
  }
  if (agg.truncated) {
    out.push(`… (file cap ${maxFiles} reached — narrow with path or raise max_files)`)
  }
  return out.join("\n")
}

export const fileTreeSummaryTool: Tool<Input> = {
  name: "file_tree_summary",
  description:
    "Summarize a repo's directory STRUCTURE (depth-bounded tree + per-dir file " +
    "counts, .gitignore-respecting). Stage 1 of fault localization — see where " +
    "modules live before reading files. Pass summarize:true to annotate each " +
    "file with its first declaration/comment (a cheap purpose hint). " +
    "CAP RESPONSE (ADR-0062): when the output contains '+N deeper, increase " +
    "max_depth' or 'file cap … reached — narrow with path or raise max_files', " +
    "the NEXT call MUST apply that suggestion (double max_depth, narrow path, " +
    "or raise max_files) before switching tools or asking the user to narrow " +
    "down. The cap message names the exact next parameter — apply it.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const maxDepth = input.max_depth ?? DEFAULT_DEPTH
    const maxFiles = input.max_files ?? DEFAULT_MAX_FILES

    // S14: jail-validate the model-supplied path BEFORE building argv.
    let jailedPath: string | undefined
    if (input.path !== undefined) {
      try {
        jailedPath = resolveJailed(input.path, ctx.cwd)
      } catch (e) {
        if (e instanceof FsJailError) {
          yield { type: "result", result: { ok: false, output: e.message } }
          return
        }
        throw e
      }
    }

    yield { type: "progress", message: `summarizing tree (depth ${maxDepth})…` }

    // ripgrep --files lists every non-ignored file, one per line, relative to
    // the search root. We `cd` into the scope via cwd so the rows are scope-
    // relative; an explicit jailed path is passed as the search root instead.
    const parts = ["rg", "--files", "--color=never"]
    // Honor .quantaignore / .cursorignore / .cursorindexignore when present in
    // the scope root. Each valid, existing file is appended as --ignore-file
    // in declaration order. Missing files and jail-escaping symlinks are
    // silently skipped (invariant: no ignore files → argv byte-identical to
    // before this change).
    const scopeRoot = jailedPath ?? ctx.cwd
    for (const ignoreFile of collectIgnoreFiles(scopeRoot, ctx.cwd)) {
      parts.push("--ignore-file", sq(ignoreFile))
    }
    if (jailedPath !== undefined) parts.push(sq(jailedPath))
    const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })

    if (r.exitCode > 1 || r.timedOut) {
      yield {
        type: "result",
        result: { ok: false, output: r.stderr.trim() || `rg --files failed (exit ${r.exitCode})` },
      }
      return
    }
    const files = r.stdout
      .trimEnd()
      .split("\n")
      .filter((l) => l.length > 0)
    if (files.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no files)" } }
      return
    }

    const agg = aggregate(files, maxDepth, maxFiles)

    // Optional purpose layer: one extra `rg -m1` pass extracting the first
    // declaration/comment line per file (capped). Failure here degrades to a
    // structure-only tree — the purpose hint is a bonus, never load-bearing.
    let summaries: Map<string, string> | undefined
    if (input.summarize === true) {
      yield { type: "progress", message: "extracting per-file purpose…" }
      const purposeParts = [
        "rg",
        "--no-heading",
        "--line-number",
        "--color=never",
        "-m",
        "1",
        "--max-filesize",
        "1M",
        "-e",
        sq(PURPOSE_RE),
      ]
      if (jailedPath !== undefined) purposeParts.push(sq(jailedPath))
      const pr = await runShell(purposeParts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })
      if (pr.exitCode <= 1 && !pr.timedOut) {
        const rows = pr.stdout.trimEnd().split("\n").slice(0, SUMMARY_FILE_CAP).join("\n")
        summaries = parsePurposeRows(rows)
      }
    }

    yield { type: "result", result: { ok: true, output: render(agg, maxFiles, summaries) } }
  },
}
