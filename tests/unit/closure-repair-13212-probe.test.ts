/**
 * closure-repair INERT investigation (django-13212-equivalent) — LOCAL, pure.
 *
 * The campaign symptom: preset `agentless-v6-closure-repair` reports
 * `verifyRounds=none` on EVERY instance, including django-13212 / -11141 which
 * have a validated-red repro (installed=true, reproducedCount=5). The repair
 * reinject loop is INERT.
 *
 * Part A — GATE CHAIN (regression guard). Drives the REAL buildClosureSession +
 * benchShouldRunRepairPhase + the REAL preset resolution exactly as the driver's
 * buildClosureAttemptState/resolveRepairState do, with 13212-equivalent inputs.
 * Result: the chain resolves CORRECTLY to runRepair=true. The suspected gate
 * links are NOT the bug; this pins them so a future regression is caught.
 *
 * Part B — THE ACTUAL PROD BUG. The prod driver's runRepairPhase
 * (src/apps/bench/eval/driver.ts) called runRepairRounds WITHOUT the `readFile`
 * reader that the runner-core sibling passes. The repro primary rail
 * (reproAuthority:true) is decided SOLELY by the pytest-report classification,
 * which short-circuits to "exec_failed" → ok=false EVERY round when readFile is
 * absent (validator.ts: `readFile === undefined`). So a repro-rail repair loop
 * runs but can NEVER clear: the feature is inert. Part B proves the rail can
 * clear ONLY when readFile is supplied (the fix), with a paired no-readFile
 * control that can never clear (the bug).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pytestReportPathFor } from "@/agent/repro-test/execute"
import type { PrimaryRailStep } from "@/agent/closure"
import { buildClosureSession } from "@/runner/batch/eval/closure-session"
import { benchPostureFromState, resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import { benchShouldRunRepairPhase } from "@/runner/batch/eval/repair-phase-policy"
import { reproValidationCmd } from "@/runner/batch/eval/repro-command"
// PROD re-export — the exact orchestrator + validator the prod driver uses.
import { runRepairRounds } from "../../src/apps/bench/eval/repair/index"
import type { ExecFn, RunOnceResult } from "../../src/apps/bench/eval/repair/types"

const PROBLEM =
  "QuerySet.bulk_create() crashes on models with a primary key that is a OneToOneField. " +
  "Calling Model.objects.bulk_create([...]) raises an error instead of inserting the rows."

// ── Part A helpers ─────────────────────────────────────────────────────────
const buildSession = (over?: { reproducedCount?: number; installed?: boolean }) => {
  const reproTest = {
    installed: over?.installed ?? true,
    reproducedCount: over?.reproducedCount ?? 5,
    samples: 5,
    path: "reproduce_issue.py",
  }
  const reproScript =
    reproTest.installed === true && reproTest.reproducedCount > 0
      ? {
          cmd: reproValidationCmd({
            repo: "django/django",
            version: "3.1",
            scriptPath: reproTest.path,
          }),
          pytestReportPath: pytestReportPathFor(reproTest.path),
          baseValidatedRed: true,
        }
      : undefined
  return buildClosureSession({
    problemStatement: PROBLEM,
    stage1Files: [
      { file: "django/db/models/query.py", score: 5 },
      { file: "django/db/models/base.py", score: 2 },
    ],
    ownerResolved: [{ file: "django/db/models/query.py", forSymbol: "bulk_create" }],
    ownerNearTests: ["python -m pytest tests/bulk_create/tests.py -q"],
    ...(reproScript !== undefined ? { reproScript } : {}),
    posture: { lspNav: true, primaryRail: true, faultEvidence: true },
  })
}

const runRepairFor = (session: ReturnType<typeof buildSession>): boolean =>
  benchShouldRunRepairPhase({
    eligible: true,
    primaryRailEnabled: true,
    gateAction: session.bundle.gate.action,
    primaryRailStep: session.primaryRailStep,
    verificationPlan: session.bundle.plan,
  })

describe("Part A — gate chain resolves correctly for 13212 inputs", () => {
  test("REAL preset agentless-v6-closure-repair yields the right posture", () => {
    const state = resolveBenchKnobs({
      envVars: { QUANTA_BENCH_PRESET: "agentless-v6-closure-repair" },
    })
    const posture = benchPostureFromState(state, {})
    expect(posture.repairRounds).toBe(5) // closure-repair="5" parses to number 5
    expect(posture.inLoopExecMode).toBe("full") // benchRunsRepairPhase requires "full"
    expect(posture.primaryRail).toBe(true)
    expect(posture.faultEvidence).toBe(true)
    expect(posture.verificationPlan).toBe(true)
    expect(posture.reproTestK).toBe(5)
  })

  test("validated-red repro + faultEvidence ⇒ verify + primaryRailStep + runRepair true", () => {
    const session = buildSession()
    expect(session.bundle.plan.baseValidatedRed).toBe(true)
    expect(session.primaryRailStep).toBeDefined()
    expect(session.bundle.gate.action).toBe("verify")
    expect(runRepairFor(session)).toBe(true)
  })

  test("NEGATIVE: reproducedCount=0 ⇒ commit-now ⇒ runRepair false", () => {
    const session = buildSession({ reproducedCount: 0 })
    expect(session.bundle.gate.action).toBe("commit-now")
    expect(runRepairFor(session)).toBe(false)
  })

  test("NEGATIVE: installed=false ⇒ runRepair false", () => {
    const session = buildSession({ installed: false })
    expect(runRepairFor(session)).toBe(false)
  })
})

// ── Part B — the prod readFile bug ─────────────────────────────────────────
// A pytest sidecar report that classifies "resolved": exit 0 + a passing call.
const RESOLVED_REPORT = JSON.stringify({
  schema: 1,
  collected: 1,
  exitstatus: 0,
  reports: [{ nodeid: "reproduce_issue.py::test_bug", when: "call", outcome: "passed" }],
})

const REPRO_REPORT_PATH = "/tmp/sb/reproduce_issue.py.pytest-report.json"
const REPRO_CMD = `python -s reproduce_issue.py`

const reproRail = (): PrimaryRailStep => ({
  kind: "repro",
  cmd: REPRO_CMD,
  authority: "execution",
  successPredicate: { type: "test_exit_zero" },
  pytestReportPath: REPRO_REPORT_PATH,
})

// exec runs the repro; the round-1 patch makes it write a RESOLVED report.
const makeExec = (): ExecFn => async (_cmd) => ({ code: 0, stdout: "", stderr: "" })

const makeRunOnce = (): ((seed: string | undefined) => Promise<RunOnceResult>) => {
  let round = 0
  return async (_seed) => {
    round += 1
    return { patch: `diff round ${round}\n`, turns: 1 }
  }
}

describe("Part B — repro rail clears ONLY when readFile is supplied (the fix)", () => {
  test("WITH readFile (the fix): resolved pytest report ⇒ rail clears, validated true", async () => {
    const reports = new Map<string, string>([[REPRO_REPORT_PATH, RESOLVED_REPORT]])
    const out = await runRepairRounds({
      config: { maxRounds: 2 },
      problem: PROBLEM,
      runOnce: makeRunOnce(),
      validate: (await import("../../src/apps/bench/eval/repair/validator")).validate,
      buildContext: (await import("../../src/apps/bench/eval/repair/context")).buildRepairContext,
      sandbox: "/tmp/sb",
      exec: makeExec(),
      readFile: async (p: string) => {
        const r = reports.get(p)
        if (r === undefined) throw new Error(`no report at ${p}`)
        return r
      },
      timeoutMs: 1000,
      primaryRailStep: reproRail(),
    })
    expect(out.validated).toBe(true) // rail read the resolved report and cleared
    expect(out.rounds).toBeGreaterThan(0) // verifyRounds is recorded (rounds = history.length)
  })

  test("PAIRED CONTROL — WITHOUT readFile (the bug): rail ALWAYS exec_failed ⇒ never clears", async () => {
    const out = await runRepairRounds({
      config: { maxRounds: 2 },
      problem: PROBLEM,
      runOnce: makeRunOnce(),
      validate: (await import("../../src/apps/bench/eval/repair/validator")).validate,
      buildContext: (await import("../../src/apps/bench/eval/repair/context")).buildRepairContext,
      sandbox: "/tmp/sb",
      exec: makeExec(),
      // readFile OMITTED — reproduces the prod bug before the fix.
      timeoutMs: 1000,
      primaryRailStep: reproRail(),
    })
    // Even though the repro genuinely passes (exec exit 0 + a resolved report on
    // disk), the validator can't read it without `readFile`, so the rail is
    // classified exec_failed every round ⇒ the loop exhausts unresolved.
    expect(out.validated).toBe(false)
  })
})

// ── Part C — WIRING GUARD: the repair loop must pass readFile to runRepairRounds ──
// Part B proves the orchestrator contract; this binds the PROD wiring so reverting
// the fix (dropping `readFile` from the prod runRepairRounds call) is RED. Post the
// jun-30 keystone, the `runRepairRounds` call is shared by BOTH bench drivers via
// the exported `runRepairRoundsInSnapshot` helper (runner core driver) — so the
// readFile fix is wired ONCE there, and both drivers delegate to it (inheriting it).
// Source-level because the helper is reached through the un-exported runRepairPhase.
describe("Part C — repair loop wires readFile to runRepairRounds (shared SSOT)", () => {
  const repoRoot = join(import.meta.dir, "..", "..")
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8")

  test("the shared runRepairRoundsInSnapshot passes readFile (the fix)", () => {
    const src = read("src/runner/batch/eval/driver.ts")
    const callIdx = src.indexOf("runRepairRounds({")
    expect(callIdx).toBeGreaterThan(-1)
    // Scan from the call to the matching close of its single args object.
    expect(/readFile:\s*async/.test(src.slice(callIdx, callIdx + 2000))).toBe(true)
  })

  test("both drivers delegate repair rounds to the shared helper (inherit the wiring)", () => {
    // Neither driver can silently drop the readFile wiring without also dropping
    // the delegation — which this binds RED.
    expect(read("src/apps/bench/eval/driver.ts")).toContain("runRepairRoundsInSnapshot({")
    expect(read("src/runner/batch/eval/driver.ts")).toContain("runRepairRoundsInSnapshot({")
  })
})
