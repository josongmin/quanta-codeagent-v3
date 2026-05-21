import { z } from "zod"
import { runShell } from "@/runtime"
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
})

type Input = z.infer<typeof schema>

const DEFAULT_DEPTH = 3
const DEFAULT_MAX_FILES = 400

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

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

/** Render the aggregate as an indented tree, directories sorted, files sorted
 *  within each directory, per-directory count shown. */
const render = (agg: TreeAgg, maxFiles: number): string => {
  if (agg.byDir.size === 0 && agg.deepRollup.size === 0) return "(no files)"
  const dirs = [...agg.byDir.keys()].sort((a, b) => a.localeCompare(b))
  const out: string[] = []
  for (const dir of dirs) {
    const files = (agg.byDir.get(dir) ?? []).sort((a, b) => a.localeCompare(b))
    const indent = dir === "." ? "" : "  ".repeat(dir.split("/").length)
    out.push(`${indent}${dir}/ (${files.length})`)
    const fileIndent = `${indent}  `
    for (const f of files) out.push(`${fileIndent}${f}`)
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
    "counts, .gitignore-respecting). Use it in Stage 1 of fault localization to " +
    "see where modules live before reading files. Structure only, not file purpose.",
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
    yield { type: "result", result: { ok: true, output: render(agg, maxFiles) } }
  },
}
