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

import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describeQuietBoxWait, loadPerCore, quietBoxBudgetMs, waitForQuietBox } from "./box-load"
import { missingExternalTools } from "./external-toolchain"
import { GATES, type Gate, type GateStage, gatesForStage } from "./gate-manifest"
import {
  cleanStatusSha256,
  mintExactVerificationReceipt,
  readExactVerificationReceipt,
  validateExactVerificationReceipt,
  verificationReceiptPath,
  writeExactVerificationReceipt,
} from "./verification-receipt"
import {
  verificationContextForSnapshot,
  verificationManifestSha256,
} from "./verification-receipt-probe"

const REPO_ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

const argv = process.argv.slice(2)
const wants = (flag: string): boolean => argv.includes(flag)
const printOut = (line: string): void => {
  process.stdout.write(`${line}\n`)
}
const printErr = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

if (wants("--list")) {
  for (const g of gatesForStage("prepush")) {
    printOut(`${g.stage.padEnd(9)} ${g.id.padEnd(22)} ${g.run}`)
  }
  process.exit(0)
}

const stageArg = argv.find((a) => !a.startsWith("-"))
if (stageArg !== "precommit" && stageArg !== "prepush") {
  printErr("usage: gate.ts <precommit|prepush> [--bail] [--quiet] | --list")
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
 * The floors sit AT the real counts — deleting any gate trips them, and adding
 * one is expected to raise them in the same diff.
 */
const MIN_OWNED: Record<GateStage, number> = { precommit: 10, prepush: 11 }

interface GateRun {
  readonly ok: boolean
  readonly ms: number
  readonly out: string
  readonly err: string
  /** Per-core run-queue while this gate ran. The one fact that decides whether
   *  a red is about the code at all. */
  readonly peakLoadPerCore: number
}

interface GitSnapshot {
  readonly head: string
  readonly status: string
}

type ReceiptGateStatus = "passed" | "failed" | "skipped" | "not_run"
type ReceiptStatus = "passed" | "failed" | "invalid"

interface GateReceipt {
  readonly schema: "quanta.gate-receipt.v1"
  readonly stage: "prepush"
  readonly head: string | null
  readonly endHead: string | null
  readonly manifestSha256: string
  readonly snapshotStable: boolean
  readonly startClean: boolean
  readonly endClean: boolean | null
  readonly gates: readonly {
    readonly id: string
    readonly run: string
    readonly status: ReceiptGateStatus
    readonly elapsedMs: number
  }[]
  readonly elapsedMs: number
  readonly status: ReceiptStatus
  /** External tools this box does not have. A gate that skipped a whole lane
   *  for want of one prints the same PASS as a gate that ran it, so the
   *  strength of this green is not readable without them. */
  readonly missingCapabilities: readonly string[]
  readonly error?: string
}

const gitOutput = (args: readonly string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    )
  }
  return proc.stdout.toString()
}

const gitSnapshot = (): GitSnapshot => ({
  head: gitOutput(["rev-parse", "HEAD"]).trim(),
  status: gitOutput(["status", "--porcelain=v1", "-uall", "-z"]),
})

const statusPreview = (status: string): string =>
  status
    .split("\0")
    .filter((entry) => entry !== "")
    .slice(0, 20)
    .join("\n  ")

const emitReceipt = (receipt: GateReceipt): void => {
  // One compact JSON object on one line. Consumers select by `schema`; no cache
  // file is read or written, so a previous green can never skip current gates.
  printOut(JSON.stringify(receipt))
}

const receiptGates = (
  planned: readonly Gate[],
  results: readonly { gate: Gate; ok: boolean; ms: number }[],
  skipped: readonly Gate[],
): GateReceipt["gates"] => {
  const byId = new Map(results.map((result) => [result.gate.id, result]))
  const skippedIds = new Set(skipped.map((gate) => gate.id))
  return planned.map((gate) => {
    const result = byId.get(gate.id)
    if (result !== undefined) {
      return {
        id: gate.id,
        run: gate.run,
        status: result.ok ? "passed" : "failed",
        elapsedMs: Math.round(result.ms),
      }
    }
    return {
      id: gate.id,
      run: gate.run,
      status: skippedIds.has(gate.id) ? "skipped" : "not_run",
      elapsedMs: 0,
    }
  })
}

interface ReceiptArgs {
  readonly planned: readonly Gate[]
  readonly results?: readonly { gate: Gate; ok: boolean; ms: number }[]
  readonly skipped?: readonly Gate[]
  readonly frozen?: GitSnapshot | undefined
  readonly ending?: GitSnapshot | undefined
  readonly manifestSha256: string
  readonly overallStarted: number
  readonly snapshotStable: boolean
  readonly status: ReceiptStatus
  readonly error?: string
}

const makeReceipt = (args: ReceiptArgs): GateReceipt => ({
  schema: "quanta.gate-receipt.v1",
  stage: "prepush",
  head: args.frozen?.head ?? null,
  endHead: args.ending?.head ?? null,
  manifestSha256: args.manifestSha256,
  snapshotStable: args.snapshotStable,
  startClean: args.frozen?.status === "",
  endClean: args.ending === undefined ? null : args.ending.status === "",
  gates: receiptGates(args.planned, args.results ?? [], args.skipped ?? []),
  elapsedMs: Math.round((Bun.nanoseconds() - args.overallStarted) / 1e6),
  status: args.status,
  missingCapabilities: missingExternalTools(),
  ...(args.error === undefined ? {} : { error: args.error }),
})

const snapshotInvalidMessage = (
  frozen: GitSnapshot | undefined,
  ending: GitSnapshot | undefined,
  snapshotError: string | undefined,
): string =>
  snapshotError ??
  `checkout changed during prepush (start=${frozen?.head ?? "unknown"}, ` +
    `end=${ending?.head ?? "unknown"}, endDirty=${ending?.status !== ""})`

const runGate = (gate: Gate): GateRun => {
  const started = Bun.nanoseconds()
  const loadAtStart = loadPerCore()
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
    // The 1-minute average is a trailing window, so the higher of the two ends
    // is the honest summary of what this gate competed with.
    peakLoadPerCore: Math.max(loadAtStart, loadPerCore()),
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
const overallStarted = Bun.nanoseconds()
const plannedManifestSha256 = verificationManifestSha256(planned)
const ownedPrecommit = GATES.filter((g) => g.stage === "precommit").length
const ownedPrepush = GATES.filter((g) => g.stage === "prepush").length
const owned = { precommit: ownedPrecommit, prepush: ownedPrepush }
for (const st of ["precommit", "prepush"] as const) {
  if (owned[st] < MIN_OWNED[st]) {
    printErr(
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
// ORDER, not just membership. `consumes` reports SKIP when the producer
// FAILED — but a consumer placed BEFORE its producer never sees a failure to
// react to: it runs first and reads whatever the previous campaign left in
// `.cache/`, which is exactly the stale-input false green this mechanism was
// built to stop (the manifest's own scar: a junit file dated 2020 accepted
// without comment). Membership was checked; sequence never was.
const plannedIndex = new Map(planned.map((g, index) => [g.id, index]))
const misorderedConsumes = planned
  .filter((g) => {
    if (g.consumes === undefined) return false
    const producer = plannedIndex.get(g.consumes)
    const consumer = plannedIndex.get(g.id)
    return producer !== undefined && consumer !== undefined && producer > consumer
  })
  .map((g) => `${g.id} runs BEFORE the "${g.consumes}" it consumes`)
if (misorderedConsumes.length > 0) {
  printErr(
    `gate.ts: ${misorderedConsumes.length} gate(s) consume a producer that has not run yet, ` +
      `so they would read the PREVIOUS campaign's artifact and report a verdict over it:\n  ` +
      misorderedConsumes.join("\n  "),
  )
  process.exit(1)
}

const danglingConsumes = planned
  .filter((g) => g.consumes !== undefined && !plannedIds.has(g.consumes))
  .map((g) => `${g.id} consumes "${g.consumes}"`)
if (danglingConsumes.length > 0) {
  printErr(
    `gate.ts: ${danglingConsumes.length} gate(s) name a producer that does not run in ` +
      `this stage — the SKIP-on-failed-input protection would be silently off:\n  ` +
      danglingConsumes.join("\n  "),
  )
  process.exit(1)
}

// Exact-receipt reuse (opt-in): a durable, content-bound record of a green
// same-state prepush. Probed HERE — i.e. under the campaign lease when the
// wrapper launched this runner — so a contender that waited behind a green
// same-HEAD campaign exits without executing a single gate.
const exactReceiptPath = verificationReceiptPath(REPO_ROOT)
if (stage === "prepush" && wants("--reuse-receipt")) {
  try {
    const current = gitSnapshot()
    const validation = validateExactVerificationReceipt(
      readExactVerificationReceipt(exactReceiptPath),
      verificationContextForSnapshot(REPO_ROOT, current, plannedManifestSha256),
    )
    if (validation.ok) {
      printOut(`prepush: REUSED exact receipt head=${current.head} path=${exactReceiptPath}`)
      process.exit(0)
    }
    printOut(`prepush: receipt not reusable (${validation.reason}); running gates`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    printOut(`prepush: receipt check failed closed (${message}); running gates`)
  }
}
/**
 * A red or interrupted run must never leave a previous green receipt current —
 * but ONLY the receipt this run is about to supersede.
 *
 * The delete used to be unconditional, and the cache is shared across every
 * worktree of the repository (one git common-dir, by design). So a prepush from
 * a checkout with any uncommitted file destroyed a green another checkout had
 * just earned at the same HEAD — while being unable to mint a replacement,
 * because minting requires a clean status. MEASURED: `git push` from this
 * working copy, dirty with one unrelated file from another session, threw away
 * a 21-of-21 receipt earned minutes earlier in a pristine worktree and started
 * the 45 minutes again.
 *
 * A receipt that does not validate against this run's context describes a
 * different state. It is not about to be mistaken for this run's result — the
 * validation above already rejects it — so it is not ours to delete.
 */
if (stage === "prepush") {
  const supersedes = (): boolean => {
    try {
      return validateExactVerificationReceipt(
        readExactVerificationReceipt(exactReceiptPath),
        verificationContextForSnapshot(REPO_ROOT, gitSnapshot(), plannedManifestSha256),
      ).ok
    } catch {
      // Cannot tell whose it is — leave it. A stale receipt is rejected by
      // validation; a deleted one costs someone a full campaign.
      return false
    }
  }
  if (supersedes()) rmSync(exactReceiptPath, { force: true })
}

let frozenSnapshot: GitSnapshot | undefined
if (stage === "prepush") {
  try {
    frozenSnapshot = gitSnapshot()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    printErr(`gate.ts: prepush snapshot failed before gate 1 — ${message}`)
    emitReceipt(
      makeReceipt({
        planned,
        manifestSha256: plannedManifestSha256,
        overallStarted,
        snapshotStable: false,
        status: "invalid",
        error: message,
      }),
    )
    process.exit(1)
  }
  if (frozenSnapshot.status !== "") {
    const preview = statusPreview(frozenSnapshot.status)
    const message =
      "authoritative prepush receipts require a clean checkout; refusing before gate 1" +
      (preview === "" ? "" : `:\n  ${preview}`)
    printErr(`gate.ts: ${message}`)
    emitReceipt(
      makeReceipt({
        planned,
        frozen: frozenSnapshot,
        ending: frozenSnapshot,
        manifestSha256: plannedManifestSha256,
        overallStarted,
        snapshotStable: true,
        status: "invalid",
        error: message,
      }),
    )
    process.exit(1)
  }
  printOut(`prepush: frozen head=${frozenSnapshot.head} dirty=no`)
}

/**
 * How long a load-sensitive gate may wait for the box to stop being
 * oversubscribed. Sized against what it is actually waiting for: the 1-minute
 * load average this reads decays over minutes, and the campaign's OWN 30-chunk
 * full suite is usually what it is decaying from. Past this, the load is
 * foreign and waiting longer buys nothing but a later start.
 */
const QUIET_BOX_BUDGET_MS = 180_000

const results: {
  gate: Gate
  ok: boolean
  ms: number
  out: string
  err: string
  peakLoadPerCore: number
}[] = []
/** Gates that gave up waiting and ran on a saturated box. */
const hotGates = new Map<string, number>()
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
  if (!quiet) printOut(`\n──── ${stage}: ${gate.id} — ${gate.run}`)
  if (gate.needsQuietBox !== undefined) {
    // Bounded, and it never refuses to run: a rail that unrelated load on the
    // host can stop is a rail that cannot be used on a working machine.
    const wait = await waitForQuietBox({
      budgetMs: quietBoxBudgetMs(process.env, QUIET_BOX_BUDGET_MS),
    })
    printOut(`  [${gate.id}] ${describeQuietBoxWait(wait)}`)
    if (!wait.settled) hotGates.set(gate.id, wait.endPerCore)
  }
  const { ok, ms, out, err, peakLoadPerCore } = runGate(gate)
  results.push({ gate, ok, ms, out, err, peakLoadPerCore })
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

let endingSnapshot: GitSnapshot | undefined
let snapshotError: string | undefined
if (stage === "prepush") {
  try {
    endingSnapshot = gitSnapshot()
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error)
  }
}
const snapshotStable =
  frozenSnapshot !== undefined &&
  endingSnapshot !== undefined &&
  frozenSnapshot.head === endingSnapshot.head &&
  frozenSnapshot.status === endingSnapshot.status

const failed = results.filter((r) => !r.ok)
printOut(`\n──── ${stage} summary`)
for (const r of results) {
  const hd = r.ok && r.gate.hostDependent !== undefined ? "  [host-dependent]" : ""
  // A red on a saturated box is reported WITH the saturation. The last time it
  // was not, a green 45-minute campaign's two starved rust-analyzer cases were
  // investigated as a code defect; the box was held at load 52 by forty
  // orphaned busy-loops another session had left running for nine hours.
  const load =
    r.ok && r.peakLoadPerCore <= 1
      ? ""
      : `  [load/core ${r.peakLoadPerCore.toFixed(2)}${r.peakLoadPerCore > 1 ? " — OVERSUBSCRIBED" : ""}]`
  printOut(`  ${r.ok ? "PASS" : "FAIL"}  ${r.gate.id.padEnd(22)} ${Math.round(r.ms)}ms${hd}${load}`)
}
for (const g of skipped) {
  printOut(`  SKIP  ${g.id.padEnd(22)} its input gate \`${g.consumes}\` failed`)
}
for (const g of notRun) printOut(`  ----  ${g.id.padEnd(22)} not run (--bail)`)
if (
  failed.length === 0 &&
  skipped.length === 0 &&
  notRun.length === 0 &&
  (stage !== "prepush" || snapshotStable)
) {
  const marked = results.filter((r) => r.gate.hostDependent !== undefined)
  const note =
    marked.length === 0
      ? ""
      : ` (${marked.length} host-dependent: ${marked.map((r) => r.gate.id).join(", ")} ` +
        "— may have passed by finding nothing to check here)"
  const absent = missingExternalTools()
  if (absent.length > 0) {
    // Say what this green could NOT check. Absence is already part of the
    // receipt's identity, so a box that later gains one of these cannot replay
    // this result — but nothing told the reader that a whole lane sat out.
    printOut(
      `  [capabilities] absent on this host, so anything gated on them was skipped: ${absent.join(", ")}`,
    )
  }
  printOut(`${stage}: ok — ${results.length} of ${planned.length} gate(s) passed${note}`)
  if (stage === "prepush") {
    if (endingSnapshot !== undefined) {
      const current = verificationContextForSnapshot(
        REPO_ROOT,
        endingSnapshot,
        plannedManifestSha256,
      )
      if (current.statusSha256 !== cleanStatusSha256) {
        throw new Error("internal error: refusing to persist a dirty exact receipt")
      }
      writeExactVerificationReceipt(exactReceiptPath, mintExactVerificationReceipt(current))
      printOut(`prepush: exact receipt stored path=${exactReceiptPath}`)
    }
    emitReceipt(
      makeReceipt({
        planned,
        results,
        skipped,
        frozen: frozenSnapshot,
        ending: endingSnapshot,
        manifestSha256: plannedManifestSha256,
        overallStarted,
        snapshotStable: true,
        status: "passed",
      }),
    )
  }
  process.exit(0)
}
if (
  stage === "prepush" &&
  !snapshotStable &&
  failed.length === 0 &&
  skipped.length === 0 &&
  notRun.length === 0
) {
  const message = snapshotInvalidMessage(frozenSnapshot, endingSnapshot, snapshotError)
  printErr(`\nprepush: INVALID — ${message}`)
  emitReceipt(
    makeReceipt({
      planned,
      results,
      skipped,
      frozen: frozenSnapshot,
      ending: endingSnapshot,
      manifestSha256: plannedManifestSha256,
      overallStarted,
      snapshotStable: false,
      status: "invalid",
      error: message,
    }),
  )
  process.exit(1)
}
// No INCOMPLETE branch: a skip requires a failed producer and a not-run requires
// `--bail` to have fired, so `failed.length === 0` alongside either is
// unsatisfiable. An audit instrumented the old branch across 14 scenarios and it
// fired 0 times — dead code that claimed to handle a case.
//
// The denominator is what the STAGE asked for, not what happened to run. The
// first fix changed only the "ok" line, so `--bail` still reported
// "1 of 1 gate(s) FAILED" while seven never ran.
printErr(`\n${stage}: ${failed.length} FAILED of ${planned.length} gate(s) in this stage:`)
for (const r of failed) printErr(`  ${r.gate.id} — ${r.gate.why}`)
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
    printErr(`\n──── ${r.gate.id} ${label} (${all.length} line(s))`)
    if (elided <= 0) {
      for (const line of all) printErr(`  ${line}`)
      continue
    }
    for (const line of head) printErr(`  ${line}`)
    printErr(`  … ${elided} line(s) elided …`)
    for (const line of tail) printErr(`  ${line}`)
  }
}
if (stage === "prepush") {
  if (!snapshotStable) {
    const message = snapshotInvalidMessage(frozenSnapshot, endingSnapshot, snapshotError)
    printErr(`\nprepush: INVALID — ${message}`)
    emitReceipt(
      makeReceipt({
        planned,
        results,
        skipped,
        frozen: frozenSnapshot,
        ending: endingSnapshot,
        manifestSha256: plannedManifestSha256,
        overallStarted,
        snapshotStable: false,
        status: "invalid",
        error: message,
      }),
    )
  } else {
    emitReceipt(
      makeReceipt({
        planned,
        results,
        skipped,
        frozen: frozenSnapshot,
        ending: endingSnapshot,
        manifestSha256: plannedManifestSha256,
        overallStarted,
        snapshotStable: true,
        status: "failed",
      }),
    )
  }
}
process.exit(1)
