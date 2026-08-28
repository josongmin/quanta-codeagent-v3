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

import { type Gate, type GateStage, gatesForStage } from "./gate-manifest"

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

const runGate = (
  gate: Gate,
): { readonly ok: boolean; readonly ms: number; readonly output: string } => {
  const started = Bun.nanoseconds()
  const proc = Bun.spawnSync({
    // Through the shell: several gates carry a `--` pass-through the argv form
    // would have to re-tokenize, and re-tokenizing is how a runner drifts from
    // the command it claims to run.
    cmd: ["sh", "-c", gate.run],
    cwd: process.cwd(),
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  })
  const decode = (b: Uint8Array | undefined | null): string =>
    b === undefined || b === null ? "" : new TextDecoder().decode(b)
  return {
    ok: proc.exitCode === 0,
    ms: (Bun.nanoseconds() - started) / 1e6,
    output: quiet ? `${decode(proc.stdout)}${decode(proc.stderr)}` : "",
  }
}

const results: { gate: Gate; ok: boolean; ms: number; output: string }[] = []
for (const gate of gatesForStage(stage)) {
  if (!quiet) console.log(`\n──── ${stage}: ${gate.id} — ${gate.run}`)
  const { ok, ms, output } = runGate(gate)
  results.push({ gate, ok, ms, output })
  if (!ok && bail) break
}

const failed = results.filter((r) => !r.ok)
console.log(`\n──── ${stage} summary`)
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.gate.id.padEnd(22)} ${Math.round(r.ms)}ms`)
}
if (failed.length === 0) {
  console.log(`${stage}: ok — ${results.length} gate(s) passed`)
  process.exit(0)
}
console.error(`\n${stage}: ${failed.length} of ${results.length} gate(s) FAILED:`)
for (const r of failed) console.error(`  ${r.gate.id} — ${r.gate.why}`)
for (const r of failed) {
  const tail = r.output.trimEnd().split("\n").slice(-REPLAY_TAIL_LINES)
  if (tail.length === 0 || tail[0] === "") continue
  console.error(`\n──── ${r.gate.id} (last ${tail.length} line(s) of its own output)`)
  for (const line of tail) console.error(`  ${line}`)
}
process.exit(1)
