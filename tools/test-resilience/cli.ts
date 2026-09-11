#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: CLI tool — plain console.log/console.error is the intended IO surface.
/**
 * Flake DIAGNOSIS — advisory only, and structurally incapable of producing a PASS.
 *
 * # What changed and why
 *
 * This used to be `run`: it executed `bun test tests/unit tests/integration`
 * itself, parsed the failures, and re-ran each one. Three defects, all of them
 * about AUTHORITY rather than about flakes:
 *
 *   1. It was a second broad-suite executor. It bypassed the managed shard
 *      runner's tier selection, resource policy, worker HOMEs, cache, lease and
 *      receipts — so its verdict answered for a run nobody had admitted.
 *   2. Its per-failure isolation amplified: N failures became up to 2N children
 *      (see `diagnose.ts`).
 *   3. Its retry result sat next to a `return 0`, one edit away from being a
 *      green.
 *
 * Now:
 *
 *   - `diagnose` CONSUMES `quanta.test-failure-attempt.v1`, written by whoever
 *     holds the lease. **There is no fallback.** Without the artifact the tool
 *     exits 2. A fallback is how the second authority came back last time.
 *   - Diagnosis is deduplicated, batched one-child-per-file, and bounded by a
 *     global child/time budget.
 *   - **`diagnose` can never exit 0.** 0 is the universal success code, so the
 *     only way a diagnostic result can be mistaken for a required PASS is if it
 *     can produce one. It cannot: the exit vocabulary is 1 (confirmed-real
 *     present), 3 (no confirmed-real — still not a pass) and 2 (fail-closed).
 *     `tests/unit/tools/test-resilience-diagnosis-hellgate.test.ts` pins it.
 *   - The report schema is `quanta.flake-diagnosis.v1`, which no gate reads.
 *
 * Commands:
 *   diagnose --from-artifact <path> [--out <path>] [--first-failure-out <path>]
 *   quarantine-check
 *
 * Exit: 1 = confirmed-real failures; 3 = diagnosis without a confirmed-real;
 *       2 = usage / missing / invalid artifact (fail closed); 0 = never.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mayQuarantine, preserveFirstFailure } from "../dev/verification-first-failure"
import { runBoundedChild } from "./bounded-child"
import {
  type ChildEvidence,
  classifyRecord,
  DEFAULT_BUDGET,
  type DiagnosisReport,
  type DiagnosisRow,
  outcomeCounts,
  planDiagnosis,
} from "./diagnose"
import {
  type FailureAttemptArtifact,
  type FailureRecord,
  parseFailureArtifact,
  replayCommand,
} from "./failure-artifact"
import { parseJunitCases, selectorMatchedNothing } from "./junit"
import type { QuarantineLedgerV2 } from "./quarantine"
import { validateQuarantineLedger } from "./quarantine"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const LEDGER_PATH = join(import.meta.dir, "quarantine.json")

const EXIT_CONFIRMED_REAL = 1
const EXIT_FAIL_CLOSED = 2
const EXIT_NO_CONFIRMED_REAL = 3

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const loadLedger = (): QuarantineLedgerV2 => {
  const raw = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as QuarantineLedgerV2
  return { maxCount: raw.maxCount, entries: raw.entries }
}

/** Run ONE diagnostic child for a whole file's worth of failures. */
const diagnoseBatch = async (
  file: string,
  selector: string,
  perChildMs: number,
): Promise<ChildEvidence> => {
  const junitPath = join(
    process.env.TMPDIR ?? "/tmp",
    `flake-diagnosis-${process.pid}-${crypto.randomUUID()}.xml`,
  )
  const outcome = await runBoundedChild({
    cmd: [
      "bun",
      "test",
      file,
      "-t",
      selector,
      "--reporter=junit",
      `--reporter-outfile=${junitPath}`,
    ],
    cwd: REPO_ROOT,
    env: process.env,
    limits: { totalMs: perChildMs, inactivityMs: Math.min(perChildMs, 30_000) },
  })
  const combined = `${outcome.stdout}\n${outcome.stderr}`
  if (outcome.survivors !== 0) {
    console.error(
      `[diagnose] WARN ${file}: survivors=${outcome.survivors ?? "unknown"} after the kill sequence`,
    )
  }
  // "completed" means the CHILD gave a verdict. A deadline, a cancellation or a
  // failed spawn is infrastructure, and a test must never be classified from it.
  if (outcome.status !== "passed" && outcome.status !== "failed") {
    console.error(
      `[diagnose] ${file}: child stopped as ${outcome.status}` +
        `${outcome.deadline === undefined ? "" : ` (${outcome.deadline} deadline)`} ` +
        `after ${outcome.elapsedMs}ms of a declared ${outcome.deadlineBudgetMs}ms`,
    )
    return { completed: false, selectorMatchedNothing: false, statusByTestId: new Map() }
  }
  if (selectorMatchedNothing(combined)) {
    return { completed: true, selectorMatchedNothing: true, statusByTestId: new Map() }
  }
  let xml = ""
  try {
    xml = readFileSync(junitPath, "utf8")
  } catch {
    // No JUnit file from a child that exited: a compile error or a crash before
    // the reporter flushed. That is infrastructure, not a test verdict.
    return { completed: false, selectorMatchedNothing: false, statusByTestId: new Map() }
  }
  const statusByTestId = new Map<string, "pass" | "fail" | "skip">()
  for (const testCase of parseJunitCases(xml)) statusByTestId.set(testCase.testId, testCase.status)
  return { completed: true, selectorMatchedNothing: false, statusByTestId }
}

const detailFor = (record: FailureRecord, evidence: ChildEvidence): string => {
  if (!evidence.completed) return "diagnostic child did not complete within its bounds"
  if (evidence.selectorMatchedNothing) return "`-t` selected no test — renamed, deleted or skipped"
  const status = evidence.statusByTestId.get(record.testId)
  if (status === undefined) return "the child produced no <testcase> for this exact test id"
  return `isolated run reported ${status}; ONE observation is not a flake diagnosis`
}

const cmdDiagnose = async (): Promise<number> => {
  const artifactPath = flag("--from-artifact") ?? process.env.QUANTA_TEST_FAILURE_ARTIFACT
  if (artifactPath === undefined || artifactPath === "") {
    console.error(
      "[diagnose] ✗ FAIL CLOSED: no failure artifact.\n" +
        "  This tool no longer runs a suite of its own — the authoritative attempt is an INPUT.\n" +
        "  Pass --from-artifact <quanta.test-failure-attempt.v1 path> or set QUANTA_TEST_FAILURE_ARTIFACT.\n" +
        "  Producer wiring: docs/plans/sep-12-test-verification-hardening/handoff-tvh15.md",
    )
    return EXIT_FAIL_CLOSED
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(artifactPath, "utf8"))
  } catch (error) {
    console.error(`[diagnose] ✗ FAIL CLOSED: cannot read ${artifactPath}: ${String(error)}`)
    return EXIT_FAIL_CLOSED
  }
  const load = parseFailureArtifact(raw)
  if (load.kind !== "ok") {
    console.error(
      `[diagnose] ✗ FAIL CLOSED: ${artifactPath} is not a valid artifact: ${load.reason}`,
    )
    return EXIT_FAIL_CLOSED
  }
  return runDiagnosis(load.artifact)
}

const preserveArtifact = (artifact: FailureAttemptArtifact): readonly unknown[] =>
  artifact.failures.map((record) =>
    preserveFirstFailure(
      {
        testId: record.testId,
        kind: record.kind,
        fingerprint: record.fingerprint,
        // The real SHA and the real elapsed, from the attempt that observed the
        // failure. The old adapter wrote "" and 0 here, which made the preserved
        // record unable to answer the only two questions it exists for.
        sha: artifact.head,
        elapsedMs: record.elapsedMs,
      },
      { passed: false, fingerprint: record.fingerprint },
    ),
  )

const runDiagnosis = async (artifact: FailureAttemptArtifact): Promise<number> => {
  const startedAt = Date.now()
  const preserved = preserveArtifact(artifact)
  const firstFailureOut = flag("--first-failure-out")
  if (firstFailureOut !== undefined) {
    writeFileSync(firstFailureOut, `${JSON.stringify(preserved, null, 2)}\n`)
  }
  console.log(
    `[diagnose] artifact head=${artifact.head.slice(0, 12)} suite=${artifact.suite} ` +
      `failures=${artifact.failures.length} seed=${artifact.replay.seed} ` +
      `perm=${artifact.replay.permutation} cores=${artifact.replay.cores} ` +
      `load1m=${artifact.replay.loadAverage1m} workers=${artifact.replay.workerParallel} ` +
      `intra=${artifact.replay.intraParallel} claims=[${artifact.replay.resourceClaims.join(",")}] ` +
      `runner_retries=${artifact.replay.retryCount}`,
  )
  if (artifact.replay.retryCount > 0) {
    console.error(
      `[diagnose] WARN the producing attempt already retried ${artifact.replay.retryCount}×; ` +
        "its verdict is a retry verdict, and diagnosis inherits that ambiguity",
    )
  }
  const plan = planDiagnosis(artifact.failures, DEFAULT_BUDGET)
  console.log(
    `[diagnose] plan: ${plan.batches.length} child(ren) for ${artifact.failures.length} failure(s) ` +
      `(${plan.deduped.length} deduped, ${plan.overBudget.length} over budget)`,
  )
  const rows: DiagnosisRow[] = []
  let childrenSpawned = 0
  for (const batch of plan.batches) {
    if (Date.now() - startedAt >= DEFAULT_BUDGET.maxTotalMs) {
      for (const record of batch.records) {
        rows.push({
          file: record.file,
          testId: record.testId,
          fingerprint: record.fingerprint,
          outcome: "inconclusive",
          detail: "global diagnosis time budget exhausted before this batch ran",
          replay: replayCommand(artifact, record),
        })
      }
      continue
    }
    childrenSpawned += 1
    const evidence = await diagnoseBatch(batch.file, batch.selector, DEFAULT_BUDGET.perChildMs)
    for (const record of batch.records) {
      rows.push({
        file: record.file,
        testId: record.testId,
        fingerprint: record.fingerprint,
        outcome: classifyRecord(record, evidence),
        detail: detailFor(record, evidence),
        replay: replayCommand(artifact, record),
      })
    }
  }
  for (const record of plan.overBudget) {
    rows.push({
      file: record.file,
      testId: record.testId,
      fingerprint: record.fingerprint,
      outcome: "inconclusive",
      detail: `beyond the global child budget (${DEFAULT_BUDGET.maxChildren})`,
      replay: replayCommand(artifact, record),
    })
  }
  // Named `diagnosis`, not `report`: this is a `quanta.flake-diagnosis.v1`
  // artifact and NOT the canonical bench report, which BFND-02 requires to have
  // exactly one writer. My earlier commit called the local `report` and the
  // single-writer ratchet counted this file as a second writer of something it
  // has nothing to do with — invisible until the suite that owns that ratchet
  // actually ran.
  const diagnosis: DiagnosisReport = {
    schema: "quanta.flake-diagnosis.v1",
    advisory: true,
    required: "failed",
    head: artifact.head,
    childrenSpawned,
    elapsedMs: Date.now() - startedAt,
    counts: outcomeCounts(rows),
    rows,
  }
  const out = flag("--out")
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(diagnosis, null, 2)}\n`)
  for (const row of rows) {
    console.log(`  ${row.outcome.padEnd(24)} ${row.file} :: ${row.testId}\n      ${row.detail}`)
    console.log(`      replay: ${row.replay}`)
  }
  console.log(
    `[diagnose] children=${childrenSpawned} ` +
      Object.entries(diagnosis.counts)
        .map(([name, count]) => `${name}=${count}`)
        .join(" "),
  )
  console.log(
    "[diagnose] ADVISORY — the required verdict for this attempt is 'failed' and this run " +
      "cannot change it. An observed-isolation-pass is ONE observation, not a flake diagnosis.",
  )
  return diagnosis.counts["confirmed-real"] > 0 ? EXIT_CONFIRMED_REAL : EXIT_NO_CONFIRMED_REAL
}

const cmdQuarantineCheck = (): number => {
  const ledger = loadLedger()
  const violations = validateQuarantineLedger(ledger, {
    nowMs: Date.now(),
    readTestSource: (file) => {
      try {
        return readFileSync(join(REPO_ROOT, file), "utf8")
      } catch {
        return undefined
      }
    },
  })
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`[quarantine] ✗ ${violation.kind} ${violation.entry}: ${violation.detail}`)
    }
    return 1
  }
  const critical = ledger.entries.filter((entry) => !mayQuarantine(entry.file))
  if (critical.length > 0) {
    console.error(`[quarantine] ✗ critical tests quarantined: ${critical.length}`)
    return 1
  }
  console.log(
    `[quarantine] ✓ ${ledger.entries.length}/${ledger.maxCount} entries, all with owner, issue, ` +
      "firstSeenSha, fingerprint, resource claim, live test id and an unexpired date",
  )
  return 0
}

const main = async (): Promise<number> => {
  const cmd = process.argv[2]
  switch (cmd) {
    case "diagnose":
    // `run` is kept ONLY so `package.json`'s `test:resilient` fails LOUDLY with
    // the fail-closed message instead of silently starting a broad suite. See
    // the handoff for the replacement script string.
    case "run":
      return cmdDiagnose()
    case "quarantine-check":
      return cmdQuarantineCheck()
    default:
      console.error(
        "usage: bun run tools/test-resilience/cli.ts " +
          "<diagnose --from-artifact <path> [--out <path>] [--first-failure-out <path>] | quarantine-check>",
      )
      return EXIT_FAIL_CLOSED
  }
}

if (import.meta.main) process.exit(await main())
