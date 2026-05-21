#!/usr/bin/env bun
/**
 * Smoke battery CLI entry (Phase 1 — tier-0 replay).
 *
 *   bun run smoke                      # all scenarios, tier-0 replay
 *   bun run smoke --depth=single       # filter by depth
 *   bun run smoke 01-read-summarize    # single scenario by id
 *
 * Exit code: 0 = all passed (or skipped), 1 = ≥1 failed, 2 = usage error.
 * Skipped scenarios (no trajectory.jsonl) do NOT fail the battery — they are
 * pending recordings, surfaced in the summary so coverage gaps are visible.
 */

import { formatResult } from "./expect"
import { discoverScenarios, runScenario } from "./runner"
import type { Depth, ScenarioResult } from "./types"

const isDepth = (s: string): s is Depth => s === "single" || s === "medium" || s === "tikitaka"

const parseArgs = (argv: readonly string[]): { depth?: Depth; id?: string } => {
  const out: { depth?: Depth; id?: string } = {}
  for (const arg of argv) {
    if (arg.startsWith("--depth=")) {
      const d = arg.slice("--depth=".length)
      if (!isDepth(d)) {
        process.stderr.write(`smoke: unknown depth "${d}" (single|medium|tikitaka)\n`)
        process.exit(2)
      }
      out.depth = d
    } else if (!arg.startsWith("--")) {
      out.id = arg
    }
  }
  return out
}

const main = async (): Promise<void> => {
  const filter = parseArgs(process.argv.slice(2))
  const scenarios = discoverScenarios(filter)
  if (scenarios.length === 0) {
    process.stderr.write("smoke: no scenarios matched the filter\n")
    process.exit(2)
  }

  const results: ScenarioResult[] = []
  for (const meta of scenarios) {
    const r = await runScenario(meta)
    results.push(r)
    process.stdout.write(`${formatResult(r)}\n`)
  }

  const passed = results.filter((r) => r.status === "passed").length
  const failed = results.filter((r) => r.status === "failed").length
  const skipped = results.filter((r) => r.status === "skipped").length
  process.stdout.write(
    `\nsmoke: ${passed} passed · ${failed} failed · ${skipped} skipped (${results.length} total)\n`,
  )
  process.exit(failed > 0 ? 1 : 0)
}

void main()
