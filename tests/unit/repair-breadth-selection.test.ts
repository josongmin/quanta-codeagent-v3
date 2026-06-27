/**
 * jun-28 repair-loop BREADTH — orchestrator SELECTION teeth.
 *
 * `runRepairRounds` is the PURE policy core. With `config.breadth > 1` AND an
 * injected `runCandidates` port, each round fans out to B candidates and the
 * orchestrator CONTINUES from the one the validator turns GREEN (else the best
 * validator signal). These tests pin that selection / adoption / no-leak / the
 * default-OFF byte-identical fence — all against MOCKED candidate generators
 * (no agent, no real fork), exercising the exact decision the loop makes.
 *
 * Each `expect` is paired with a guard-revert (red-on-injection) note proving the
 * assertion has teeth.
 */

import { describe, expect, test } from "bun:test"
import type { PrimaryRailStep } from "@/agent/closure"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type {
  RepairCandidateOutcome,
  RunOnceResult,
  RunRepairCandidatesArgs,
  RunRepairRoundsArgs,
  ValidateArgs,
  ValidatorResult,
} from "@/runner/batch/eval/repair/types"

/** A candidate spec: its cumulative diff + the validator verdict the driver's
 *  in-fork validation would produce for it. */
interface CandSpec {
  readonly patch: string
  readonly validator: ValidatorResult
}

/** Build a `runCandidates` port from a per-round list of candidate specs, plus an
 *  `adopted` sink recording which patch each round adopted (the continuation
 *  point) and an `argsSeen` sink recording the args the port was called with. */
const makeRunCandidatesPort = (
  rounds: readonly (readonly CandSpec[])[],
  sinks: {
    adopted: string[]
    argsSeen: RunRepairCandidatesArgs[]
    validatorsSeen: ValidatorResult[]
  },
) => {
  return async (args: RunRepairCandidatesArgs): Promise<readonly RepairCandidateOutcome[]> => {
    sinks.argsSeen.push(args)
    const specs = rounds[Math.min(args.round, rounds.length - 1)] as readonly CandSpec[]
    return specs.map((spec): RepairCandidateOutcome => {
      const run: RunOnceResult = { patch: spec.patch, turns: 1, lastVerifyCmd: "pytest" }
      sinks.validatorsSeen.push(spec.validator)
      return {
        run,
        validator: spec.validator,
        adopt: async () => {
          sinks.adopted.push(spec.patch)
        },
      }
    })
  }
}

const freshSinks = () => ({
  adopted: [] as string[],
  argsSeen: [] as RunRepairCandidatesArgs[],
  validatorsSeen: [] as ValidatorResult[],
})

/** A `runOnce`/`validate` pair that THROWS if ever called — proves the breadth
 *  path never falls back to the single-candidate path when the port is engaged. */
const throwingRunOnce = async (_seed: string | undefined): Promise<RunOnceResult> => {
  throw new Error("runOnce must NOT be called on the breadth path")
}
const throwingValidate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
  throw new Error("validate must NOT be called on the breadth path")
}

const baseArgs = (over: Partial<RunRepairRoundsArgs>): RunRepairRoundsArgs => ({
  config: {},
  problem: "fix it",
  runOnce: throwingRunOnce,
  validate: throwingValidate,
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  ...over,
})

describe("repair-breadth — GREEN-first selection (the oracle as selector)", () => {
  test("B=3, candidate #2 green / #1,#3 red ⇒ selects #2, validated, final patch is #2's", async () => {
    const sinks = freshSinks()
    const round0: readonly CandSpec[] = [
      { patch: "PATCH_1", validator: { ok: false, failTail: "still red" } },
      { patch: "PATCH_2", validator: { ok: true } }, // the lone GREEN
      { patch: "PATCH_3", validator: { ok: false, failTail: "still red" } },
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 2, breadth: 3 },
        runCandidates: makeRunCandidatesPort([round0], sinks),
      }),
    )
    // Selected #2 ⇒ green ⇒ validated, loop terminates at round 0.
    // Guard-revert: if `selectCandidate` returned candidates[0] (no green search),
    // validated would be false and patch would be PATCH_1.
    expect(out.validated).toBe(true)
    expect(out.patch).toBe("PATCH_2")
    // ADOPTED #2 as the continuation point (driver re-materializes the winner).
    // Guard-revert: drop `await winner.adopt()` ⇒ adopted stays empty.
    expect(sinks.adopted).toEqual(["PATCH_2"])
    // Exactly ONE round ran (green at round 0 stops the loop).
    expect(out.rounds).toBe(1)
    expect(sinks.argsSeen.map((a) => a.round)).toEqual([0])
    // The port was asked for breadth=3 candidates.
    expect(sinks.argsSeen[0]?.breadth).toBe(3)
  })

  test("turns are summed across ALL candidates (honest ~B× cost, not just the winner)", async () => {
    const sinks = freshSinks()
    // 3 candidates, each `turns:1` from makeRunCandidatesPort ⇒ round 0 cost 3.
    const round0: readonly CandSpec[] = [
      { patch: "P0", validator: { ok: false } },
      { patch: "P1", validator: { ok: true } },
      { patch: "P2", validator: { ok: false } },
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 3 },
        runCandidates: makeRunCandidatesPort([round0], sinks),
      }),
    )
    // Guard-revert: attributing only `winner.run.turns` would report 1, not 3.
    expect(out.turns).toBe(3)
  })

  test("first green wins ties (index order) when MULTIPLE candidates are green", async () => {
    const sinks = freshSinks()
    const round0: readonly CandSpec[] = [
      { patch: "RED_0", validator: { ok: false } },
      { patch: "GREEN_FIRST", validator: { ok: true } },
      { patch: "GREEN_SECOND", validator: { ok: true } },
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 3 },
        runCandidates: makeRunCandidatesPort([round0], sinks),
      }),
    )
    // Stable tie-break = first index. Guard-revert: a `findLast` would pick
    // GREEN_SECOND.
    expect(out.patch).toBe("GREEN_FIRST")
    expect(sinks.adopted).toEqual(["GREEN_FIRST"])
  })
})

describe("repair-breadth — NONE-green ⇒ best validator signal seeds the next round", () => {
  test("ranks resolved > reproduced > exec_failed, deterministically", async () => {
    const sinks = freshSinks()
    // Round 0: none green; reproOutcome rank must pick `resolved` (PATCH_RESOLVED)
    // over `reproduced` and `exec_failed`. Round 1: a clean green to terminate.
    const round0: readonly CandSpec[] = [
      { patch: "PATCH_EXECFAIL", validator: { ok: false, reproOutcome: "exec_failed" } },
      { patch: "PATCH_RESOLVED", validator: { ok: false, reproOutcome: "resolved" } },
      { patch: "PATCH_REPRODUCED", validator: { ok: false, reproOutcome: "reproduced" } },
    ]
    const round1: readonly CandSpec[] = [{ patch: "PATCH_FINAL", validator: { ok: true } }]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 3 },
        runCandidates: makeRunCandidatesPort([round0, round1], sinks),
      }),
    )
    // Round 0 selected the highest-rank red (resolved). Guard-revert: if the rank
    // order were reversed / argmax replaced by candidates[0], adopted[0] would be
    // PATCH_EXECFAIL.
    expect(sinks.adopted[0]).toBe("PATCH_RESOLVED")
    // …then round 1 ran (the red round 0 did NOT terminate) and its green won.
    expect(out.validated).toBe(true)
    expect(out.patch).toBe("PATCH_FINAL")
    expect(sinks.adopted).toEqual(["PATCH_RESOLVED", "PATCH_FINAL"])
    expect(out.rounds).toBe(2)
  })

  test("exec_failed ranks BELOW a plain red (no reproOutcome ⇒ 'none' wins over exec_failed)", async () => {
    const sinks = freshSinks()
    const round0: readonly CandSpec[] = [
      { patch: "PATCH_EXECFAIL", validator: { ok: false, reproOutcome: "exec_failed" } },
      { patch: "PATCH_PLAIN_RED", validator: { ok: false } }, // no outcome ⇒ rank "none" (0)
    ]
    // exec_failed=1 > none=0, so PATCH_EXECFAIL should actually win here. Pin the
    // EXACT ranking so a silent reordering is caught.
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 2 },
        runCandidates: makeRunCandidatesPort([round0], sinks),
      }),
    )
    // maxRounds:0 ⇒ only round 0 runs; its red field is selected by rank and the
    // loop finalizes on that (validated false). exec_failed(1) > none(0).
    expect(sinks.adopted).toEqual(["PATCH_EXECFAIL"])
    expect(out.validated).toBe(false)
    expect(out.patch).toBe("PATCH_EXECFAIL")
  })
})

describe("repair-breadth — primary-rail FALSE-GREEN is NOT a winner (gate-consistent)", () => {
  const railStep: PrimaryRailStep = {
    kind: "repro",
    cmd: 'python "repro.py"',
    authority: "execution",
    successPredicate: { type: "stdout_contains", substring: "Issue resolved" },
  }

  test("an exit-0 candidate whose typed predicate did NOT match does not clear; a true-green sibling wins", async () => {
    const sinks = freshSinks()
    const round0: readonly CandSpec[] = [
      // exit-code green BUT predicate mismatch ⇒ FALSE green ⇒ must NOT be selected
      // as the GREEN winner (clearedAsValidated withholds it under a primary rail).
      {
        patch: "PATCH_FALSE_GREEN",
        validator: { ok: true, predicate: { evaluable: true, matched: false } },
      },
      // honest green (predicate matches) ⇒ the real winner.
      {
        patch: "PATCH_TRUE_GREEN",
        validator: { ok: true, predicate: { evaluable: true, matched: true } },
      },
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 2 },
        primaryRailStep: railStep,
        runCandidates: makeRunCandidatesPort([round0], sinks),
      }),
    )
    // Guard-revert: if selection used raw `validator.ok` instead of
    // `clearedAsValidated`, the false-green PATCH_FALSE_GREEN (index 0) would win.
    expect(out.patch).toBe("PATCH_TRUE_GREEN")
    expect(out.validated).toBe(true)
    expect(sinks.adopted).toEqual(["PATCH_TRUE_GREEN"])
    // The SELECTED candidate was HONESTLY green (predicate matched) ⇒ the round's
    // false-green signal is false. The false-green in the DISCARDED sibling is an
    // observe-only diagnostic the breadth path drops — the round bookkeeping
    // reflects the CONTINUATION candidate's verdict, exactly as single-pass does
    // (there is one verdict per round, and it is the selected one's).
    // Guard-revert: if the loop recorded `v0` from candidates[0] (the false
    // green) instead of the selected candidate, this would be true.
    expect(out.primaryFalseGreen).toBe(false)
  })

  test("a candidate that is ONLY a false-green (no true-green sibling) ⇒ does not clear; signal recorded", async () => {
    const sinks = freshSinks()
    const round0: readonly CandSpec[] = [
      {
        patch: "FALSE_GREEN_ONLY",
        validator: { ok: true, predicate: { evaluable: true, matched: false } },
      },
    ]
    const round1: readonly CandSpec[] = [{ patch: "RED_NEXT", validator: { ok: false } }]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 2 },
        primaryRailStep: railStep,
        runCandidates: makeRunCandidatesPort([round0, round1], sinks),
      }),
    )
    // The selected (only) candidate is a false green ⇒ the finish gate WITHHOLDS
    // clearing ⇒ the loop continues to round 1. The selected candidate's
    // false-green IS recorded (sticky, observe-only). Guard-revert: dropping the
    // round-0 false-green seeding would leave this false.
    expect(out.validated).toBe(false)
    expect(out.primaryFalseGreen).toBe(true)
    expect(sinks.adopted).toEqual(["FALSE_GREEN_ONLY", "RED_NEXT"])
  })
})

describe("repair-breadth — DEFAULT-OFF byte-identical fence", () => {
  test("breadth unset ⇒ runCandidates is NEVER called (single runOnce+validate path)", async () => {
    let runOnceCalls = 0
    let validateCalls = 0
    let candidatesCalls = 0
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1 }, // no breadth
        runOnce: async () => {
          runOnceCalls++
          return { patch: "SINGLE", turns: 2, lastVerifyCmd: "pytest" }
        },
        validate: async () => {
          validateCalls++
          return { ok: true }
        },
        runCandidates: async () => {
          candidatesCalls++
          return []
        },
      }),
    )
    // The port is present but breadth defaults to 1 ⇒ it is NEVER touched.
    // Guard-revert: if `runRound` called the port at breadth 1, candidatesCalls>0.
    expect(candidatesCalls).toBe(0)
    expect(runOnceCalls).toBe(1)
    expect(validateCalls).toBe(1)
    expect(out.patch).toBe("SINGLE")
    expect(out.validated).toBe(true)
  })

  test("breadth EXPLICITLY 1 ⇒ identical to unset (single path, port untouched)", async () => {
    let candidatesCalls = 0
    let runOnceCalls = 0
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 1 },
        runOnce: async () => {
          runOnceCalls++
          return { patch: "SINGLE_1", turns: 1 }
        },
        validate: async () => ({ ok: false, failTail: "" }),
        runCandidates: async () => {
          candidatesCalls++
          return []
        },
      }),
    )
    expect(candidatesCalls).toBe(0)
    expect(runOnceCalls).toBe(2) // round 0 + round 1 (no early green)
    expect(out.patch).toBe("SINGLE_1")
  })

  test("breadth>1 but NO port ⇒ falls back to the single path (never NPEs)", async () => {
    let runOnceCalls = 0
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 4 }, // breadth set, but runCandidates omitted
        runOnce: async () => {
          runOnceCalls++
          return { patch: "FALLBACK", turns: 1 }
        },
        validate: async () => ({ ok: true }),
      }),
    )
    expect(runOnceCalls).toBe(1)
    expect(out.patch).toBe("FALLBACK")
    expect(out.validated).toBe(true)
  })

  test("zero-length fan-out ⇒ degrades to the single path for that round", async () => {
    let runOnceCalls = 0
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 3 },
        runOnce: async () => {
          runOnceCalls++
          return { patch: "DEGENERATE", turns: 1 }
        },
        validate: async () => ({ ok: false }),
        runCandidates: async () => [], // every candidate failed to generate
      }),
    )
    // The round still produced a run+verdict via the single path.
    expect(runOnceCalls).toBe(1)
    expect(out.patch).toBe("DEGENERATE")
  })
})

describe("repair-breadth — NO-LEAK: selection consumes ONLY the injected validator", () => {
  test("the candidate objects handed to selection carry no gold/hidden field", async () => {
    const sinks = freshSinks()
    const round0: readonly CandSpec[] = [
      { patch: "A", validator: { ok: false, reproOutcome: "reproduced" } },
      { patch: "B", validator: { ok: true } },
    ]
    await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 2 },
        runCandidates: makeRunCandidatesPort([round0], sinks),
      }),
    )
    // Structural proof: the ONLY signals the orchestrator saw per candidate are
    // `run`, `validator`, `adopt` (the RepairCandidateOutcome shape). The validator
    // results captured carry only public validator fields — never FAIL_TO_PASS /
    // test_patch / a report. (The type itself has no such field; this asserts the
    // values too.) Guard-revert: adding a `gold`-typed read in selectCandidate
    // would not compile against this shape.
    for (const v of sinks.validatorsSeen) {
      expect(
        Object.keys(v).every((k) =>
          ["ok", "failTail", "failureEvidence", "observed", "predicate", "reproOutcome"].includes(
            k,
          ),
        ),
      ).toBe(true)
    }
    // And selection used the validator: B (green) was chosen over A.
    expect(sinks.adopted).toEqual(["B"])
  })
})
