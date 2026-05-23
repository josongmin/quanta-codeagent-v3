import { z } from "zod"
import { runShell } from "@/runtime"
import { byteCompare } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"

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
const DEFAULT_DEPTH = 3
const DEFAULT_MAX_FILES = 400
/** Hard cap on per-file purpose extraction (summarize mode) — bounds the
 *  second ripgrep pass + render width on huge trees. */
const SUMMARY_FILE_CAP = 200
/** Truncate a purpose hint so the tree stays scannable. */
const SUMMARY_LEN = 80
const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`
/** Count path depth relative to the scope root (number of `/` segments). */
const depthOf = (rel) => rel.split("/").length - 1
const aggregate = (files, maxDepth, maxFiles) => {
  const byDir = new Map()
  const deepRollup = new Map()
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
  const renderedFiles = []
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
const NOISE_CHECKS = [
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
export const isNoiseLine = (line) => NOISE_CHECKS.some((check) => check(line))
/** Parse `path:line:text` rows from the purpose pass (rg -m 5 output) into a
 *  `relpath → hint` map. For each file, the first non-noise candidate line
 *  wins. The hint is the trimmed match line, capped. Exported pure for tests. */
export const parsePurposeRows = (stdout) => {
  const map = new Map()
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
/** Render the aggregate as an indented tree, directories sorted, files sorted
 *  within each directory, per-directory count shown. When `summaries` is
 *  given, each file gets a ` — <first-decl/comment>` purpose annotation. */
const render = (agg, maxFiles, summaries) => {
  if (agg.byDir.size === 0 && agg.deepRollup.size === 0) return "(no files)"
  const dirs = [...agg.byDir.keys()].sort((a, b) => byteCompare(a, b))
  const out = []
  const purposeOf = (dir, base) => {
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
export const fileTreeSummaryTool = {
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
  async *execute(input, ctx) {
    const maxDepth = input.max_depth ?? DEFAULT_DEPTH
    const maxFiles = input.max_files ?? DEFAULT_MAX_FILES
    // S14: jail-validate the model-supplied path BEFORE building argv.
    let jailedPath
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
    // Optional purpose layer: one extra `rg -m5` pass extracting up to 5
    // candidate lines per file so parsePurposeRows can skip noise lines and
    // return the first surviving non-noise line. Scans EXACTLY the files that
    // render() will emit (agg.renderedFiles, capped at SUMMARY_FILE_CAP) —
    // never the entire jailed scope. Failure degrades to structure-only tree.
    let summaries
    if (input.summarize === true) {
      yield { type: "progress", message: "extracting per-file purpose…" }
      // Target the exact rendered files, capped.
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
    yield { type: "result", result: { ok: true, output: render(agg, maxFiles, summaries) } }
  },
}
