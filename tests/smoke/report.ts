import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExpectSpec, ScenarioMeta, ScenarioResult } from "./types"

/**
 * Coverage report — answers "which agent use-cases does the battery exercise?"
 * by mining each scenario's `expect.json` (declared tools + safety sentinels)
 * and its depth/tags, then overlaying the run outcome.
 *
 * Two views:
 *   - Tool × depth matrix: for each tool, how many scenarios at each depth
 *     REQUIRE it (toolCalls.required). Surfaces gaps ("no tikitaka exercises
 *     bash").
 *   - Safety coverage: how many scenarios assert a `forbidden` tool sentinel.
 */

const DEPTHS = ["single", "medium", "tikitaka"] as const

const readExpect = (dir: string): ExpectSpec => {
  const p = join(dir, "expect.json")
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, "utf8")) as ExpectSpec
}

type CoverageFacts = {
  readonly toolByDepth: Map<string, Record<string, number>>
  readonly forbidden: Map<string, number>
  readonly withJudge: number
  readonly withContextRetention: number
  readonly withForbidden: number
}

const addCount = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const collectToolCoverage = (
  scenarios: readonly ScenarioMeta[],
): Map<string, Record<string, number>> => {
  const toolByDepth = new Map<string, Record<string, number>>()
  for (const meta of scenarios) {
    for (const tool of readExpect(meta.dir).toolCalls?.required ?? []) {
      const row = toolByDepth.get(tool) ?? {}
      row[meta.depth] = (row[meta.depth] ?? 0) + 1
      toolByDepth.set(tool, row)
    }
  }
  return toolByDepth
}

const collectAssertionCoverage = (
  scenarios: readonly ScenarioMeta[],
): Omit<CoverageFacts, "toolByDepth"> => {
  const forbidden = new Map<string, number>()
  let withJudge = 0
  let withContextRetention = 0
  let withForbidden = 0
  for (const meta of scenarios) {
    const spec = readExpect(meta.dir)
    for (const tool of spec.toolCalls?.forbidden ?? []) addCount(forbidden, tool)
    if ((spec.toolCalls?.forbidden ?? []).length > 0) withForbidden += 1
    if (spec.judge !== undefined) withJudge += 1
    if ((spec.contextRetention ?? []).length > 0) withContextRetention += 1
  }
  return { forbidden, withJudge, withContextRetention, withForbidden }
}

const collectCoverage = (scenarios: readonly ScenarioMeta[]): CoverageFacts => {
  return { toolByDepth: collectToolCoverage(scenarios), ...collectAssertionCoverage(scenarios) }
}

const toolDepthRows = (toolByDepth: ReadonlyMap<string, Record<string, number>>): string[] => {
  const pad = (value: string, width: number): string => value.padEnd(width)
  return [
    `  ${pad("tool", 16)}${DEPTHS.map((depth) => pad(depth, 10)).join("")}`,
    ...[...toolByDepth.keys()].sort().map((tool) => {
      const row = toolByDepth.get(tool) ?? {}
      return `  ${pad(tool, 16)}${DEPTHS.map((depth) => pad(String(row[depth] ?? 0), 10)).join("")}`
    }),
  ]
}

const resultSummary = (results: readonly ScenarioResult[]): string | null => {
  if (results.length === 0) return null
  const count = (status: ScenarioResult["status"]): number =>
    results.filter((result) => result.status === status).length
  return `results: ${count("passed")} passed · ${count("failed")} failed · ${count("skipped")} skipped`
}

export const renderCoverage = (
  scenarios: readonly ScenarioMeta[],
  results: readonly ScenarioResult[],
): string => {
  const facts = collectCoverage(scenarios)
  const lines: string[] = []
  lines.push("── coverage ──────────────────────────────")
  const byDepth = DEPTHS.map((d) => `${d}=${scenarios.filter((s) => s.depth === d).length}`).join(
    " · ",
  )
  lines.push(`scenarios: ${scenarios.length}  (${byDepth})`)
  lines.push("")
  lines.push("tool × depth (required):")
  lines.push(...toolDepthRows(facts.toolByDepth))
  lines.push("")
  lines.push(
    `assertions: ${facts.withForbidden} use forbidden-tool sentinels · ${facts.withContextRetention} context-retention · ${facts.withJudge} llm-judge`,
  )
  if (facts.forbidden.size > 0) {
    const fb = [...facts.forbidden.entries()].map(([t, n]) => `${t}(${n})`).join(" ")
    lines.push(`forbidden sentinels: ${fb}`)
  }

  const summary = resultSummary(results)
  if (summary) {
    lines.push("")
    lines.push(summary)
  }
  lines.push("──────────────────────────────────────────")
  return lines.join("\n")
}
