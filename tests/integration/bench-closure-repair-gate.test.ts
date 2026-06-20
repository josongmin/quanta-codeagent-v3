/**
 * CR-1/2/3 — HARD-SCENARIO hellgate for the CLOSURE-DRIVEN RUNNER's repair gate
 * (closure-repair preset wiring, jun-18). Drives the PROD driver
 * (`src/apps/bench/eval` → its own `runInstance`, the one full-remote uses) so
 * the assertions exercise the SAME code path as production, NOT the secondary
 * `src/runner/batch/eval/driver.ts`.
 *
 * What was just built (commits 6a80e999 / bbad31e5): a `closure-repair` knob →
 * `BenchPosture.repairRounds`, with the prod driver deriving
 *   repair = deps.repair ?? (posture.repairRounds !== undefined
 *              ? { maxRounds: posture.repairRounds } : undefined)
 * Previously the repair loop was reachable ONLY via `deps.repair`
 * (the `--repair-rounds` CLI flag), DISCONNECTED from the preset — so
 * `agentless-v2` selected a primary rail but NEVER gated (gate_enter_rate = 0).
 *
 *   CR-1  PRESET ENABLES REPAIR (core wiring; red-on-injection paired control).
 *   CR-2  FALSE-GREEN KILLED at the driver level (rail cmd gates, not agent's).
 *   CR-3  COMMIT-FAST avoids the verify loop (no-repro ⇒ commit-now ⇒ 1 pass).
 *
 * Env discipline: EVERY `QUANTA_BENCH_*` var set by a test is snapshot+restored
 * (try/finally) so a leaked posture cannot perturb another test.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PrimaryRailStep } from "@/agent/closure"
import { buildClosureSession } from "@/runner/batch/eval/closure-session"
import { benchShouldRunRepairPhase } from "@/runner/batch/eval/repair-phase-policy"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "../../src/apps/bench/eval"
import { buildRepairContext } from "../../src/apps/bench/eval/repair/context"
import { runRepairRounds } from "../../src/apps/bench/eval/repair/index"
import type { ExecFn, RunOnceResult } from "../../src/apps/bench/eval/repair/types"
import { validate as prodValidate } from "../../src/apps/bench/eval/repair/validator"
import type { Instance } from "../../src/apps/bench/types"

const RUN_INSTANCE_TIMEOUT_MS = 30_000
const DEPS = { maxTurns: 5, timeoutMs: 30000 }

/** A bash command that checks add(2,3)===5 against ./math.js IN THE SANDBOX.
 *  Used both as the agent's `editAndBash` verification command (captured by the
 *  stream tap as `lastVerifyCmd`) AND as the instance `testCmd` (official
 *  grader). Exits 1 when the bug is unfixed/wrong. */
const ADD_CHECK = `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`

const makeSwebenchInstance = (dir: string, id: string): Instance => {
  const repo = join(dir, `repo-${id}`)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, "math.js"), "exports.add = function(a, b) { return a - b }\n")
  return {
    id,
    repoPath: repo,
    problemStatement: `Fix the planted bug in math.js — add(a,b) must return a+b, not a-b.`,
    testCmd: ADD_CHECK,
    swebench: { instanceId: id, repo: `synthetic/${id}`, baseCommit: "HEAD" },
  }
}

// ── Scripted FakeLLM (same shape as bench-repair.test.ts; one scene per round).
type Scene =
  | { kind: "noop" }
  | { kind: "editAndBash"; file: string; old: string; new: string; bash: string }

class ScriptedLLM implements LLMPort {
  private turnInScene = 0
  private sceneIdx = -1
  readonly seedTextsSeen: string[] = []
  agentRuns = 0
  private lastSeed: string | undefined
  constructor(private readonly scenes: readonly Scene[]) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const seedText =
      input.messages[0]?.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? ""
    if (seedText !== this.lastSeed) {
      this.agentRuns += 1
      this.sceneIdx += 1
      this.turnInScene = 0
      this.seedTextsSeen.push(seedText)
      this.lastSeed = seedText
    }
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    const scene = this.scenes[Math.min(this.sceneIdx, this.scenes.length - 1)] ?? {
      kind: "noop" as const,
    }
    const turn = this.turnInScene
    this.turnInScene += 1
    if (turn === 0 && scene.kind === "editAndBash") {
      yield { type: "tool_use_start", id: `e${this.sceneIdx}`, name: "edit" }
      yield {
        type: "tool_use_end",
        id: `e${this.sceneIdx}`,
        input: { path: join(sandbox, scene.file), old_string: scene.old, new_string: scene.new },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    if (turn === 1 && scene.kind === "editAndBash") {
      yield { type: "tool_use_start", id: `b${this.sceneIdx}`, name: "bash" }
      yield { type: "tool_use_end", id: `b${this.sceneIdx}`, input: { command: scene.bash } }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "bench-closure-repair-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Snapshot+restore a set of env vars around a body — strict afterRestore so a
 *  leaked posture can never bleed into another test. */
const withEnv = async (
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> => {
  const keys = Object.keys(vars)
  const saved = new Map<string, string | undefined>()
  for (const k of keys) saved.set(k, process.env[k])
  try {
    for (const k of keys) {
      const v = vars[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await body()
  } finally {
    for (const k of keys) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// =========================================================================
// CR-1. PRESET ENABLES REPAIR — the core wiring, with a paired red-on-injection
// control. Scenes: round0 produces a WRONG fix whose own verify FAILS (exit 1),
// round1 produces the CORRECT fix whose verify PASSES (exit 0).
//
// The validate cmd is the agent's `editAndBash` bash (`lastVerifyCmd`, captured
// by BenchStreamTap), re-run by the PRODUCTION validator in the sandbox — see
// runValidate/validate: with NO primaryRailStep it runs `r.lastVerifyCmd` via
// `exec`, exit 0 ⇒ ok. So round0's failing check forces round1; round1's
// passing check clears the loop. NO `deps.repair` is passed — repair is driven
// PURELY by `QUANTA_BENCH_CLOSURE_REPAIR` → posture.repairRounds.
// =========================================================================
describe("CR-1 preset enables repair (core wiring)", () => {
  const scenes: readonly Scene[] = [
    // round0: wrong fix (a*b ⇒ add(2,3)=6) + the add-check verify (EXITS 1).
    { kind: "editAndBash", file: "math.js", old: "return a - b", new: "return a * b", bash: ADD_CHECK },
    // round1: correct fix (a+b) + the same add-check verify (EXITS 0).
    { kind: "editAndBash", file: "math.js", old: "return a * b", new: "return a + b", bash: ADD_CHECK },
  ]

  test(
    "QUANTA_BENCH_CLOSURE_REPAIR=2, no deps.repair ⇒ repair runs (2 agent runs, passes)",
    async () => {
      await withEnv(
        {
          QUANTA_BENCH_CLOSURE_REPAIR: "2",
          QUANTA_BENCH_PRIMARY_RAIL: undefined, // primaryRail OFF
          QUANTA_BENCH_PRESET: undefined,
          QUANTA_BENCH_SOTA: undefined,
        },
        async () => {
          await withTmp(async (dir) => {
            const inst = makeSwebenchInstance(dir, "cr1-on")
            const llm = new ScriptedLLM(scenes)
            // NO deps.repair — the preset budget alone must enable repair.
            const r = await runInstance(inst, { ...DEPS, llm })
            // Two agent runs ⇒ the repair loop re-seeded after round0's red verify.
            expect(llm.agentRuns).toBe(2)
            // The official grader passes on the cumulative (round1) patch.
            expect(r.passed).toBe(true)
            expect(r.patch).toContain("return a + b")
          })
        },
      )
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "RED-ON-INJECTION: same scenes, CLOSURE_REPAIR UNSET ⇒ single-pass, FAILS",
    async () => {
      await withEnv(
        {
          QUANTA_BENCH_CLOSURE_REPAIR: undefined, // the wiring's trigger removed
          QUANTA_BENCH_PRIMARY_RAIL: undefined,
          QUANTA_BENCH_PRESET: undefined,
          QUANTA_BENCH_SOTA: undefined,
        },
        async () => {
          await withTmp(async (dir) => {
            const inst = makeSwebenchInstance(dir, "cr1-off")
            const llm = new ScriptedLLM(scenes)
            const r = await runInstance(inst, { ...DEPS, llm })
            // No preset budget + no deps.repair ⇒ repair === undefined ⇒ single
            // pass. Only round0 (the WRONG fix) runs ⇒ grader fails.
            expect(llm.agentRuns).toBe(1)
            expect(r.passed).toBe(false)
            // The shipped patch is round0's wrong fix (proves we never reached
            // round1). a*b, not a+b.
            expect(r.patch).toContain("return a * b")
            expect(r.patch).not.toContain("return a + b")
          })
        },
      )
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )
})

// =========================================================================
// CR-2. FALSE-GREEN KILLED (driver level).
//
// Two layers, both hitting prod code:
//  (a) GATE-DECISION WIRING — with primaryRail ON + a repro that reproduced on
//      base (baseValidatedRed), the REAL closure session yields gate.action
//      "verify" and a primaryRailStep; benchShouldRunRepairPhase ⇒ true. With
//      the rail PRESENT and the gate NOT "verify" (no repro), it ⇒ false. This
//      pins the exact predicate the prod driver consults at driver.ts:646.
//  (b) FALSE-GREEN KILLER — drive the PROD orchestrator (`runRepairRounds`, the
//      same fn `runRepairPhase` calls) with the PRODUCTION `validate` and a
//      primaryRailStep. A fake exec makes the agent's OWN verify cmd green but
//      the RAIL cmd red: the round must NOT clear, because validate runs the
//      RAIL cmd, never the agent's green. The agent's exit-0 cannot ship a
//      false green.
//
// COVERAGE vs the unit test `repair-primary-rail-hellgate.test.ts` PR-1: PR-1
// asserts the same false-green-killer over a FAKE validate spy. CR-2(b) raises
// the bar by using the PRODUCTION `validate` (apps re-export) + a real exec
// seam, so the cmd-substitution AND the exit-code→ok mapping are both exercised
// through prod code. CR-2(a) additionally proves the driver's gate-decision
// wiring (closure session → benchShouldRunRepairPhase) that the unit test does
// not touch. A full repro-pipeline e2e (LLM-generated python repro that
// reproduces RED on base, promoting it to the rail inside runInstance) is
// intractable in the ScriptedLLM harness — installReproTestHint has no injected
// repro-generation/run seam at the runInstance boundary — so CR-2 splits into
// (a) real gate decision + (b) real orchestrator/validator, which together
// cover the driver path end-to-end minus the host-python repro generation.
// =========================================================================
describe("CR-2 false-green killed (driver level)", () => {
  const PROBLEM = "Fix the planted bug in math.js — add(a,b) must return a+b, not a-b."

  test("(a) gate wiring: primaryRail ON + reproduced repro ⇒ verify + runRepair true", () => {
    const session = buildClosureSession({
      problemStatement: PROBLEM,
      stage1Files: [{ file: "math.js", score: 1 }],
      reproScript: { cmd: `python "/tmp/repro.py"`, baseValidatedRed: true },
      posture: { lspNav: false, primaryRail: true, faultEvidence: false },
    })
    // The reproduced repro is promoted to the primary rail; the gate enters verify.
    expect(session.bundle.gate.action).toBe("verify")
    expect(session.primaryRailStep).toBeDefined()
    expect(session.primaryRailStep?.cmd).toBe(`python "/tmp/repro.py"`)
    expect(session.bundle.plan.baseValidatedRed).toBe(true)
    // The exact predicate the prod driver consults (driver.ts benchShouldRunRepairPhase).
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: true,
        gateAction: session.bundle.gate.action,
        primaryRailStep: session.primaryRailStep,
        verificationPlan: session.bundle.plan,
      }),
    ).toBe(true)
  })

  test("(a') gate wiring CONTROL: primaryRail ON + NO repro ⇒ commit-now, runRepair false", () => {
    const session = buildClosureSession({
      problemStatement: PROBLEM,
      stage1Files: [{ file: "math.js", score: 1 }],
      posture: { lspNav: false, primaryRail: true, faultEvidence: false },
    })
    // No reproduced repro ⇒ no external signal ⇒ gate stays commit-now ⇒ no rail.
    expect(session.bundle.gate.action).toBe("commit-now")
    expect(session.primaryRailStep).toBeUndefined()
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: true,
        gateAction: session.bundle.gate.action,
        primaryRailStep: session.primaryRailStep,
        verificationPlan: session.bundle.plan,
      }),
    ).toBe(false)
  })

  test("(b) false-green killer: agent verify GREEN but RAIL RED ⇒ round NOT cleared (prod validate)", async () => {
    const AGENT_CMD = "node -e 'process.exit(0)'" // the agent's own (green) verify
    const RAIL_CMD = `python "/repro.py"` // the typed primary rail
    const rail: PrimaryRailStep = {
      kind: "owner-test",
      cmd: RAIL_CMD,
      authority: "execution",
      successPredicate: { type: "selected_test_passes" },
    }
    // Fake exec: the agent cmd would PASS (exit 0); the rail cmd FAILS (exit 1).
    // If validate ran the agent's cmd it would clear the round (false green);
    // it must run the RAIL cmd and stay red.
    const execSeen: string[] = []
    const exec: ExecFn = async (cmd) => {
      execSeen.push(cmd)
      return cmd === RAIL_CMD
        ? { code: 1, stdout: "", stderr: "rail assertion failed" }
        : { code: 0, stdout: "agent says ok", stderr: "" }
    }
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/math.js b/math.js\n+return a * b\n",
      turns: 1,
      lastVerifyCmd: AGENT_CMD, // agent's GREEN cmd
    })
    const out = await runRepairRounds({
      config: { maxRounds: 2 },
      problem: PROBLEM,
      runOnce,
      validate: prodValidate, // PRODUCTION validator (apps re-export)
      buildContext: buildRepairContext,
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
      primaryRailStep: rail,
    })
    // validate must have re-executed the RAIL cmd EVERY round, never the agent's.
    expect(execSeen.length).toBeGreaterThan(0)
    expect(execSeen.every((c) => c === RAIL_CMD)).toBe(true)
    expect(execSeen).not.toContain(AGENT_CMD)
    // The rail never went green ⇒ the loop exhausts unresolved (false green killed).
    expect(out.validated).toBe(false)
    // round0 + 2 repair rounds, all gated on the rail.
    expect(out.rounds).toBe(3)
  })

  test("(b') CONTROL: rail GREEN ⇒ round clears on the rail (proves (b)'s red is the rail, not a stuck loop)", async () => {
    const RAIL_CMD = `python "/repro.py"`
    const rail: PrimaryRailStep = {
      kind: "owner-test",
      cmd: RAIL_CMD,
      authority: "execution",
      successPredicate: { type: "selected_test_passes" },
    }
    const exec: ExecFn = async (cmd) =>
      cmd === RAIL_CMD ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" }
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff\n",
      turns: 1,
      lastVerifyCmd: "node -e 'process.exit(1)'", // agent's own cmd is RED here
    })
    const out = await runRepairRounds({
      config: { maxRounds: 2 },
      problem: PROBLEM,
      runOnce,
      validate: prodValidate,
      buildContext: buildRepairContext,
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
      primaryRailStep: rail,
    })
    // Rail green on round0 ⇒ cleared immediately (1 round), even though the
    // agent's OWN cmd was red — the rail is the authority.
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(1)
  })
})

// =========================================================================
// CR-3. COMMIT-FAST — over-verify avoidance. No repro reproduced ⇒ gate
// commit-now ⇒ single pass EVEN WITH `closure-repair` set AND primaryRail ON.
// The repair budget must NOT trigger a wasted verify loop on a no-signal case.
//
// With primaryRail ON, benchShouldRunRepairPhase requires gateAction "verify";
// with no repro the gate is commit-now (CR-2 (a') pins this), so runRepair is
// false ⇒ runAgentPhase single pass ⇒ 1 agent run.
//
// TEETH: the agent applies the CORRECT fix but its OWN verify bash (`FAIL_BASH`)
// deliberately EXITS NONZERO and is DISTINCT from the official grader
// (`testCmd === ADD_CHECK`). So:
//   • commit-fast (correct wiring): single pass — the agent's red bash is never
//     re-run by a validator; the grader runs the (correct) patch and PASSES.
//   • IF the verify loop wrongly ran: round0's validator would re-execute
//     FAIL_BASH ⇒ red ⇒ re-seed ⇒ a SECOND agent run (agentRuns===2).
// This makes agentRuns===1 load-bearing: it can ONLY hold if the gate kept us
// out of the repair loop (a correct-but-round0-cleared loop would still be 1
// run, which is why we force round0's bash RED here).
// =========================================================================
describe("CR-3 commit-fast avoids the verify loop", () => {
  // A check that always EXITS 1 — the agent's "own verify" that a wrongful
  // repair loop would re-run and fail on. NOT the official grader.
  const FAIL_BASH = `node -e "process.exit(1)"`

  test(
    "CLOSURE_REPAIR=2 + PRIMARY_RAIL=1 + no repro ⇒ single pass (1 agent run, no wasted loop)",
    async () => {
      await withEnv(
        {
          QUANTA_BENCH_CLOSURE_REPAIR: "2",
          QUANTA_BENCH_PRIMARY_RAIL: "1",
          QUANTA_BENCH_REPRO_TEST: undefined, // no repro ⇒ reproAvailable false
          QUANTA_BENCH_PRESET: undefined,
          QUANTA_BENCH_SOTA: undefined,
        },
        async () => {
          await withTmp(async (dir) => {
            const inst = makeSwebenchInstance(dir, "cr3")
            // One scene: the CORRECT fix, but a deliberately RED agent verify
            // (FAIL_BASH). If a verify loop ran, round0 validate would fail on
            // FAIL_BASH and force a 2nd agent run.
            const llm = new ScriptedLLM([
              {
                kind: "editAndBash",
                file: "math.js",
                old: "return a - b",
                new: "return a + b",
                bash: FAIL_BASH,
              },
            ])
            const r = await runInstance(inst, { ...DEPS, llm })
            // Commit-fast: exactly one agent run — the gate kept us out of the
            // repair loop despite CLOSURE_REPAIR=2 (else FAIL_BASH ⇒ 2nd run).
            expect(llm.agentRuns).toBe(1)
            // The single pass produced the correct patch; the OFFICIAL grader
            // (ADD_CHECK, distinct from the agent's FAIL_BASH) passes it.
            expect(r.passed).toBe(true)
            expect(r.patch).toContain("return a + b")
          })
        },
      )
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )
})
