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

import { type Gate, type GateStage, gatesForStage } from "./gate-manifest"

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

/** Floor per stage: below this the manifest did not load, or every gate landed
 *  in the other stage. Deliberately a real number, never `> 0`. */
const MIN_GATES: Record<GateStage, number> = { precommit: 8, prepush: 16 }

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
if (planned.length < MIN_GATES[stage]) {
  console.error(
    `gate.ts: ${stage} resolved to ${planned.length} gate(s), below the floor of ` +
      `${MIN_GATES[stage]}. The manifest is empty, mis-staged, or failed to load — ` +
      "refusing to report a verdict over it.",
  )
  process.exit(1)
}

const results: { gate: Gate; ok: boolean; ms: number; out: string; err: string }[] = []
const failedIds = new Set<string>()
const skipped: Gate[] = []
for (const gate of planned) {
  // A gate whose INPUT a failed gate produces cannot be judged: the input is
  // either missing or, worse, left over from a previous run. Report it as
  // SKIPPED, never as PASS.
  if (gate.consumes !== undefined && failedIds.has(gate.consumes)) {
    skipped.push(gate)
    continue
  }
  if (!quiet) console.log(`\n──── ${stage}: ${gate.id} — ${gate.run}`)
  const { ok, ms, out, err } = runGate(gate)
  results.push({ gate, ok, ms, out, err })
  if (!ok) failedIds.add(gate.id)
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
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.gate.id.padEnd(22)} ${Math.round(r.ms)}ms`)
}
for (const g of skipped) {
  console.log(`  SKIP  ${g.id.padEnd(22)} its input gate \`${g.consumes}\` failed`)
}
for (const g of notRun) console.log(`  ----  ${g.id.padEnd(22)} not run (--bail)`)
if (failed.length === 0 && skipped.length === 0 && notRun.length === 0) {
  console.log(`${stage}: ok — ${results.length} of ${planned.length} gate(s) passed`)
  process.exit(0)
}
if (failed.length === 0) {
  // Nothing FAILED, but the stage was not fully judged. Never "ok".
  console.error(
    `\n${stage}: INCOMPLETE — ${results.length} of ${planned.length} gate(s) ran ` +
      `(${skipped.length} skipped, ${notRun.length} not run). No verdict.`,
  )
  process.exit(1)
}
console.error(`\n${stage}: ${failed.length} of ${results.length} gate(s) FAILED:`)
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
    const tail = text.trimEnd().split("\n").slice(-REPLAY_TAIL_LINES)
    if (tail.every((l) => l.trim() === "")) continue
    console.error(`\n──── ${r.gate.id} ${label} (last ${tail.length} line(s))`)
    for (const line of tail) console.error(`  ${line}`)
  }
}
process.exit(1)
