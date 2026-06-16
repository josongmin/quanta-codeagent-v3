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

const runBunTest = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(["bun", "test", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return `${out}\n${err}`
}

/** Re-run ONE test in true isolation; true iff it passes alone (⇒ flake). */
const passesInIsolation = async (f: ParsedFailure): Promise<boolean> => {
  if (!f.file) return false
  const out = await runBunTest([f.file, "-t", f.leaf])
  const r = parseBunTestOutput(out)
  // A flake passes alone: zero fails/errors AND at least one test actually ran.
  return r.fail === 0 && r.error === 0 && r.pass > 0
}

const cmdRun = async (paths: string[]): Promise<number> => {
  const targets = paths.length > 0 ? paths : ["tests/unit", "tests/integration"]
  console.log(`[resilient] full run: bun test ${targets.join(" ")}`)
  const full = parseBunTestOutput(await runBunTest(targets))
  console.log(`[resilient] ${full.pass} pass · ${full.fail} fail · ${full.error} error`)

  if (full.failures.length === 0) {
    console.log("[resilient] ✓ clean — no failures")
    return 0
  }

  const ledger = await loadLedger()
  const real: ParsedFailure[] = []
  const knownFlake: ParsedFailure[] = []
  const newFlake: ParsedFailure[] = []

  console.log(`[resilient] isolating ${full.failures.length} failure(s)…`)
  for (const f of full.failures) {
    const flaky = await passesInIsolation(f)
    if (!flaky) {
      real.push(f)
      console.log(`  ✗ REAL    ${f.file} :: ${f.leaf}`)
    } else if (isQuarantined(f, ledger)) {
      knownFlake.push(f)
      console.log(`  ~ flake   ${f.file} :: ${f.leaf}  (known-quarantined)`)
    } else {
      newFlake.push(f)
      console.log(`  ! NEW-FLAKE ${f.file} :: ${f.leaf}  (passes isolated, NOT in ledger)`)
    }
  }

  console.log(
    `[resilient] real=${real.length} known-flake=${knownFlake.length} new-flake=${newFlake.length}`,
  )
  if (real.length > 0) {
    console.error(`[resilient] ✗ ${real.length} REAL failure(s) — blocking.`)
    return 1
  }
  if (newFlake.length > 0) {
    console.error(
      `[resilient] ✗ ${newFlake.length} NEW flake(s) not in the ledger — add to ` +
        `tools/test-resilience/quarantine.json (with resourceClass + reason) or fix. Blocking.`,
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
