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

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const budgetPath = join(repoRoot, "tools/dev/unit-speed-budget.json")

/** A junit run this small means the reporter/glob broke — never pass over it. */
const MIN_TESTCASES = 1000

type Budget = { readonly slowestMs: number; readonly note?: string }
type Case = { readonly name: string; readonly ms: number; readonly file: string | undefined }

const xmlPath = process.argv[2]
if (!xmlPath || xmlPath.startsWith("--")) {
  console.error("usage: unit-speed-budget.ts <junit.xml> [--scope=<path-prefix>] [--tighten]")
  process.exit(1)
}

// `--scope=tests/unit/` lets this budget consume the FULL-suite junit receipt
// (one execution for every gate) while still judging only the unit tier —
// integration files are legitimately slow and live outside this ceiling.
const scope = process.argv
  .find((argument) => argument.startsWith("--scope="))
  ?.slice("--scope=".length)

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
  // TWO different things, deliberately not one regex. `label` is for humans and
  // may fall back to the classname; `file` is a PATH the confirm step will hand
  // to `bun test`, so it comes ONLY from `file=` and only when it names a file
  // that exists. The first version matched `(?:file|classname)` and bun writes
  // `classname` FIRST, so every re-run was launched against a describe title:
  // `bun test "arch: capability-manifest literals…"` exited 1 with no junit, and
  // a synthetic case whose classname was "s" "re-measured alone in s" at 59,880ms.
  // Both directions of the confirm step were wrong, and only the fail-closed
  // branch hid it.
  const label = /\b(?:file|classname)="([^"]*)"/.exec(tag)?.[1]
  const rawFile = /\bfile="([^"]*)"/.exec(tag)?.[1]
  // Scoped consumption: a case outside the scope prefix (or one the reporter
  // could not attribute to a file) is another tier's business, not this budget's.
  if (scope !== undefined && !(rawFile ?? "").startsWith(scope)) continue
  const file =
    rawFile !== undefined && rawFile.endsWith(".ts") && existsSync(join(repoRoot, rawFile))
      ? rawFile
      : undefined
  cases.push({ name: label ? `${label} › ${name}` : name, ms: seconds * 1000, file })
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

/**
 * CONFIRM A VIOLATION STANDALONE BEFORE CALLING IT ONE.
 *
 * The junit number is wall-clock measured while ~39,000 other cases were running
 * in the same process pool, so it answers "how contended was the box", not "is
 * this test slow". Measured on this repo, same test, same day:
 *
 *   capability-literal-ratchet     1,001ms alone   →  9,420ms in-suite   (9.4x)
 *   campaign-root                    341ms alone   → 14,128ms in-suite  (41.4x)
 *   runtime-cpp-real-e2e           3,455ms alone   →  9,387ms in-suite   (2.7x)
 *
 * Over one session this gate fired seven times and SIX were pure contention —
 * each cost a manual standalone re-run to disprove, and the seventh (a live LLM
 * call) was real. A gate whose verdict has to be checked by hand every time is a
 * gate that gets ignored, which is the exact fate its own docstring describes
 * for the whole-suite assert it replaced.
 *
 * So the in-suite number stays as the cheap SCREEN — it costs nothing and it is
 * how the offender is found — and a screen hit is then re-measured with that one
 * file to itself. The standalone number is the verdict. This mirrors what the
 * repo already does elsewhere: `cwd-parity-check.ts` re-runs a differing file
 * before reporting it, and `anti-vacuity-census.ts` calls itself "a candidate
 * detector, not a verdict".
 *
 * Fail-closed: if the re-run cannot be performed or its output cannot be parsed,
 * the screen's number stands and the gate fails. An unmeasurable test is not a
 * passing one.
 */
const confirmStandalone = (c: Case): { readonly ms: number; readonly how: string } => {
  if (c.file === undefined) return { ms: c.ms, how: "no file in junit — screen number stands" }
  const out = join(repoRoot, ".cache", "unit-speed-confirm.xml")
  // DELETE FIRST, and require the re-run to have written it. Without this the
  // re-run's junit is read whether or not this run produced it: an audit planted
  // a file dated 2020 and the gate reported "3ms re-measured alone" over a
  // 99,000ms case and exited 0 — the exact stale-input false green this whole
  // change exists to remove, reintroduced in its newest code.
  rmSync(out, { force: true })
  const startedNs = Bun.nanoseconds()
  const run = Bun.spawnSync({
    cmd: ["bun", "test", c.file, "--reporter=junit", `--reporter-outfile=${out}`],
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  })
  const wallMs = (Bun.nanoseconds() - startedNs) / 1e6
  let xmlText: string
  try {
    xmlText = readFileSync(out, "utf8")
  } catch {
    return { ms: c.ms, how: `re-run wrote no junit (exit ${run.exitCode}) — screen number stands` }
  }
  rmSync(out, { force: true })
  let worst = -1
  for (const tag of xmlText.match(/<testcase\b[^>]*>/g) ?? []) {
    const t = Number(/\btime="([^"]*)"/.exec(tag)?.[1])
    if (Number.isFinite(t)) worst = Math.max(worst, t * 1000)
  }
  if (worst < 0) return { ms: c.ms, how: "re-run parsed no cases — screen number stands" }
  // The FILE's wall time counts too. junit `time` is per-test and excludes module
  // load, so a file whose cost is at module scope confirms at ~1ms: a probe with
  // `Bun.spawnSync(["sleep","4"])` at module scope took 4.06s wall and reported
  // `time="0.001336"`. Taking the max means a downgrade can only happen when the
  // file is genuinely cheap to run, not merely cheap to attribute.
  return worst >= wallMs
    ? { ms: worst, how: `re-measured alone in ${c.file}` }
    : {
        ms: wallMs,
        how: `re-measured alone in ${c.file} (wall time — its cost is at module scope)`,
      }
}

const topList = (): string =>
  sorted
    .slice(0, 10)
    .map((c) => `  ${Math.round(c.ms)}ms  ${c.name}`)
    .join("\n")

if (process.argv.includes("--tighten")) {
  if (slowest.ms > budget.slowestMs) {
    console.error(
      "unit-speed-budget: refusing to --tighten a REGRESSION (the budget only goes down)",
    )
    process.exit(1)
  }
  // Tighten to the CONFIRMED number, never the in-suite one. The comment here
  // used to say "deliberately NOT tightening to the in-suite number" while the
  // line below did exactly that — a ceiling pinned from whatever load the box
  // happened to be under.
  const confirmedSlowest = confirmStandalone(slowest)
  const next = Math.ceil(Math.max(confirmedSlowest.ms, slowest.ms > 0 ? 0 : 0))
  writeFileSync(budgetPath, `${JSON.stringify({ ...budget, slowestMs: next }, null, 2)}\n`)
  console.log(
    `unit-speed-budget: tightened ${budget.slowestMs} → ${next}ms (${confirmedSlowest.how})`,
  )
  process.exit(0)
}

console.log(
  `unit-speed-budget: ${cases.length} tests, summed ${Math.round(totalMs)}ms, ` +
    `slowest ${Math.round(slowest.ms)}ms/${budget.slowestMs}ms`,
)
console.log(`slowest 10:\n${topList()}`)

if (slowest.ms > budget.slowestMs) {
  const confirmed = confirmStandalone(slowest)
  if (confirmed.ms <= budget.slowestMs) {
    console.log(
      `[screen only] "${slowest.name}" measured ${Math.round(slowest.ms)}ms IN-SUITE but ` +
        `${Math.round(confirmed.ms)}ms ${confirmed.how} — under the ${budget.slowestMs}ms budget. ` +
        "Contention, not a slow test; no regression.",
    )
  } else {
    console.error(
      `REGRESSION: slowest unit test is ${Math.round(confirmed.ms)}ms (budget ${budget.slowestMs}ms), ` +
        `${confirmed.how} — "${slowest.name}". In-suite it measured ${Math.round(slowest.ms)}ms, so this is ` +
        "the test's own cost, not contention. Move it to tests/integration or fake the slow dependency; " +
        "do NOT raise the budget.",
    )
    process.exit(1)
  }
}
if (slowest.ms < budget.slowestMs) {
  console.log(
    `[advisory] below budget — run \`bun run tools/dev/unit-speed-budget.ts ${xmlPath} --tighten\` to lock in ${Math.ceil(slowest.ms)}ms`,
  )
}
