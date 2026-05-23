import { existsSync } from "node:fs"
import { z } from "zod"
import { runShell } from "@/runtime"
import { byteCompare } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"

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
      "Annotate each file with its first declaration/comment line (purpose hint). Adds one ripgrep pass; capped at 200 files for cost.",
    ),
  rank: z
    .enum(["alpha", "recency", "size"])
    .optional()
    .describe(
      "How to order dirs in the rendered tree. 'alpha' (default) = byte-sorted; 'size' = by file count desc, tie-break by byte-sort; 'recency' = by recent git change hits desc (30d window), tie-break by byte-sort.",
    ),
})
const DEFAULT_DEPTH = 3
const DEFAULT_MAX_FILES = 400
const SUMMARY_FILE_CAP = 200
const SUMMARY_LEN = 80
const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`
export const collectIgnoreFiles = (scopeRoot, ctxCwd) => {
  const names = [".quantaignore", ".cursorignore", ".cursorindexignore"]
  const result = []
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
const depthOf = (rel) => rel.split("/").length - 1
export const parseRecencyHits = (stdout) => {
  const hits = new Map()
  for (const line of stdout.split(`
`)) {
    const p = line.trim()
    if (p.length === 0) continue
    const segs = p.split("/")
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/")
      hits.set(dir, (hits.get(dir) ?? 0) + 1)
    }
    if (segs.length === 1) {
      hits.set(".", (hits.get(".") ?? 0) + 1)
    }
  }
  return hits
}
export const makeDirComparator = (rank, byDir, recencyHits) => {
  if (rank === "alpha") return (a, b) => byteCompare(a, b)
  if (rank === "size") {
    return (a, b) => {
      const diff = (byDir.get(b)?.length ?? 0) - (byDir.get(a)?.length ?? 0)
      return diff !== 0 ? diff : byteCompare(a, b)
    }
  }
  return (a, b) => {
    const diff = (recencyHits.get(b) ?? 0) - (recencyHits.get(a) ?? 0)
    return diff !== 0 ? diff : byteCompare(a, b)
  }
}
export const extBreakdown = (files) => {
  if (files.length < 3) return ""
  const counts = new Map()
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
const PURPOSE_RE = String.raw`^\s*(?:export\s|def\s|class\s|func\s|function\s|interface\s|type\s|fn\s|pub\s|public\s|module\.exports|//|#|/\*\*?)`
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
  (l) => /^["']use (?:strict|client|server)["'];?$/.test(l),
  (l) => l.startsWith("#!"),
]
const isNoiseLine = (line) => NOISE_CHECKS.some((check) => check(line))
export const parsePurposeRows = (stdout) => {
  const map = new Map()
  for (const row of stdout.split(`
`)) {
    const m = row.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue
    const file = m[1]
    const text = (m[3] ?? "").trim()
    if (!file || text.length === 0) continue
    if (map.has(file)) continue
    if (isNoiseLine(text)) continue
    map.set(file, text.length > SUMMARY_LEN ? `${text.slice(0, SUMMARY_LEN)}\u2026` : text)
  }
  return map
}

export { isNoiseLine }

const rollupLine = (ancestor, count) => {
  const depth = ancestor === "." ? 0 : ancestor.split("/").length
  const indent = "  ".repeat(depth + 1)
  return `${indent}${ancestor}/ \u2026/ (+${count} deeper, increase max_depth)`
}
const appendOrphanRollups = (out, agg) => {
  for (const [ancestor, count] of [...agg.deepRollup.entries()].sort((a, b) =>
    byteCompare(a[0], b[0]),
  )) {
    if (!agg.byDir.has(ancestor)) out.push(rollupLine(ancestor, count))
  }
}
const render = (agg, maxFiles, summaries, rank = "alpha", recencyHits = new Map()) => {
  if (agg.byDir.size === 0 && agg.deepRollup.size === 0) return "(no files)"
  const cmp = makeDirComparator(rank, agg.byDir, recencyHits)
  const dirs = [...agg.byDir.keys()].sort(cmp)
  const out = []
  const purposeOf = (dir, base) => {
    if (summaries === undefined) return ""
    const rel = dir === "." ? base : `${dir}/${base}`
    const hint = summaries.get(rel)
    return hint ? `  \u2014 ${hint}` : ""
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
    if (rolled !== undefined) out.push(rollupLine(dir, rolled))
  }
  appendOrphanRollups(out, agg)
  if (agg.truncated) {
    out.push(`\u2026 (file cap ${maxFiles} reached \u2014 narrow with path or raise max_files)`)
  }
  return out.join(`
`)
}
const fetchRecencyHits = async (cwd, signal) => {
  const gr = await runShell("git log --since='30 days ago' --name-only --pretty=format:", {
    cwd,
    signal,
  })
  if (gr.exitCode === 0 && !gr.timedOut) return parseRecencyHits(gr.stdout)
  return new Map()
}
export const inferNextAction = (agg, maxDepth, maxFiles) => {
  const hasDeepRollup = agg.deepRollup.size > 0
  const hasTruncated = agg.truncated
  if (hasDeepRollup) {
    const hiddenFiles = [...agg.deepRollup.values()].reduce((sum, n) => sum + n, 0)
    const suggested = Math.min(maxDepth * 2, 10)
    return {
      kind: "increase_max_depth",
      suggested,
      reason: `${hiddenFiles} file${hiddenFiles === 1 ? "" : "s"} beyond depth ${maxDepth} \u2014 set max_depth to at least ${suggested}`,
    }
  }
  if (hasTruncated) {
    const suggested = maxFiles * 2
    return {
      kind: "raise_max_files",
      suggested,
      reason: `file cap ${maxFiles} reached \u2014 raise max_files to at least ${suggested} or narrow with path`,
    }
  }
  return
}
export const fileTreeSummaryTool = {
  name: "file_tree_summary",
  description:
    "Summarize a repo's directory STRUCTURE (depth-bounded tree + per-dir file " +
    "counts, .gitignore-respecting). Stage 1 of fault localization \u2014 see where " +
    "modules live before reading files. Pass summarize:true to annotate each file with its first declaration/comment (a cheap purpose hint). CAP RESPONSE (ADR-0062): when the output contains '+N deeper, increase " +
    "max_depth' or 'file cap \u2026 reached \u2014 narrow with path or raise max_files', " +
    "the NEXT call MUST apply that suggestion (double max_depth, narrow path, or raise max_files) before switching tools or asking the user to narrow " +
    "down. The cap message names the exact next parameter \u2014 apply it.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx) {
    const maxDepth = input.max_depth ?? DEFAULT_DEPTH
    const maxFiles = input.max_files ?? DEFAULT_MAX_FILES
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
    yield { type: "progress", message: `summarizing tree (depth ${maxDepth})\u2026` }
    const parts = ["rg", "--files", "--color=never"]
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
      .split(`
`)
      .filter((l) => l.length > 0)
    if (files.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no files)" } }
      return
    }
    const agg = aggregate(files, maxDepth, maxFiles)
    const rank = input.rank ?? "alpha"
    const recencyHits = rank === "recency" ? await fetchRecencyHits(ctx.cwd, ctx.signal) : new Map()
    let summaries
    if (input.summarize === true) {
      yield { type: "progress", message: "extracting per-file purpose\u2026" }
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
