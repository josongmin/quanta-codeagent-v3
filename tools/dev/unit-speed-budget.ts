/**
 * Unit-suite speed budget — PER-TEST, one-directional.
 *
 * WHY THIS REPLACED THE OLD GATE. `ci.yml` used to wrap `bun test tests/unit`
 * in a wall-clock assert: "fail if the whole suite takes > 8000ms (RFC §10.1
 * says <5s)". That number was written when the suite was small. The suite is
 * now ~36k tests across ~2.8k files and takes MINUTES, so the assert could not
 * pass on any machine — it was a gate that only ever said "no". A gate nobody
 * can satisfy is a gate everybody learns to ignore.
 *
 * The invariant the old assert was reaching for is in its own error message:
 * "Move slow cases to integration" — i.e. an individual unit test must stay
 * hermetic and fast. TOTAL time is dominated by test COUNT (which growing
 * coverage is supposed to increase); PER-TEST time is the thing that actually
 * signals "this one talks to the disk/network/clock and belongs in
 * tests/integration". So the budget moved to the slowest single test, pinned
 * one-directionally like the other house ratchets:
 *
 *   slowest > ceiling  → REGRESSION, exit 1 (move it to tests/integration, or
 *                        fake the slow dependency — never raise the ceiling)
 *   slowest <= ceiling → PASS, with a "you can tighten to N" advisory on a drop.
 *
 * Total wall time is REPORTED, never asserted: it is runner-hardware dependent
 * and a growing suite legitimately takes longer.
 *
 * Usage:
 *   bun test tests/unit --reporter=junit --reporter-outfile=<xml>
 *   bun run tools/dev/unit-speed-budget.ts <xml>            # check (CI)
 *   bun run tools/dev/unit-speed-budget.ts <xml> --tighten  # lock in a win
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const budgetPath = join(repoRoot, "tools/dev/unit-speed-budget.json")

/** A junit run this small means the reporter/glob broke — never pass over it. */
const MIN_TESTCASES = 1000

type Budget = { readonly slowestMs: number; readonly note?: string }
type Case = { readonly name: string; readonly ms: number }

const xmlPath = process.argv[2]
if (!xmlPath || xmlPath.startsWith("--")) {
  console.error("usage: unit-speed-budget.ts <junit.xml> [--tighten]")
  process.exit(1)
}

const xml = readFileSync(xmlPath, "utf8")

// Bun's junit writer emits one self-describing `<testcase …>` per test with
// `time` in SECONDS. Attribute order is not guaranteed, so match the tag and
// pull each attribute out of it rather than assuming a fixed layout.
const cases: Case[] = []
for (const tag of xml.match(/<testcase\b[^>]*>/g) ?? []) {
  const time = /\btime="([^"]*)"/.exec(tag)?.[1]
  if (time === undefined) continue
  const seconds = Number(time)
  if (!Number.isFinite(seconds)) continue
  const name = /\bname="([^"]*)"/.exec(tag)?.[1] ?? "<unnamed>"
  const file = /\b(?:file|classname)="([^"]*)"/.exec(tag)?.[1]
  cases.push({ name: file ? `${file} › ${name}` : name, ms: seconds * 1000 })
}

if (cases.length < MIN_TESTCASES) {
  console.error(
    `unit-speed-budget: only ${cases.length} testcases parsed from ${xmlPath} (floor ${MIN_TESTCASES}). ` +
      "The reporter output or the junit shape drifted — refusing to pass over a near-empty set.",
  )
  process.exit(1)
}

const sorted = [...cases].sort((a, b) => b.ms - a.ms)
const slowest = sorted[0] as Case
const totalMs = cases.reduce((acc, c) => acc + c.ms, 0)
const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as Budget

const topList = (): string =>
  sorted
    .slice(0, 10)
    .map((c) => `  ${Math.round(c.ms)}ms  ${c.name}`)
    .join("\n")

if (process.argv.includes("--tighten")) {
  if (slowest.ms > budget.slowestMs) {
    console.error("unit-speed-budget: refusing to --tighten a REGRESSION (the budget only goes down)")
    process.exit(1)
  }
  writeFileSync(
    budgetPath,
    `${JSON.stringify({ ...budget, slowestMs: Math.ceil(slowest.ms) }, null, 2)}\n`,
  )
  console.log(`unit-speed-budget: tightened ${budget.slowestMs} → ${Math.ceil(slowest.ms)}ms`)
  process.exit(0)
}

console.log(
  `unit-speed-budget: ${cases.length} tests, summed ${Math.round(totalMs)}ms, ` +
    `slowest ${Math.round(slowest.ms)}ms/${budget.slowestMs}ms`,
)
console.log(`slowest 10:\n${topList()}`)

if (slowest.ms > budget.slowestMs) {
  console.error(
    `REGRESSION: slowest unit test rose to ${Math.round(slowest.ms)}ms (budget ${budget.slowestMs}ms) — ` +
      `"${slowest.name}". Move it to tests/integration or fake the slow dependency; do NOT raise the budget.`,
  )
  process.exit(1)
}
if (slowest.ms < budget.slowestMs) {
  console.log(
    `[advisory] below budget — run \`bun run tools/dev/unit-speed-budget.ts ${xmlPath} --tighten\` to lock in ${Math.ceil(slowest.ms)}ms`,
  )
}
