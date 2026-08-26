#!/usr/bin/env bun

// biome-ignore-all lint/suspicious/noConsole: CLI tool — plain console.log/console.error is the intended IO surface.
/**
 * tools/pm/check.ts — enforce the Definition of Done (see ./README.md).
 *
 * Usage:
 *   bun tools/pm/check.ts <feature-id> [<feature-id> ...]   check named features
 *   bun tools/pm/check.ts --all                             check every feature
 *   bun tools/pm/check.ts --all --strict                    hold L1/L2 seams too
 *
 * Exit code is non-zero when ANY checked feature FAILS its applicable bar, so
 * this drops straight into CI / a pre-push hook.
 */

import { FEATURES_DIR } from "../feature-catalog/paths"
import { loadFeaturesStrict } from "../feature-catalog/schema"
import { checkFeatureDoD, type DoDCheck, type DoDResult } from "./definition-of-done"

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

const mark = (c: DoDCheck): string => (c.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`)

const renderOne = (r: DoDResult): string => {
  const head =
    r.verdict === "pass"
      ? `${GREEN}PASS${RESET} ${BOLD}${r.id}${RESET} ${DIM}(${r.maturity})${RESET}`
      : `${RED}FAIL${RESET} ${BOLD}${r.id}${RESET} ${DIM}(${r.maturity})${RESET}`
  const seam = r.fullBar ? "" : ` ${DIM}[seam — catalog-only bar]${RESET}`
  const lines = [
    `${head}${seam}`,
    `  ${mark(r.catalog)} catalog     ${DIM}${r.catalog.detail}${RESET}`,
  ]
  if (r.fullBar) {
    lines.push(`  ${mark(r.tdd)} tdd         ${DIM}${r.tdd.detail}${RESET}`)
    lines.push(`  ${mark(r.e2eHellgate)} e2e-hellgate ${DIM}${r.e2eHellgate.detail}${RESET}`)
  }
  return lines.join("\n")
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const strict = argv.includes("--strict")
  const all = argv.includes("--all")
  const ids = argv.filter((a) => !a.startsWith("--"))

  if (!all && ids.length === 0) {
    console.error(
      "usage: bun tools/pm/check.ts <feature-id> [...]  |  --all [--strict]\n" +
        "see tools/pm/README.md for the Definition of Done.",
    )
    process.exit(2)
  }

  const features = await loadFeaturesStrict(FEATURES_DIR)
  const byId = new Map(features.map((lf) => [lf.feature.id, lf.feature]))

  const targets = all ? [...byId.keys()] : ids
  const results: DoDResult[] = []
  const missing: string[] = []
  for (const id of targets) {
    const feature = byId.get(id)
    if (feature === undefined) {
      missing.push(id)
      continue
    }
    results.push(checkFeatureDoD(feature, strict))
  }

  // In --all mode, only print the failures (a clean sweep prints a summary);
  // for explicit ids, print every result so the author sees the full checklist.
  const toPrint = all ? results.filter((r) => r.verdict === "fail") : results
  for (const r of toPrint) console.log(renderOne(r), "\n")

  for (const id of missing) {
    console.error(
      `${RED}MISSING${RESET} ${BOLD}${id}${RESET} — not in the feature catalog. Register it first (see tools/pm/README.md §1).`,
    )
  }

  const failed = results.filter((r) => r.verdict === "fail").length
  const passed = results.length - failed
  console.log(
    `${BOLD}Definition of Done:${RESET} ${GREEN}${passed} pass${RESET}, ` +
      `${failed > 0 ? RED : DIM}${failed} fail${RESET}` +
      (missing.length > 0 ? `, ${RED}${missing.length} missing${RESET}` : "") +
      ` ${DIM}(of ${targets.length} checked${strict ? ", strict" : ""})${RESET}`,
  )

  process.exit(failed > 0 || missing.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
