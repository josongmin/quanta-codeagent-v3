/**
 * `coverage_check` tool (ADR-0165) — code-coverage observability slice.
 *
 * Reads a V8-shape coverage JSON (`bun test --coverage` /
 * `node --experimental-vm-modules --coverage`), produces a per-file +
 * totals report, and gates against an optional threshold. The model
 * receives a formatted table per file + the verdict; `ok:false` on a
 * crossed threshold OR a coverage-source error.
 *
 * Slice posture (RFC §3.1):
 *   - Imports `@/observability/coverage` (the coverage slice), `@/storage`
 *     (FS jail — `resolveJailedDoc` chokepoint), `zod`, `node:fs/promises`,
 *     and the local `./types`. NO `@/agent`, `@/permission`, `@/memory`.
 *   - No-throw: every failure mode yields a typed `ok:false` `ToolResult`.
 *
 * Path safety:
 *   - Resolved through `resolveJailedDoc` — same chokepoint
 *     `read`/`csv_read`/`pdf_read` use (lexical normalize + realpath of
 *     existing parent + segment-boundary containment).
 *   - Symbolic link to the coverage JSON is REJECTED (the V8 coverage
 *     file is an operator artifact; a symlinked path is always a misuse).
 *
 * Default-OFF: caller invokes this tool explicitly with the V8 JSON path —
 * sessions that never call it are byte-identical.
 */

import { lstat } from "node:fs/promises"
import { z } from "zod"
import {
  CoverageError,
  type CoverageReport,
  type CoverageThreshold,
  type CoverageVerdict,
  defaultCoverageReporter,
  defaultV8CoverageSource,
  type FileCoverage,
} from "@/observability/coverage"
import { FsJailError } from "@/storage"
import { resolveJailedDoc } from "./_shared/resolve-jailed-doc"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types"

export const coverageCheckInputSchema = z.object({
  coverageJsonPath: z
    .string()
    .min(1)
    .describe("Repo-relative or absolute path to a V8 coverage JSON file"),
  thresholdLines: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Minimum required total line coverage percentage (0..100)"),
  thresholdBranches: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Minimum required total branch coverage percentage (0..100)"),
  thresholdStatements: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Minimum required total statement coverage percentage (0..100)"),
})
export type CoverageCheckInput = z.infer<typeof coverageCheckInputSchema>

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Convert validated input into the `CoverageThreshold` shape the reporter
 *  expects (only present fields are forwarded — exactOptionalPropertyTypes
 *  strict). */
const buildThreshold = (input: CoverageCheckInput): CoverageThreshold => {
  const t: {
    linesPercent?: number
    branchesPercent?: number
    statementsPercent?: number
  } = {}
  if (input.thresholdLines !== undefined) t.linesPercent = input.thresholdLines
  if (input.thresholdBranches !== undefined) t.branchesPercent = input.thresholdBranches
  if (input.thresholdStatements !== undefined) t.statementsPercent = input.thresholdStatements
  return t
}

/** Format a single file row. Per-file lines are sorted by ascending lines%
 *  so the worst-covered files surface at the top. */
const renderFileRow = (f: FileCoverage): string =>
  `  ${f.linesPercent.toFixed(1).padStart(5)}% lines | ` +
  `${f.branchesPercent.toFixed(1).padStart(5)}% branches | ` +
  `${f.statementsPercent.toFixed(1).padStart(5)}% statements  ${f.file}`

const renderReport = (report: CoverageReport, verdict: CoverageVerdict): string => {
  const sortedFiles = [...report.files].sort((a, b) => a.linesPercent - b.linesPercent)
  const lines: string[] = []
  lines.push(`Coverage report (${report.totals.fileCount} files):`)
  for (const f of sortedFiles) lines.push(renderFileRow(f))
  lines.push("")
  lines.push(
    `Totals: ${report.totals.linesPercent}% lines | ${report.totals.branchesPercent}% branches | ${report.totals.statementsPercent}% statements`,
  )
  if (verdict.kind === "fail") {
    lines.push("")
    lines.push("FAIL — thresholds crossed:")
    for (const r of verdict.reasons) lines.push(`  - ${r}`)
  } else {
    lines.push("")
    lines.push("PASS")
  }
  return lines.join("\n")
}

/** Pre-flight: schema parse + abort + path resolve via FS jail + symlink
 *  reject. */
const preflight = async (
  input: unknown,
  ctx: ToolContext,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok"; abs: string; parsed: CoverageCheckInput }> => {
  const parsed = coverageCheckInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, parsed.data.coverageJsonPath, "coverage")
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        kind: "fail",
        result: errResult(`path outside cwd: ${parsed.data.coverageJsonPath}`, {
          mode: "permission_denied",
          path: parsed.data.coverageJsonPath,
          isReadonly: false,
        }),
      }
    }
    throw e
  }
  try {
    const st = await lstat(abs)
    if (st.isSymbolicLink()) {
      return {
        kind: "fail",
        result: errResult(`symlink not allowed: ${parsed.data.coverageJsonPath}`, {
          mode: "permission_denied",
          path: parsed.data.coverageJsonPath,
          isReadonly: false,
        }),
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isEnoent =
      typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT"
    return {
      kind: "fail",
      result: errResult(
        isEnoent ? `File not found: ${parsed.data.coverageJsonPath}` : `lstat failed: ${msg}`,
        isEnoent
          ? { mode: "not_found", path: parsed.data.coverageJsonPath }
          : { mode: "error", modelVisibleError: msg },
      ),
    }
  }
  return { kind: "ok", abs, parsed: parsed.data }
}

export const coverageCheckTool: Tool<CoverageCheckInput> = {
  name: "coverage_check",
  description:
    "Read a V8 coverage JSON and report per-file + total line/branch/statement " +
    "coverage. Optionally gates against minimum threshold percentages and emits " +
    "ok:false on a crossed threshold or a missing/malformed coverage file.",
  inputSchema: coverageCheckInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: CoverageCheckInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const pre = await preflight(input, ctx)
    if (pre.kind === "fail") {
      yield { type: "result", result: pre.result }
      return
    }
    let report: CoverageReport
    try {
      report = await defaultV8CoverageSource().read(pre.abs)
    } catch (e) {
      if (e instanceof CoverageError) {
        yield {
          type: "result",
          result: errResult(`coverage: ${e.code}: ${e.message}`, {
            mode: e.code === "io-failed" ? "not_found" : "error",
            ...(e.code !== "io-failed" ? { modelVisibleError: e.code } : {}),
          }),
        }
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      yield {
        type: "result",
        result: errResult(`coverage: unexpected error: ${msg}`, {
          mode: "error",
          modelVisibleError: msg,
        }),
      }
      return
    }
    const threshold = buildThreshold(pre.parsed)
    const verdict = defaultCoverageReporter().evaluate(report, { threshold })
    const output = renderReport(report, verdict)
    yield {
      type: "result",
      result:
        verdict.kind === "pass"
          ? { ok: true, output }
          : {
              ok: false,
              output,
              failure: {
                mode: "rejected",
                reason: `coverage_threshold_failed:${verdict.reasons.join(";")}`,
              },
            },
    }
  },
}
