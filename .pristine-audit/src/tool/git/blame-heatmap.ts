import { byteCompare } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitBlameHeatmapInput, type GitRunner, gitBlameHeatmapInputSchema } from "./types"

/** Aggregate `git blame --line-porcelain` output into per-author line counts.
 *  The porcelain stream emits an `author <name>` header line for each source
 *  line; counting those gives the ownership distribution. Exported pure for
 *  unit tests. */
export const rankBlame = (
  stdout: string,
  topN: number,
): { author: string; lines: number; pct: number }[] => {
  const counts = new Map<string, number>()
  let total = 0
  for (const raw of stdout.split("\n")) {
    // Porcelain author header: `author Jane Doe` (NOT `author-mail`/`author-time`).
    if (raw.startsWith("author ")) {
      const name = raw.slice("author ".length).trim()
      if (name.length === 0) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
      total += 1
    }
  }
  if (total === 0) return []
  return [...counts.entries()]
    .map(([author, lines]) => ({ author, lines, pct: Math.round((lines / total) * 100) }))
    .sort((a, b) => (b.lines !== a.lines ? b.lines - a.lines : byteCompare(a.author, b.author)))
    .slice(0, topN)
}

const formatBody = (rows: { author: string; lines: number; pct: number }[]): string => {
  if (rows.length === 0) return "(no blame data — file empty, untracked, or not a git repo)"
  return rows
    .map((r) => `${String(r.pct).padStart(3)}%  ${String(r.lines).padStart(5)}  ${r.author}`)
    .join("\n")
}

export const gitBlameHeatmapTool = (runner: GitRunner): Tool<GitBlameHeatmapInput> => ({
  name: "git_blame_heatmap",
  description:
    "Per-author line-ownership distribution for one file, or a line range " +
    "(start_line/end_line → one function). Stage-1 ownership signal for fault " +
    "localization. Read-only.",
  inputSchema: gitBlameHeatmapInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitBlameHeatmapInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitBlameHeatmapInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { file, n, start_line, end_line } = parsed.data
    const topN = n ?? 10
    // `--line-porcelain` repeats the author header for every line (vs
    // `--porcelain` which dedups by commit) — exactly what per-line counting
    // needs. `-L <start>,<end>` scopes ownership to one region (e.g. a single
    // function) when both bounds are given. `--` guards a filename that could
    // look like a flag.
    const args = ["blame", "--line-porcelain"]
    if (start_line !== undefined && end_line !== undefined) {
      args.push("-L", `${start_line},${end_line}`)
    }
    args.push("--", file)

    const region = start_line !== undefined ? ` -L ${start_line},${end_line}` : ""
    yield { type: "progress", message: `git blame heatmap${region} -- ${file}` }

    const out = await safeRun(runner, args, ctx.cwd, "git blame", ctx.signal)
    if (out.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: out.message } }
      return
    }
    const r = out.result
    if (r.exitCode !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git blame") },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: formatBody(rankBlame(r.stdout, topN)) } }
  },
})
