import { describe, expect, test } from "bun:test"
import type { PrimaryRailStep } from "@/agent/closure"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type {
  RunOnceResult,
  RunRepairRoundsArgs,
  ValidateArgs,
  ValidatorResult,
} from "@/runner/batch/eval/repair/types"

/**
 * jun-28 STRONG-ORACLE clear gate — ORCHESTRATOR integration over `runRepairRounds`.
 *
 * Teeth:
 *  - self-repro GREEN but declared-expected MISMATCH ⇒ does NOT clear ⇒ loop continues.
 *  - self-repro GREEN + declared-expected MATCH (+ consensus) ⇒ clears.
 *  - issue declares NO expected + only one repro ⇒ FAIL-OPEN (clears on green, as today).
 *  - repro-vote consensus present + MINORITY-green ⇒ does NOT clear.
 *  - Knob OFF ⇒ byte-identical (legacy single-green clear) even on a contradicting signal.
 */

const railStep: PrimaryRailStep = {
  kind: "repro",
  cmd: 'python "repro.py"',
  authority: "execution",
  successPredicate: { type: "stdout_contains", substring: "Issue resolved" },
}

const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
  patch: "diff --git a/x b/x\n",
  turns: 1,
  lastVerifyCmd: "pytest",
})

const scriptedValidator = (results: readonly ValidatorResult[]) => {
  let i = 0
  return async (_a: ValidateArgs): Promise<ValidatorResult> => {
    const r = results[Math.min(i, results.length - 1)] as ValidatorResult
    i++
    return r
  }
}

const base = (
  over: Partial<RunRepairRoundsArgs>,
): Omit<RunRepairRoundsArgs, "config" | "validate"> => ({
  problem: "fix it",
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  runOnce,
  ...over,
})

describe("STRONG-ORACLE loop — declared-expected conjunct (no primary rail)", () => {
  test("🔴 self-repro GREEN + declared-expected MISMATCH ⇒ does NOT clear ⇒ loop iterates", async () => {
    const out = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 1, strongOracle: true },
      validate: scriptedValidator([
        // round 0: exit-code green but declared-expected predicate mismatch.
        { ok: true, predicate: { evaluable: true, matched: false } },
        // round 1: now matches ⇒ clears.
        { ok: true, predicate: { evaluable: true, matched: true } },
      ]),
    })
    // The round-0 over-narrow false green did NOT stop the loop; round 1 cleared.
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(2)
  })

  test("self-repro GREEN + declared-expected MATCH ⇒ CLEARS at round 0", async () => {
    const out = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 2, strongOracle: true },
      validate: scriptedValidator([{ ok: true, predicate: { evaluable: true, matched: true } }]),
    })
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(1) // round 0 only — cleared immediately
  })

  test("FAIL-OPEN: issue declares NOTHING (no predicate) + single repro ⇒ clears on green (as today)", async () => {
    const out = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 2, strongOracle: true },
      validate: scriptedValidator([{ ok: true }]),
    })
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(1)
  })
})

describe("STRONG-ORACLE loop — repro-vote consensus conjunct", () => {
  test("🔴 exit-0 green + consensus 'reproduced' (minority-green) ⇒ does NOT clear", async () => {
    const out = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 1, strongOracle: true },
      validate: scriptedValidator([
        // round 0: exit-code green yet the K-of-N vote says the bug still reproduces.
        { ok: true, consensus: "reproduced" },
        // round 1: vote now resolved ⇒ clears.
        { ok: true, consensus: "resolved" },
      ]),
    })
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(2)
  })

  test("exit-0 green + consensus 'resolved' ⇒ CLEARS", async () => {
    const out = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 2, strongOracle: true },
      validate: scriptedValidator([{ ok: true, consensus: "resolved" }]),
    })
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(1)
  })
})

describe("STRONG-ORACLE loop — composes with the primary-rail finish gate", () => {
  test("rail set + declared MATCH + consensus resolved ⇒ clears", async () => {
    const out = await runRepairRounds({
      ...base({ primaryRailStep: railStep }),
      config: { maxRounds: 2, strongOracle: true },
      validate: scriptedValidator([
        { ok: true, predicate: { evaluable: true, matched: true }, consensus: "resolved" },
      ]),
    })
    expect(out.validated).toBe(true)
  })

  test("rail set + consensus 'reproduced' (strong-oracle red) ⇒ does NOT clear", async () => {
    const out = await runRepairRounds({
      ...base({ primaryRailStep: railStep }),
      config: { maxRounds: 1, strongOracle: true },
      validate: scriptedValidator([
        // round 0: rail predicate matches (legacy gate would clear) BUT the vote
        // says reproduced ⇒ strong-oracle withholds the clear.
        { ok: true, predicate: { evaluable: true, matched: true }, consensus: "reproduced" },
        { ok: false, failTail: "still broken" },
      ]),
    })
    expect(out.validated).toBe(false)
  })
})

describe("STRONG-ORACLE loop — DEFAULT-OFF byte-identical", () => {
  test("knob OFF: a contradicting strong signal still CLEARS on green (legacy single-green)", async () => {
    const out = await runRepairRounds({
      ...base({}),
      // strongOracle ABSENT ⇒ the strengthened branch is skipped entirely.
      config: { maxRounds: 2 },
      validate: scriptedValidator([
        // Exit-code green with a declared-expected MISMATCH + reproduced consensus —
        // strong-oracle would withhold; with the knob OFF it clears (byte-identical).
        { ok: true, predicate: { evaluable: true, matched: false }, consensus: "reproduced" },
      ]),
    })
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(1)
  })

  test("knob OFF: exact same scripted run as the ON declared-mismatch test, but clears at round 0", async () => {
    const scripted: readonly ValidatorResult[] = [
      { ok: true, predicate: { evaluable: true, matched: false } },
      { ok: true, predicate: { evaluable: true, matched: true } },
    ]
    const off = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 1 },
      validate: scriptedValidator(scripted),
    })
    const on = await runRepairRounds({
      ...base({}),
      config: { maxRounds: 1, strongOracle: true },
      validate: scriptedValidator(scripted),
    })
    // OFF clears at round 0 (lenient); ON withholds and runs round 1 (strict).
    expect(off.rounds).toBe(1)
    expect(on.rounds).toBe(2)
    expect(off.validated).toBe(true)
    expect(on.validated).toBe(true)
  })
})
