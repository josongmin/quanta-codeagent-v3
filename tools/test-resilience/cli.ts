#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: CLI tool — plain console.log/console.error is the intended IO surface.
/**
 * Flake-resilient test runner (SOTA ④: auto-detect + quarantine).
 *
 * The full parallel suite (2000+ files) intermittently flakes a handful of
 * resource-heavy tests (real rust-analyzer thundering-herd, child-process
 * reaper interference) that ALL pass in true isolation. Retrying blindly hides
 * real bugs; ignoring flakes erodes the signal. This runner does neither:
 *
 *   1. run the suite once, parse the failures
 *   2. re-run EACH failure in true isolation (`bun test <file> -t "<leaf>"`)
 *   3. classify: isolated-pass ⇒ FLAKE, isolated-fail ⇒ REAL
 *   4. REAL failures block (exit 1). FLAKES are checked against the quarantine
 *      ledger — a KNOWN flake passes; an UNKNOWN flake blocks (exit 1) so new
 *      flakiness can never slip in silently.
 *   5. the ledger count is a one-directional ratchet (`maxCount`).
 *
 * Commands:
 *   run [paths...]      run + isolate-classify (default paths: tests/unit tests/integration)
 *   quarantine-check    static ratchet: ledger entry count <= maxCount
 *
 * Exit: 0 = clean or only-known-flakes; 1 = real failure / new flake / ratchet breach; 2 = usage.
 */
import { join } from "node:path"
import {
  isQuarantined,
  type ParsedFailure,
  type QuarantineLedger,
  parseBunTestOutput,
} from "./parse"

const LEDGER_PATH = join(import.meta.dir, "quarantine.json")

const loadLedger = async (): Promise<QuarantineLedger> => {
  const raw = JSON.parse(await Bun.file(LEDGER_PATH).text()) as QuarantineLedger & {
    _comment?: string
  }
  return { maxCount: raw.maxCount, entries: raw.entries }
}

const runBunTest = async (args: string[]): Promise<{ output: string; exitCode: number }> => {
  const proc = Bun.spawn(["bun", "test", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { output: `${out}\n${err}`, exitCode }
}

/** "flake": passes when run alone. "real": still fails alone. "inconclusive":
 *  the `-t` pattern matched NOTHING (e.g. a name with regex-special chars) — we
 *  CANNOT confirm a flake, so it must NOT be silently treated as one. */
type IsolationVerdict = "flake" | "real" | "inconclusive"

/** Re-run ONE test in true isolation and classify it. */
const classifyInIsolation = async (f: ParsedFailure): Promise<IsolationVerdict> => {
  if (!f.file) return "inconclusive"
  const { output } = await runBunTest([f.file, "-t", f.leaf])
  const r = parseBunTestOutput(output)
  // `-t` matched nothing ⇒ the isolation didn't actually exercise the test.
  if (r.pass === 0 && r.fail === 0 && r.error === 0) return "inconclusive"
  // passes alone (and at least one test ran) ⇒ flake.
  if (r.fail === 0 && r.error === 0 && r.pass > 0) return "flake"
  return "real"
}

const cmdRun = async (paths: string[]): Promise<number> => {
  const targets = paths.length > 0 ? paths : ["tests/unit", "tests/integration"]
  console.log(`[resilient] full run: bun test ${targets.join(" ")}`)
  const { output, exitCode } = await runBunTest(targets)
  const full = parseBunTestOutput(output)
  console.log(`[resilient] ${full.pass} pass · ${full.fail} fail · ${full.error} error`)

  if (full.failures.length === 0) {
    // A bun-level failure (compile error / crash / no-tests-found) yields a
    // non-zero exit with NO parsed test failures — never report that "clean".
    if (exitCode !== 0) {
      console.error(
        `[resilient] ✗ bun exited ${exitCode} with no parsed test failures — likely a ` +
          `compile error / crash / empty match. Surfacing (not 'clean'). Tail:`,
      )
      console.error(output.split("\n").slice(-15).join("\n"))
      return 1
    }
    console.log("[resilient] ✓ clean — no failures")
    return 0
  }

  const ledger = await loadLedger()
  const real: ParsedFailure[] = []
  const knownFlake: ParsedFailure[] = []
  const newFlake: ParsedFailure[] = []
  const inconclusive: ParsedFailure[] = []

  console.log(`[resilient] isolating ${full.failures.length} failure(s)…`)
  for (const f of full.failures) {
    const verdict = await classifyInIsolation(f)
    if (verdict === "real") {
      real.push(f)
      console.log(`  ✗ REAL    ${f.file} :: ${f.leaf}`)
    } else if (verdict === "inconclusive") {
      inconclusive.push(f)
      console.log(`  ? INCONCLUSIVE ${f.file} :: ${f.leaf}  (-t matched no test — cannot confirm flake)`)
    } else if (isQuarantined(f, ledger)) {
      knownFlake.push(f)
      console.log(`  ~ flake   ${f.file} :: ${f.leaf}  (known-quarantined)`)
    } else {
      newFlake.push(f)
      console.log(`  ! NEW-FLAKE ${f.file} :: ${f.leaf}  (passes isolated, NOT in ledger)`)
    }
  }

  console.log(
    `[resilient] real=${real.length} known-flake=${knownFlake.length} new-flake=${newFlake.length} inconclusive=${inconclusive.length}`,
  )
  // Anything we could not positively classify as a known flake BLOCKS — a flake
  // claim must be earned (isolated-green + in the ledger), never assumed.
  if (real.length > 0 || newFlake.length > 0 || inconclusive.length > 0) {
    console.error(
      `[resilient] ✗ blocking: ${real.length} real, ${newFlake.length} new-flake, ` +
        `${inconclusive.length} inconclusive. New flakes ⇒ add to quarantine.json (resourceClass + reason) or fix.`,
    )
    return 1
  }
  console.log("[resilient] ✓ no real failures — all failures are known, isolated-green flakes.")
  return 0
}

const cmdQuarantineCheck = async (): Promise<number> => {
  const ledger = await loadLedger()
  const n = ledger.entries.length
  if (n > ledger.maxCount) {
    console.error(`[resilient] ✗ quarantine ratchet breached: ${n} entries > maxCount ${ledger.maxCount}`)
    return 1
  }
  console.log(`[resilient] ✓ quarantine: ${n}/${ledger.maxCount} entries (within ratchet)`)
  return 0
}

const main = async (): Promise<number> => {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case "run":
      return cmdRun(rest)
    case "quarantine-check":
      return cmdQuarantineCheck()
    default:
      console.error("usage: bun run tools/test-resilience/cli.ts <run [paths...] | quarantine-check>")
      return 2
  }
}

process.exit(await main())
