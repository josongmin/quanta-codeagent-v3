/**
 * `quanta-bench` analysis subcommands — diff / explain / leaderboard / cost /
 * wave2-{ab,coverage,backlog} / presets. Extracted from cli.ts (ADR-0536 P0).
 * Thin glue over the analyze/ layer (separately tested). Moved verbatim.
 */
import { readFileSync } from "node:fs"
import { logger } from "@/shared"
import { costSummaryFromReport, renderCost } from "../analyze/cost"
import { diffRuns, renderDiff } from "../analyze/diff"
import { explainFailure } from "../analyze/explain"
import { renderLeaderboardMarkdown, rowsFromRun } from "../analyze/leaderboard"
import { loadVerdictsFromFile } from "../analyze/verdicts"
import {
  buildWave2AbRail,
  buildWave2BacklogArtifact,
  buildWave2CoverageCensus,
  renderWave2AbMarkdown,
  renderWave2BacklogMarkdown,
  renderWave2CoverageMarkdown,
} from "../analyze/wave2-analysis"
import { renderBenchPresetListLines } from "../preset"
import { argValue, positionals, printBlock } from "./shared"

export const cmdDiff = (): void => {
  const [a, b] = positionals()
  if (a === undefined || b === undefined) {
    logger.info("usage: quanta-bench diff <reportA.json> <reportB.json>")
    process.exit(2)
  }
  printBlock(renderDiff(diffRuns(loadVerdictsFromFile(a), loadVerdictsFromFile(b))))
}

export const cmdExplain = (): void => {
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  const instance = argValue("--instance")
  if (dataset === undefined || instance === undefined) {
    logger.info(
      "usage: quanta-bench explain --dataset <instances.jsonl> --instance <id> [--patch <agent.patch>]",
    )
    process.exit(2)
  }
  const patch = argValue("--patch")
  const e = explainFailure({
    datasetPath: dataset,
    instanceId: instance,
    ...(patch !== undefined ? { agentPatchPath: patch } : {}),
  })
  printBlock(e.summary)
}

export const cmdLeaderboard = (): void => {
  const reports = positionals()
  if (reports.length === 0) {
    logger.info(
      "usage: quanta-bench leaderboard <report.json> [more.json …] [--preset name] [--title T]",
    )
    process.exit(2)
  }
  // Profile is AUTO-DETECTED per report from `report.knobs.preset` (each run
  // records the preset it ran under), so combining reports from different
  // profiles labels each instance with the preset it was ACTUALLY resolved
  // under — never a single blanket label. `--preset` is an explicit override.
  const presetOverride = argValue("--preset")
  const rows = reports.flatMap((p) => {
    const verdicts = loadVerdictsFromFile(p)
    const meta = (() => {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as {
          model?: string
          knobs?: { preset?: string }
        }
      } catch {
        return {} as { model?: string; knobs?: { preset?: string } }
      }
    })()
    const model = meta.model ?? "unknown"
    const preset = presetOverride ?? meta.knobs?.preset ?? "unknown"
    return rowsFromRun(verdicts, { preset, model })
  })
  printBlock(renderLeaderboardMarkdown(rows, argValue("--title") ?? "SWE-bench leaderboard"))
}

export const cmdCost = (): void => {
  const [report] = positionals()
  if (report === undefined) {
    logger.info("usage: quanta-bench cost <report.json> [--observe-dir <dir>]")
    process.exit(2)
  }
  const observeDir = argValue("--observe-dir")
  printBlock(
    renderCost(
      costSummaryFromReport({
        reportPath: report,
        ...(observeDir !== undefined ? { observeDir } : {}),
      }),
    ),
  )
}

export const cmdWave2Ab = (): void => {
  const [controlReport, treatmentReport] = positionals()
  const controlPredictions = argValue("--control-predictions")
  const treatmentPredictions = argValue("--treatment-predictions")
  if (
    controlReport === undefined ||
    treatmentReport === undefined ||
    controlPredictions === undefined ||
    treatmentPredictions === undefined
  ) {
    logger.info(
      "usage: quanta-bench wave2-ab <control-report.json> <treatment-report.json> --control-predictions <control.jsonl> --treatment-predictions <treatment.jsonl>",
    )
    process.exit(2)
  }
  printBlock(
    renderWave2AbMarkdown(
      buildWave2AbRail({
        controlReportPath: controlReport,
        controlPredictionsPath: controlPredictions,
        treatmentReportPath: treatmentReport,
        treatmentPredictionsPath: treatmentPredictions,
      }),
    ),
  )
}

export const cmdWave2Coverage = (): void => {
  const dataset = argValue("--dataset")
  const report = argValue("--report")
  const predictions = argValue("--predictions")
  if (dataset === undefined || report === undefined || predictions === undefined) {
    logger.info(
      "usage: quanta-bench wave2-coverage --dataset <instances.jsonl> --report <report.json> --predictions <predictions.jsonl> [--limit N] [--min-cases N]",
    )
    process.exit(2)
  }
  const limit = argValue("--limit")
  const minCases = argValue("--min-cases")
  printBlock(
    renderWave2CoverageMarkdown(
      buildWave2CoverageCensus({
        datasetPath: dataset,
        reportPath: report,
        predictionsPath: predictions,
        ...(limit !== undefined ? { limit: Number.parseInt(limit, 10) } : {}),
        ...(minCases !== undefined ? { minCases: Number.parseInt(minCases, 10) } : {}),
      }),
    ),
  )
}

export const cmdWave2Backlog = (): void => {
  const dataset = argValue("--dataset")
  const report = argValue("--report")
  const predictions = argValue("--predictions")
  if (dataset === undefined || report === undefined || predictions === undefined) {
    logger.info(
      "usage: quanta-bench wave2-backlog --dataset <instances.jsonl> --report <report.json> --predictions <predictions.jsonl>",
    )
    process.exit(2)
  }
  printBlock(
    renderWave2BacklogMarkdown(
      buildWave2BacklogArtifact({
        datasetPath: dataset,
        reportPath: report,
        predictionsPath: predictions,
      }),
    ),
  )
}

export const cmdPresets = (): void => {
  for (const line of renderBenchPresetListLines()) logger.info(line)
}
