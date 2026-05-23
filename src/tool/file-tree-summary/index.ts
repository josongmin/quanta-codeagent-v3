import { existsSync } from "node:fs"
import { z } from "zod"
import { runShell } from "@/runtime"
import { byteCompare } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import type { NextAction, Tool, ToolContext, ToolEvent } from "../types"

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
  rank: z
    .enum(["alpha", "recency", "size"])
    .optional()
    .describe(
      "How to order dirs in the rendered tree. 'alpha' (default) = byte-sorted; " +
        "'size' = by file count desc, tie-break by byte-sort; " +
        "'recency' = by recent git change hits desc (30d window), tie-break by byte-sort.",
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
  /** Full relative paths of all files that will be emitted by render(), in
   *  render order (dir-sorted, then file-sorted within dir). This is the
   *  EXACT set the purpose pass must scan — populated by aggregate(). */
  renderedFiles: string[]
}

/**
 * Parse `git log --since=30d --name-only --pretty=format:` stdout into a
 * dir → hit-count map. Every parent directory of each changed file path gets
 * +1. Pure function (no I/O) — fully unit-testable.
 */
export const parseRecencyHits = (stdout: string): Map<string, number> => {
  const hits = new Map<string, number>()
  for (const line of stdout.split("\n")) {
    const p = line.trim()
    if (p.length === 0) continue
    // Accumulate every ancestor directory (not the file itself — we sort dirs).
    const segs = p.split("/")
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/")
      hits.set(dir, (hits.get(dir) ?? 0) + 1)
    }
    // Also credit the immediate dir for root-level files (segs.length === 1).
    if (segs.length === 1) {
      hits.set(".", (hits.get(".") ?? 0) + 1)
    }
  }
  return hits
}

/** Comparator: sort directories by rank strategy.
 *  "alpha" → byte-sort (default, byte-identical to existing behaviour).
 *  "size"  → file-count desc, tie-break byte-sort.
 *  "recency" → recency hits desc, tie-break byte-sort. */
export const makeDirComparator = (
  rank: "alpha" | "recency" | "size",
  byDir: Map<string, string[]>,
  recencyHits: Map<string, number>,
): ((a: string, b: string) => number) => {
  if (rank === "alpha") return (a, b) => byteCompare(a, b)
  if (rank === "size") {
    return (a, b) => {
      const diff = (byDir.get(b)?.length ?? 0) - (byDir.get(a)?.length ?? 0)
      return diff !== 0 ? diff : byteCompare(a, b)
    }
  }
  // rank === "recency"
  return (a, b) => {
    const diff = (recencyHits.get(b) ?? 0) - (recencyHits.get(a) ?? 0)
    return diff !== 0 ? diff : byteCompare(a, b)
  }
}

/**
 * Build per-dir extension breakdown string for the dir-header.
 * Rule (exact — no fuzzy): show ONLY IF dir has ≥3 files AND ≥2 distinct exts.
 * Returns top-3 exts by count, formatted as `ext=N ext=N ext=N`.
 * Returns "" if condition not met (caller shows bare count).
 * Pure function — no I/O.
 */
export const extBreakdown = (files: string[]): string => {
  if (files.length < 3) return ""
  const counts = new Map<string, number>()
  for (const f of files) {
    const dot = f.lastIndexOf(".")
    const ext = dot > 0 ? f.slice(dot + 1) : ""
    if (ext.length > 0) counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  if (counts.size < 2) return ""
  const top3 = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || byteCompare(a[0], b[0]))
    .slice(0, 3)
  return top3.map(([e, n]) => `${e}=${n}`).join(" ")
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

  // Build renderedFiles: the exact set render() will emit, in render order
  // (dirs sorted by byteCompare, files sorted within each dir).
  const sortedDirs = [...byDir.keys()].sort((a, b) => byteCompare(a, b))
  const renderedFiles: string[] = []
  for (const dir of sortedDirs) {
    const sorted = [...(byDir.get(dir) ?? [])].sort((a, b) => byteCompare(a, b))
    for (const base of sorted) {
      renderedFiles.push(dir === "." ? base : `${dir}/${base}`)
    }
  }

  return { byDir, deepRollup, total, truncated, renderedFiles }
}

/** First declaration / docstring / comment line per file is a cheap "purpose"
 *  signal (Codex file-topology). Language-agnostic alternation: a leading
 *  export/def/class/func/interface/type/fn/public/module.exports, OR the first
 *  line/block comment. ripgrep `-m 5` extracts the first 5 matches per file;
 *  parsePurposeRows picks the first that survives the noise deny-list. */
const PURPOSE_RE = String.raw`^\s*(?:export\s|def\s|class\s|func\s|function\s|interface\s|type\s|fn\s|pub\s|public\s|module\.exports|//|#|/\*\*?)`

/** Explicit noise deny-list for purpose hints.
 *  ONLY literal substring checks and exact-prefix checks — no fuzzy guessing.
 *  Order is irrelevant; ALL checks are applied. */
const NOISE_CHECKS: ReadonlyArray<(line: string) => boolean> = [
  (l) => /copyright/i.test(l),
  (l) => l.includes("SPDX-License-Identifier"),
  (l) => /all rights reserved/i.test(l),
  (l) => l.includes("@license"),
  (l) => l.includes("eslint-disable"),
  (l) => l.includes("eslint-enable"),
  (l) => l.includes("biome-ignore"),
  (l) => l.includes("@ts-nocheck"),
  (l) => l.includes("@ts-ignore"),
  (l) => l.includes("@ts-expect-error"),
  (l) => l.includes("prettier-ignore"),
  // "use strict" / "use client" / "use server" with or without semicolon
  (l) => /^["']use (?:strict|client|server)["'];?$/.test(l),
  // shebang
  (l) => l.startsWith("#!"),
]

/** Returns true when the candidate line is noise and should be skipped. */
const isNoiseLine = (line: string): boolean => NOISE_CHECKS.some((check) => check(line))

/** Parse `path:line:text` rows from the purpose pass (rg -m 5 output) into a
 *  `relpath → hint` map. For each file, the first non-noise candidate line
 *  wins. The hint is the trimmed match line, capped. Exported pure for tests. */
export const parsePurposeRows = (stdout: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const row of stdout.split("\n")) {
    const m = row.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue
    const file = m[1]
    const text = (m[3] ?? "").trim()
    if (!file || text.length === 0) continue
    // Already settled on a non-noise hint for this file — skip.
    if (map.has(file)) continue
    if (isNoiseLine(text)) continue
    map.set(file, text.length > SUMMARY_LEN ? `${text.slice(0, SUMMARY_LEN)}…` : text)
  }
  return map
}

/** Exported for tests. */
export { isNoiseLine }

/** Emit one rollup line in the canonical form.
 *  Indent is determined by the segment depth of the ancestor path. */
const rollupLine = (ancestor: string, count: number): string => {
  const depth = ancestor === "." ? 0 : ancestor.split("/").length
  const indent = "  ".repeat(depth + 1)
  return `${indent}${ancestor}/ …/ (+${count} deeper, increase max_depth)`
}

/** Append lines for orphan deep-rollup ancestors (those not in byDir). */
const appendOrphanRollups = (out: string[], agg: TreeAgg): void => {
  for (const [ancestor, count] of [...agg.deepRollup.entries()].sort((a, b) =>
    byteCompare(a[0], b[0]),
  )) {
    if (!agg.byDir.has(ancestor)) out.push(rollupLine(ancestor, count))
  }
}

/** Render the aggregate as an indented tree, directories sorted, files sorted
 *  within each directory, per-directory count shown. When `summaries` is
 *  given, each file gets a ` — <first-decl/comment>` purpose annotation.
 *  `rank` controls directory ordering; `recencyHits` is used only for "recency". */
const render = (
  agg: TreeAgg,
  maxFiles: number,
  summaries: Map<string, string> | undefined,
  rank: "alpha" | "recency" | "size" = "alpha",
  recencyHits: Map<string, number> = new Map(),
): string => {
  if (agg.byDir.size === 0 && agg.deepRollup.size === 0) return "(no files)"
  const cmp = makeDirComparator(rank, agg.byDir, recencyHits)
  const dirs = [...agg.byDir.keys()].sort(cmp)
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
    const breakdown = extBreakdown(files)
    const countLabel = breakdown.length > 0 ? `${files.length}, ${breakdown}` : `${files.length}`
    out.push(`${indent}${dir}/ (${countLabel})`)
    const fileIndent = `${indent}  `
    for (const f of files) out.push(`${fileIndent}${f}${purposeOf(dir, f)}`)
    const rolled = agg.deepRollup.get(dir)
    // Unified rollup line: same helper used below for orphan ancestors.
    if (rolled !== undefined) out.push(rollupLine(dir, rolled))
  }
  appendOrphanRollups(out, agg)
  if (agg.truncated) {
    out.push(`… (file cap ${maxFiles} reached — narrow with path or raise max_files)`)
  }
  return out.join("\n")
}

/** Fetch recency hit-counts via a single git-log call.
 *  Returns an empty map on any failure (non-git dir, no commits, etc.) so
 *  callers silently fall back to alpha ordering. */
const fetchRecencyHits = async (cwd: string, signal: AbortSignal): Promise<Map<string, number>> => {
  const gr = await runShell("git log --since='30 days ago' --name-only --pretty=format:", {
    cwd,
    signal,
  })
  if (gr.exitCode === 0 && !gr.timedOut) return parseRecencyHits(gr.stdout)
  return new Map()
}

/**
 * ADR-0062 rule #3 — pure structural cap detector. Derives the `NextAction`
 * hint from the STRUCTURAL aggregate signals (`agg.truncated`, `agg.deepRollup`)
 * WITHOUT inspecting any rendered text. Called once per successful execute();
 * returns `undefined` when the output was not capped (the common case).
 *
 * Precedence: when BOTH signals fire, `increase_max_depth` wins — depth
 * truncation is the more common bottleneck (rolled-up dirs hide entire
 * subtrees, while a file-cap only hides the tail of a flat listing).
 *
 * PURE — no I/O, no clock, no shell. Fully unit-testable.
 */
export const inferNextAction = (
  agg: TreeAgg,
  maxDepth: number,
  maxFiles: number,
): NextAction | undefined => {
  const hasDeepRollup = agg.deepRollup.size > 0
  const hasTruncated = agg.truncated

  if (hasDeepRollup) {
    const hiddenFiles = [...agg.deepRollup.values()].reduce((sum, n) => sum + n, 0)
    const suggested = Math.min(maxDepth * 2, 10)
    return {
      kind: "increase_max_depth",
      suggested,
      reason: `${hiddenFiles} file${hiddenFiles === 1 ? "" : "s"} beyond depth ${maxDepth} — set max_depth to at least ${suggested}`,
    }
  }

  if (hasTruncated) {
    const suggested = maxFiles * 2
    return {
      kind: "raise_max_files",
      suggested,
      reason: `file cap ${maxFiles} reached — raise max_files to at least ${suggested} or narrow with path`,
    }
  }

  return undefined
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

    // Recency ranking: ONE git-log call, placed AFTER the rg --files block.
    // Failure (non-git dir, no commits, etc.) silently falls back to "alpha".
    const rank = input.rank ?? "alpha"
    const recencyHits =
      rank === "recency" ? await fetchRecencyHits(ctx.cwd, ctx.signal) : new Map<string, number>()

    // Optional purpose layer: one extra `rg -m5` pass extracting up to 5
    // candidate lines per file so parsePurposeRows can skip noise lines and
    // return the first surviving non-noise line. Scans EXACTLY the files that
    // render() will emit (agg.renderedFiles, capped at SUMMARY_FILE_CAP) —
    // never the entire jailed scope. Failure degrades to structure-only tree.
    let summaries: Map<string, string> | undefined
    if (input.summarize === true) {
      yield { type: "progress", message: "extracting per-file purpose…" }
      const targetFiles = agg.renderedFiles.slice(0, SUMMARY_FILE_CAP)
      if (targetFiles.length > 0) {
        const purposeParts = [
          "rg",
          "--no-heading",
          "--line-number",
          "--color=never",
          "-m",
          "5",
          "--max-filesize",
          "1M",
          "-e",
          sq(PURPOSE_RE),
          "--",
          ...targetFiles.map(sq),
        ]
        const pr = await runShell(purposeParts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })
        if (pr.exitCode <= 1 && !pr.timedOut) {
          summaries = parsePurposeRows(pr.stdout.trimEnd())
        }
      }
    }

    const nextAction = inferNextAction(agg, maxDepth, maxFiles)
    yield {
      type: "result",
      result: {
        ok: true,
        output: render(agg, maxFiles, summaries, rank, recencyHits),
        ...(nextAction !== undefined ? { nextAction } : {}),
      },
    }
  },
}
