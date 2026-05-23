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
  rank: z
    .enum(["alpha", "recency", "size"])
    .optional()
    .describe(
      "How to order dirs in the rendered tree. 'alpha' (default) = byte-sorted; " +
        "'size' = by file count desc, tie-break by byte-sort; " +
        "'recency' = by recent git change hits desc (30d window), tie-break by byte-sort.",
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

/**
 * Parse `git log --since=30d --name-only --pretty=format:` stdout into a
 * dir → hit-count map. Every parent directory of each changed file path gets
 * +1. Pure function (no I/O) — fully unit-testable.
 */
export const parseRecencyHits = (stdout) => {
  const hits = new Map()
  for (const line of stdout.split("\n")) {
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

/** Comparator: sort directories by rank strategy. */
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

/**
 * Build per-dir extension breakdown string for the dir-header.
 * Rule (exact — no fuzzy): show ONLY IF dir has ≥3 files AND ≥2 distinct exts.
 * Returns top-3 exts by count, formatted as `ext=N ext=N ext=N`.
 * Returns "" if condition not met (caller shows bare count).
 * Pure function — no I/O.
 */
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
export const parsePurposeRows = (stdout) => {
  const map = new Map()
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

/** Emit one rollup line in the canonical form.
 *  Indent is determined by the segment depth of the ancestor path. */
const rollupLine = (ancestor, count) => {
  const depth = ancestor === "." ? 0 : ancestor.split("/").length
  const indent = "  ".repeat(depth + 1)
  return `${indent}${ancestor}/ …/ (+${count} deeper, increase max_depth)`
}

/** Append lines for orphan deep-rollup ancestors (those not in byDir). */
const appendOrphanRollups = (out, agg) => {
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
const render = (agg, maxFiles, summaries, rank = "alpha", recencyHits = new Map()) => {
  if (agg.byDir.size === 0 && agg.deepRollup.size === 0) return "(no files)"
  const cmp = makeDirComparator(rank, agg.byDir, recencyHits)
  const dirs = [...agg.byDir.keys()].sort(cmp)
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
    out.push(`… (file cap ${maxFiles} reached — narrow with path or raise max_files)`)
  }
  return out.join("\n")
}

/** Fetch recency hit-counts via a single git-log call.
 *  Returns an empty map on any failure (non-git dir, no commits, etc.) so
 *  callers silently fall back to alpha ordering. */
const fetchRecencyHits = async (cwd, signal) => {
  const gr = await runShell("git log --since='30 days ago' --name-only --pretty=format:", {
    cwd,
    signal,
  })
  if (gr.exitCode === 0 && !gr.timedOut) return parseRecencyHits(gr.stdout)
  return new Map()
}

/** Run the per-file purpose ripgrep pass and return the summaries map.
 *  Returns undefined on failure (degrades to structure-only tree). */
const fetchSummaries = async (jailedPath, cwd, signal) => {
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
  const pr = await runShell(purposeParts.join(" "), { cwd, signal })
  if (pr.exitCode <= 1 && !pr.timedOut) {
    const rows = pr.stdout.trimEnd().split("\n").slice(0, SUMMARY_FILE_CAP).join("\n")
    return parsePurposeRows(rows)
  }
  return undefined
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

    // Recency ranking: ONE git-log call, placed AFTER the rg --files block.
    // Failure (non-git dir, no commits, etc.) silently falls back to "alpha".
    const rank = input.rank ?? "alpha"
    const recencyHits = rank === "recency" ? await fetchRecencyHits(ctx.cwd, ctx.signal) : new Map()

    // Optional purpose layer: one extra `rg -m1` pass extracting the first
    // declaration/comment line per file (capped). Failure here degrades to a
    // structure-only tree — the purpose hint is a bonus, never load-bearing.
    let summaries
    if (input.summarize === true) {
      yield { type: "progress", message: "extracting per-file purpose…" }
      summaries = await fetchSummaries(jailedPath, ctx.cwd, ctx.signal)
    }

    yield {
      type: "result",
      result: { ok: true, output: render(agg, maxFiles, summaries, rank, recencyHits) },
    }
  },
}
