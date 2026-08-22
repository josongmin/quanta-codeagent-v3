/**
 * `git_moved_code` — surface the moved-code classifier (ADR-0109) as a typed
 * first-class git tool so the `pr-review-canvas` system skill (and any future
 * loop consumer) can call it the same way it calls `git_diff`.
 *
 * Pipeline: shell `git diff [--staged] [base] [-- paths]` exactly like
 * {@link gitDiffTool} (same argv discipline, same leading-dash rejection on
 * `base`, same exit-0/1 = success / >1 = failure semantics), parse the unified
 * diff with the existing pure parser, and pass the resulting `DiffHunk[]` to
 * the pure `classifyDiff` from `./moved-code`. The classifier already has
 * 19 hellgate cases; this tool only owns the SHELL + I/O + FORMATTING shell.
 *
 * READ-ONLY, CONCURRENCY-SAFE — runs `git diff` only, no mutation.
 *
 * SECURITY: same argv-injection posture as `git_diff` — `base` is a bare
 * positional that MUST precede the `--` path separator, so a leading-dash
 * `base` (`--output=…`, `-G…`, `--ext-diff`) is rejected before reaching argv.
 * Any user-supplied `paths` go AFTER the `--` separator so user input cannot
 * become a `git` option.
 */
import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type ClassifyOptions, classifyDiff, parseUnifiedDiff } from "./moved-code"
import type { GitRunner } from "./types"

const MAX_OUTPUT = 50_000
const GIT_MOVED_CODE_DEFAULT_MAX_PAIRS = 2_000
const GIT_MOVED_CODE_MAX_PAIRS_CEILING = 10_000

/** Same rejection sentinel as `gitDiffTool` — see `./diff.ts`. */
class GitMovedCodeBaseRejected extends Error {
  constructor(base: string) {
    super(
      `invalid base revision '${base}': a revision must not begin with '-' ` +
        "(would be parsed as a git option)",
    )
    this.name = "GitMovedCodeBaseRejected"
  }
}

export const gitMovedCodeInputSchema = z.object({
  /** Revision to diff against (e.g. `HEAD`, `main`). Rejected if it begins
   *  with `-` — see security note in module doc. */
  base: z.string().optional().describe("Revision to diff against (e.g. HEAD)"),
  /** Restrict diff to these path(s); placed AFTER `--` so they cannot be
   *  parsed as git options. */
  paths: z.array(z.string()).optional().describe("Restrict to these paths"),
  /** True ⇒ `git diff --staged`. */
  staged: z.boolean().optional().describe("Diff the staging area (index vs HEAD)"),
  /** Minimum Jaccard similarity for a moved pair, in [0, 1]. Default 0.85
   *  (matches `ClassifyOptions.minSimilarity` default in `./moved-code`). */
  minSimilarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum Jaccard similarity, 0..1 (default 0.85)"),
  /** Minimum normalized non-blank lines on EACH side of a candidate pair.
   *  Default 5 (matches `ClassifyOptions.minLines` default). */
  minLines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Min normalized lines per side (default 5)"),
  /** Cap on |removed|×|added| pair-product before detection is skipped.
   *  Default 2000; ceiling 10_000. The tool stays more conservative than the
   *  pure classifier by default, but the caller may widen only up to the
   *  classifier's documented worst-case cap. */
  maxPairs: z
    .number()
    .int()
    .positive()
    .max(GIT_MOVED_CODE_MAX_PAIRS_CEILING)
    .optional()
    .describe(
      `Max removed×added pair-product (default ${GIT_MOVED_CODE_DEFAULT_MAX_PAIRS}, ceiling ${GIT_MOVED_CODE_MAX_PAIRS_CEILING})`,
    ),
})
export type GitMovedCodeInput = z.infer<typeof gitMovedCodeInputSchema>

const truncate = (s: string): string => {
  if (s.length <= MAX_OUTPUT) return s
  return `${s.slice(0, MAX_OUTPUT)}\n… (truncated, ${s.length - MAX_OUTPUT} more chars)`
}

const buildArgs = (input: GitMovedCodeInput): string[] => {
  const args: string[] = ["diff"]
  if (input.staged) args.push("--staged")
  if (input.base?.startsWith("-")) {
    throw new GitMovedCodeBaseRejected(input.base)
  }
  if (input.base) args.push(input.base)
  if (input.paths && input.paths.length > 0) args.push("--", ...input.paths)
  return args
}

/** CONDITION-SPREAD pattern: only emit keys whose input was actually present,
 *  so the resulting `ClassifyOptions` is byte-identical to `{}` when none of
 *  the threshold inputs were supplied — exact-optional-property-types strict
 *  (no `key: undefined` slipping through). */
const buildOptions = (input: GitMovedCodeInput): ClassifyOptions => {
  const opts: { -readonly [K in keyof ClassifyOptions]: ClassifyOptions[K] } = {}
  if (input.minSimilarity !== undefined) opts.minSimilarity = input.minSimilarity
  if (input.minLines !== undefined) opts.minLines = input.minLines
  if (input.maxPairs !== undefined) {
    opts.maxPairs = Math.min(input.maxPairs, GIT_MOVED_CODE_MAX_PAIRS_CEILING)
  } else {
    opts.maxPairs = GIT_MOVED_CODE_DEFAULT_MAX_PAIRS
  }
  return opts
}

interface CountSplit {
  added: number
  removed: number
}

const countByKind = (hunks: ReadonlyArray<{ kind: "added" | "removed" }>): CountSplit => {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    if (h.kind === "added") added += 1
    else removed += 1
  }
  return { added, removed }
}

const formatMovedLine = (
  m: {
    fromFile: string
    fromStartLine: number
    fromEndLine: number
    toFile: string
    toStartLine: number
    toEndLine: number
    similarity: number
  },
  idx: number,
): string => {
  const lines = m.toEndLine - m.toStartLine + 1
  const sim = m.similarity.toFixed(2)
  return (
    `  ${idx + 1}. similarity=${sim}  ` +
    `${m.fromFile}:${m.fromStartLine}-${m.fromEndLine} → ` +
    `${m.toFile}:${m.toStartLine}-${m.toEndLine}  (${lines} lines)`
  )
}

const formatLogicLine = (h: {
  file: string
  startLine: number
  endLine: number
  kind: "added" | "removed"
}): string => `  - ${h.file}:${h.startLine}-${h.endLine}  (${h.kind})`

const formatClassification = (
  totalHunks: number,
  counts: CountSplit,
  classification: {
    readonly moved: readonly {
      fromFile: string
      fromStartLine: number
      fromEndLine: number
      toFile: string
      toStartLine: number
      toEndLine: number
      similarity: number
    }[]
    readonly logic: readonly {
      file: string
      startLine: number
      endLine: number
      kind: "added" | "removed"
    }[]
    readonly mechanical: readonly { file: string }[]
  },
): string => {
  const lines: string[] = []
  lines.push(`Classified ${totalHunks} hunks (${counts.removed} removed / ${counts.added} added):`)
  lines.push(`  moved:      ${classification.moved.length} pairs`)
  lines.push(`  logic:      ${classification.logic.length} hunks`)
  lines.push(`  mechanical: ${classification.mechanical.length} hunks`)
  if (classification.moved.length > 0) {
    lines.push("")
    lines.push("Moved pairs (highest similarity first):")
    for (let i = 0; i < classification.moved.length; i += 1) {
      const m = classification.moved[i]
      if (m === undefined) continue
      lines.push(formatMovedLine(m, i))
    }
  }
  if (classification.logic.length > 0) {
    lines.push("")
    lines.push("Logic hunks (need review):")
    for (const h of classification.logic) {
      lines.push(formatLogicLine(h))
    }
  }
  return lines.join("\n")
}

export const gitMovedCodeTool = (runner: GitRunner): Tool<GitMovedCodeInput> => ({
  name: "git_moved_code",
  description: "Classify hunks in a git diff as moved-vs-logic so reviewers see signal, not noise.",
  inputSchema: gitMovedCodeInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitMovedCodeInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitMovedCodeInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    let args: string[]
    try {
      args = buildArgs(parsed.data)
    } catch (e) {
      if (e instanceof GitMovedCodeBaseRejected) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
    yield { type: "progress", message: `git ${args.join(" ")}` }

    const out = await safeRun(runner, args, ctx.cwd, "git diff", ctx.signal)
    if (out.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: out.message } }
      return
    }
    const r = out.result
    // git diff exits 0 (no diff) and 1 (has diff) — both are OK; >1 is failure.
    if (r.exitCode > 1) {
      yield {
        type: "result",
        result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git diff") },
      }
      return
    }
    const body = r.stdout.trimEnd()
    if (body.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no diff to classify)" } }
      return
    }
    const hunks = parseUnifiedDiff(body)
    if (hunks.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no hunks)" } }
      return
    }
    const classification = classifyDiff(hunks, buildOptions(parsed.data))
    const counts = countByKind(hunks)
    const formatted = formatClassification(hunks.length, counts, classification)
    yield { type: "result", result: { ok: true, output: truncate(formatted) } }
  },
})
