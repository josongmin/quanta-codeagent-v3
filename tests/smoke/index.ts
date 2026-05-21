#!/usr/bin/env bun
/**
 * Smoke battery CLI entry.
 *
 *   bun run smoke                      # all scenarios, tier-0 replay (default)
 *   bun run smoke --depth=single       # filter by depth
 *   bun run smoke 01-read-summarize    # single scenario by id
 *   bun run smoke --tier=live          # hit the real provider (or QUANTA_SMOKE_LIVE=1)
 *   bun run smoke --report             # print the coverage report
 *
 * Exit code: 0 = all passed (or skipped), 1 = ≥1 failed, 2 = usage error.
 * Skipped scenarios (no trajectory / no provider key) do NOT fail the battery —
 * they are surfaced in the summary so coverage gaps stay visible.
 */

import { formatResult } from "./expect"
import { renderCoverage } from "./report"
import { discoverScenarios, runScenario, type SmokeTier } from "./runner"
import type { Depth, ScenarioResult } from "./types"

const isDepth = (s: string): s is Depth => s === "single" || s === "medium" || s === "tikitaka"

interface Args {
  depth?: Depth
  id?: string
  tier: SmokeTier
  report: boolean
}

const parseArgs = (argv: readonly string[]): Args => {
  const out: Args = {
    tier: process.env.QUANTA_SMOKE_LIVE === "1" ? "live" : "replay",
    report: false,
  }
  for (const arg of argv) {
    if (arg.startsWith("--depth=")) {
      const d = arg.slice("--depth=".length)
      if (!isDepth(d)) {
        process.stderr.write(`smoke: unknown depth "${d}" (single|medium|tikitaka)\n`)
        process.exit(2)
      }
      out.depth = d
    } else if (arg.startsWith("--tier=")) {
      const t = arg.slice("--tier=".length)
      if (t !== "replay" && t !== "live") {
        process.stderr.write(`smoke: unknown tier "${t}" (replay|live)\n`)
        process.exit(2)
      }
      out.tier = t
    } else if (arg === "--report") {
      out.report = true
    } else if (!arg.startsWith("--")) {
      out.id = arg
    }
  }
  return out
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const scenarios = discoverScenarios(
    args.depth !== undefined || args.id !== undefined
      ? {
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.id !== undefined ? { id: args.id } : {}),
        }
      : undefined,
  )
  if (scenarios.length === 0) {
    process.stderr.write("smoke: no scenarios matched the filter\n")
    process.exit(2)
  }

  process.stdout.write(`smoke: tier=${args.tier} · ${scenarios.length} scenario(s)\n`)
  const results: ScenarioResult[] = []
  for (const meta of scenarios) {
    const r = await runScenario(meta, { tier: args.tier })
    results.push(r)
    process.stdout.write(`${formatResult(r)}\n`)
  }

  const passed = results.filter((r) => r.status === "passed").length
  const failed = results.filter((r) => r.status === "failed").length
  const skipped = results.filter((r) => r.status === "skipped").length
  process.stdout.write(
    `\nsmoke: ${passed} passed · ${failed} failed · ${skipped} skipped (${results.length} total)\n`,
  )
  if (args.report) process.stdout.write(`\n${renderCoverage(scenarios, results)}\n`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
