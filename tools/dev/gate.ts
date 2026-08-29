/**
 * The runner for `bun run precommit` / `bun run prepush`.
 *
 * Runs every gate in `gate-manifest.ts` for the stage, IN ORDER, and prints one
 * summary line per gate plus a final verdict. Exits 1 if any gate failed.
 *
 * RUNS EVERY GATE, does not stop at the first failure. A developer who has
 * broken two things wants both names in one pass; stopping early turns a
 * two-minute fix into two two-minute rounds. `--bail` opts into the other
 * behaviour for the slow prepush suites.
 *
 * OUTPUT IS THE CHILD'S. Each gate inherits stdio unless `--quiet` is passed,
 * because the gate scripts already print the diagnosis the fixer needs (the
 * lint-debt ceiling names the rule and both numbers; the speed budget names the
 * offending test). Swallowing that and re-printing a summary would be a second
 * authority on what went wrong.
 *
 * `--quiet` therefore CAPTURES rather than discards, and replays the tail of a
 * FAILED gate under the summary. The first version discarded it, and the first
 * real `--quiet` run produced "6 of 18 FAILED" with no way to tell which
 * failures were mine and which belonged to another session editing the same
 * tree — a summary that costs a full re-run to act on is worse than noise.
 *
 * Usage:
 *   bun run precommit
 *   bun run prepush
 *   bun run tools/dev/gate.ts precommit --quiet
 *   bun run tools/dev/gate.ts prepush --bail
 *   bun run tools/dev/gate.ts --list
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { GATES, type Gate, type GateStage, gatesForStage } from "./gate-manifest"

const REPO_ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

const argv = process.argv.slice(2)
const wants = (flag: string): boolean => argv.includes(flag)

if (wants("--list")) {
  for (const g of gatesForStage("prepush")) {
    console.log(`${g.stage.padEnd(9)} ${g.id.padEnd(22)} ${g.run}`)
  }
  process.exit(0)
}

const stageArg = argv.find((a) => !a.startsWith("-"))
if (stageArg !== "precommit" && stageArg !== "prepush") {
  console.error("usage: gate.ts <precommit|prepush> [--bail] [--quiet] | --list")
  process.exit(2)
}
const stage: GateStage = stageArg
const bail = wants("--bail")
const quiet = wants("--quiet")

/** How much of a captured failure to replay. Enough for a stack + the gate
 *  script's own verdict lines, short of pasting a whole suite log back. */
const REPLAY_TAIL_LINES = 40
/** …and the same from the top: a gate that diagnoses first and then floods.
 *  Together with the tail this bounds the replay at ~60 lines per stream. */
const REPLAY_HEAD_LINES = 20

/**
 * Floors on the gates each stage OWNS, not on the superset.
 *
 * The first version floored the resolved list — prepush >= 16 against 21 — and
 * because prepush contains all 10 precommit gates, an audit deleted `unit`,
 * `unit-speed-budget`, `integration`, `e2e-pty` and `contract` (i.e. every actual
 * test execution) and still cleared it. It also only fired one way: moving every
 * prepush gate into precommit left both stages at 21 and said nothing, while the
 * docstring claimed mis-staging was loud.
 *
 * Owned counts, derived from the real manifest: 10 precommit, 11 prepush-only.
 */
const MIN_OWNED: Record<GateStage, number> = { precommit: 9, prepush: 10 }

interface GateRun {
  readonly ok: boolean
  readonly ms: number
  readonly out: string
  readonly err: string
}

const runGate = (gate: Gate): GateRun => {
  const started = Bun.nanoseconds()
  const proc = Bun.spawnSync({
    // Through the shell: several gates carry a `--` pass-through the argv form
    // would have to re-tokenize, and re-tokenizing is how a runner drifts from
    // the command it claims to run.
    cmd: ["sh", "-c", gate.run],
    // The REPO ROOT, never the caller's cwd. `bun run precommit` happens to be
    // safe (bun chdirs to the package.json dir), but the documented direct form
    // `bun run tools/dev/gate.ts precommit` from elsewhere ran every gate in the
    // caller's directory — the exact ambient-cwd class this repo ships
    // `test:cwd-parity:arch` for, and the runner was exempt from it.
    cwd: REPO_ROOT,
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  })
  const decode = (b: Uint8Array | undefined | null): string =>
    b === undefined || b === null ? "" : new TextDecoder().decode(b)
  // stdout and stderr are kept APART. Concatenating them destroyed the
  // interleaving and, worse, spent the replay window on whichever stream was
  // longer: biome writes ~219 WARNINGS to one and its `Found N errors` summary
  // to the other, so a 40-line tail of the concatenation contained not one of
  // the ERROR diagnostics the gate exists to surface.
  return {
    ok: proc.exitCode === 0,
    ms: (Bun.nanoseconds() - started) / 1e6,
    out: quiet ? decode(proc.stdout) : "",
    err: quiet ? decode(proc.stderr) : "",
  }
}

/**
 * ANTI-VACUITY. A runner that reports "ok — 0 gate(s) passed" is the exact shape
 * this repo's ratchets exist to catch, and this one had it: emptying `GATES`
 * printed a green summary and exited 0. The floors are on the STAGE the caller
 * asked for, so a manifest edit that empties it, or mis-stages every gate into
 * the other stage, is loud instead of reassuring.
 */
const planned = gatesForStage(stage)
const ownedPrecommit = GATES.filter((g) => g.stage === "precommit").length
const ownedPrepush = GATES.filter((g) => g.stage === "prepush").length
const owned = { precommit: ownedPrecommit, prepush: ownedPrepush }
for (const st of ["precommit", "prepush"] as const) {
  if (owned[st] < MIN_OWNED[st]) {
    console.error(
      `gate.ts: the manifest owns ${owned[st]} ${st} gate(s), below the floor of ` +
        `${MIN_OWNED[st]}. Gates were deleted or mis-staged — refusing to report a ` +
        `verdict over it. (owned: precommit=${ownedPrecommit}, prepush=${ownedPrepush})`,
    )
    process.exit(1)
  }
}

// D4 — a `consumes` that names nothing real disarms the whole mechanism with no
// output. An audit typo'd `consumes: "Unit"` and the consumer ran over stale
// input and PASSED. Validated here, against the STAGE the caller asked for,
// because a producer in the other stage is just as absent at run time.
const plannedIds = new Set(planned.map((g) => g.id))
const danglingConsumes = planned
  .filter((g) => g.consumes !== undefined && !plannedIds.has(g.consumes))
  .map((g) => `${g.id} consumes "${g.consumes}"`)
if (danglingConsumes.length > 0) {
  console.error(
    `gate.ts: ${danglingConsumes.length} gate(s) name a producer that does not run in ` +
      `this stage — the SKIP-on-failed-input protection would be silently off:\n  ` +
      danglingConsumes.join("\n  "),
  )
  process.exit(1)
}

const results: { gate: Gate; ok: boolean; ms: number; out: string; err: string }[] = []
const failedIds = new Set<string>()
/** Gate ids whose output cannot be trusted: failed, or skipped because their own
 *  input could not be trusted. */
const poisoned = new Set<string>()
const skipped: Gate[] = []
for (const gate of planned) {
  // A gate whose INPUT a failed gate produces cannot be judged: the input is
  // either missing or, worse, left over from a previous run. Report it as
  // SKIPPED, never as PASS.
  // TRANSITIVE. A consumer of a SKIPPED gate is reading the same unproduced
  // input; the first version only checked `failedIds`, so a three-link chain ran
  // its tail over stale data and printed PASS.
  if (gate.consumes !== undefined && poisoned.has(gate.consumes)) {
    skipped.push(gate)
    poisoned.add(gate.id)
    continue
  }
  if (!quiet) console.log(`\n──── ${stage}: ${gate.id} — ${gate.run}`)
  const { ok, ms, out, err } = runGate(gate)
  results.push({ gate, ok, ms, out, err })
  if (!ok) {
    failedIds.add(gate.id)
    poisoned.add(gate.id)
  }
  if (!ok && bail) break
}
/** Gates never reached because `--bail` stopped the run. Reported, not silently
 *  dropped from the denominator. */
const notRun = planned.filter(
  (g) => !results.some((r) => r.gate.id === g.id) && !skipped.includes(g),
)

const failed = results.filter((r) => !r.ok)
console.log(`\n──── ${stage} summary`)
for (const r of results) {
  const hd = r.ok && r.gate.hostDependent !== undefined ? "  [host-dependent]" : ""
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.gate.id.padEnd(22)} ${Math.round(r.ms)}ms${hd}`)
}
for (const g of skipped) {
  console.log(`  SKIP  ${g.id.padEnd(22)} its input gate \`${g.consumes}\` failed`)
}
for (const g of notRun) console.log(`  ----  ${g.id.padEnd(22)} not run (--bail)`)
if (failed.length === 0 && skipped.length === 0 && notRun.length === 0) {
  const marked = results.filter((r) => r.gate.hostDependent !== undefined)
  const note =
    marked.length === 0
      ? ""
      : ` (${marked.length} host-dependent: ${marked.map((r) => r.gate.id).join(", ")} ` +
        "— may have passed by finding nothing to check here)"
  console.log(`${stage}: ok — ${results.length} of ${planned.length} gate(s) passed${note}`)
  process.exit(0)
}
// No INCOMPLETE branch: a skip requires a failed producer and a not-run requires
// `--bail` to have fired, so `failed.length === 0` alongside either is
// unsatisfiable. An audit instrumented the old branch across 14 scenarios and it
// fired 0 times — dead code that claimed to handle a case.
//
// The denominator is what the STAGE asked for, not what happened to run. The
// first fix changed only the "ok" line, so `--bail` still reported
// "1 of 1 gate(s) FAILED" while seven never ran.
console.error(`\n${stage}: ${failed.length} FAILED of ${planned.length} gate(s) in this stage:`)
for (const r of failed) console.error(`  ${r.gate.id} — ${r.gate.why}`)
for (const r of failed) {
  // Both streams, each with its own window. The first version tested only
  // `tail[0] === ""` and dropped the WHOLE replay when a blank line happened to
  // land at the top of the window — a failing gate that printed 100 lines could
  // have every one of them discarded.
  for (const [label, text] of [
    ["stdout", r.out],
    ["stderr", r.err],
  ] as const) {
    const all = text.trimEnd().split("\n")
    if (all.every((l) => l.trim() === "")) continue
    // HEAD as well as tail. A gate that prints its diagnosis first and then
    // 10,000 lines of progress had the diagnosis fall out of a tail-only window
    // — no false green, but a full re-run to recover what the runner already had.
    const head = all.slice(0, REPLAY_HEAD_LINES)
    const tail = all.slice(-REPLAY_TAIL_LINES)
    const elided = all.length - head.length - tail.length
    console.error(`\n──── ${r.gate.id} ${label} (${all.length} line(s))`)
    if (elided <= 0) {
      for (const line of all) console.error(`  ${line}`)
      continue
    }
    for (const line of head) console.error(`  ${line}`)
    console.error(`  … ${elided} line(s) elided …`)
    for (const line of tail) console.error(`  ${line}`)
  }
}
process.exit(1)
