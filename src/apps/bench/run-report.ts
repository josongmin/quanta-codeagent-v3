/**
 * Bench console-output concern — the operator-facing summary / help / preset
 * renderers extracted verbatim from `apps/bench/run-main.ts`. Pure logging:
 * no argv/env reads, no run logic.
 */
import { byteCompare, logger } from "@/shared"
import { runTokenCostLine } from "./analyze/cost"
import { aggregate, classify } from "./corpus"
import { resolvedTotals, scoreTotals } from "./observe"
import { renderBenchPresetListLines } from "./preset"
import type { BenchSummary, InstanceResult } from "./types"

/** Compact failure tag for the console FAIL line. Returns "" when the
 *  classification is `passed`. Examples:
 *    `[FAIL][admission_blocked]`
 *    `[FAIL][hung_stream:dirty_cache_leak]`
 *    `[FAIL][completed_unresolved:verify_loop_stuck]`
 *    `[FAIL][max_turns_exhausted]` (no signals) */
const failureTag = (r: InstanceResult): string => {
  if (r.passed) return ""
  const c = classify(r)
  if (c.termination === "passed") return ""
  const tail = c.signals.length > 0 ? `:${c.signals.join("+")}` : ""
  return `[${c.termination}${tail}]`
}

const logInstanceSummary = (result: InstanceResult): void => {
  const verdictValue = result.verdict ?? "ok"
  const verdict =
    verdictValue === "degraded"
      ? " DEGRADED"
      : verdictValue === "env_prep_failed"
        ? " ENV_PREP_FAILED"
        : verdictValue === "grader_invalid"
          ? " GRADER_INVALID"
          : ""
  const mark = result.passed ? "PASS" : "FAIL"
  const score = result.passed ? `[${result.scoreLabel ?? "unlabeled_pass"}]` : ""
  const tag = failureTag(result)
  const extra = result.error ? ` (${result.error})` : ""
  logger.info(`  [${mark}${verdict}]${score}${tag} ${result.id} (turns=${result.turns})${extra}`)
}

export const printHelp = (): void => {
  logger.info("quanta bench (legacy direct entrypoint)")
  logger.info("usage:")
  logger.info("  bun run src/apps/bench/cli.ts run [flags]")
  logger.info("  bun run src/apps/bench/index.ts [flags]")
  logger.info("")
  logger.info("common flags:")
  logger.info("  --swebench <dataset.jsonl>     official SWE-bench dataset mode")
  logger.info("  --corpus <dir>                 local corpus mode")
  logger.info("  --dry-run                      print the plan, do not build an LLM")
  logger.info("  --limit <N>                    cap selected instances")
  logger.info("  --n <N>                        best-of-N attempts")
  logger.info("  --repair-rounds <N>            explicit repair-loop override")
  logger.info("  --list-presets                 print bench presets")
}

export const printSummary = (summary: BenchSummary): void => {
  for (const result of summary.results) logInstanceSummary(result)
  // C8: the operator-visible headline uses the SAME degraded-excluding
  // denominator as observe.summarize / summary.json — never results.length.
  const { resolved, total, degraded } = resolvedTotals(summary.results)
  const score = scoreTotals(summary.results)
  const pct = total === 0 ? 0 : Math.round((resolved / total) * 100)
  const deg = degraded > 0 ? ` (${degraded} degraded)` : ""
  logger.info(`passed ${resolved}/${total} (${pct}%)${deg}`)
  logger.info(
    `score official_harness ${score.officialHarness}/${total} (${score.officialResolvedPct}%) | local_structural ${score.localStructural} | research_contaminated ${score.researchContaminated} | unlabeled_passed ${score.unlabeledPassed}`,
  )
  // Token/cost surfacing — active by default (observe is on), derived from the
  // SAME InstanceUsage that lands in report.json. Suppressed (byte-identical)
  // when no instance reported usage (e.g. usage-free synthetic corpus).
  const tokenLine = runTokenCostLine(summary.results)
  if (tokenLine !== undefined) logger.info(tokenLine)
  // Failure-pattern rollup — one line per axis, suppressed when 0 failed.
  const failed = summary.results.filter((r) => !r.passed).map((r) => classify(r))
  if (failed.length === 0) return
  const bd = aggregate(failed)
  const fmt = (obj: Record<string, number>): string =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1] || byteCompare(a[0], b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
  const termLine = fmt(bd.byTermination)
  if (termLine !== "") logger.info(`failures: ${termLine}`)
  const sigLine = fmt(bd.bySignal)
  if (sigLine !== "") logger.info(`signals: ${sigLine}`)
}

/** Render the available bench presets + their contents from the SSOT
 *  (`KNOB_PRESETS`) so the listing can never drift from what actually resolves.
 *  Triggered by `--list-presets`. */
export const printPresetList = (): void => {
  for (const line of renderBenchPresetListLines()) logger.info(line)
}
