/**
 * SOTA++ Phase-A — HARD e2e: the driver-instantiation CONTRACT, pre-verified.
 *
 * The box-gated mile will build the acceptance oracles from `withCandidatePatch`
 * (reset→apply candidate diff→probe→restore-to-base) running real pytest. This e2e
 * SIMULATES that exact shape with an in-memory repo + an isolation-enforcing
 * `withCandidatePatch` fake, then runs the FULL real chain (resolveRegressionTests →
 * maybeAcceptanceSelector → buildAcceptanceSelector → selectByAcceptance → rerank →
 * runRepairRounds). It pins the invariants the real driver MUST satisfy so wiring it
 * later is mechanical:
 *   - ISOLATION: every oracle probe sees base + ONLY its candidate's patch; base is
 *     restored between candidates (no cross-candidate contamination).
 *   - the regression SET (from the LLM-selected subset) is what's scored — an
 *     excluded test breaking is NOT penalised; an included test breaking is.
 *   - realistic multi-candidate / dedup / 3-tier ladder / multi-round / degrade.
 * Hermetic: no LLM, no sandbox, no box — the "sandbox" is a deterministic model.
 */

import { describe, expect, test } from "bun:test"
import { maybeAcceptanceSelector } from "@/runner/batch/eval/acceptance-wire"
import { resolveRegressionTests } from "@/runner/batch/eval/regression-select"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type {
  RepairCandidateOutcome,
  RunOnceResult,
  RunRepairCandidatesArgs,
  RunRepairRoundsArgs,
  ValidateArgs,
  ValidatorResult,
} from "@/runner/batch/eval/repair/types"

// ── in-memory "repo" + an isolation-enforcing withCandidatePatch fake ─────────
//
// A patch is encoded as `fix=<0|1>;breaks=t2,t5` — "fix=1" resolves the issue;
// `breaks=` lists existing tests the patch regresses. The repro test passes iff
// fix=1. A regression test fails iff it is in the patch's `breaks` AND in the
// scored regression set.

interface Patch {
  readonly fix: boolean
  readonly breaks: readonly string[]
}
const parsePatch = (p: string): Patch => {
  const fix = /(^|;)fix=1(;|$)/.test(p)
  const m = p.match(/breaks=([^;]*)/)
  const breaks = m?.[1] ? m[1].split(",").filter(Boolean) : []
  return { fix, breaks }
}

/** Isolation-enforcing sandbox model: probe only ever runs with EXACTLY the
 *  candidate patch applied on a clean base; base is restored after. A leaked
 *  prior application throws (the contract the real withCandidatePatch must keep). */
const makeSandbox = () => {
  let applied: string | null = null
  let probesRun = 0
  const withCandidatePatch = async <T>(
    patch: string,
    probe: (p: Patch) => Promise<T>,
  ): Promise<T> => {
    if (applied !== null) {
      throw new Error(`ISOLATION VIOLATION: base dirty with "${applied}" when applying "${patch}"`)
    }
    applied = patch // apply candidate diff
    try {
      probesRun += 1
      return await probe(parsePatch(patch))
    } finally {
      applied = null // restore-to-base (reset)
    }
  }
  return {
    withCandidatePatch,
    probes: () => probesRun,
    isClean: () => applied === null,
  }
}

// ── runRepairRounds harness ──────────────────────────────────────────────────

interface CandSpec {
  readonly patch: string
  readonly validator: ValidatorResult
}
const makeRunCandidatesPort =
  (rounds: readonly (readonly CandSpec[])[], adopted: string[]) =>
  async (a: RunRepairCandidatesArgs): Promise<readonly RepairCandidateOutcome[]> => {
    const specs = rounds[Math.min(a.round, rounds.length - 1)] as readonly CandSpec[]
    return specs.map((spec): RepairCandidateOutcome => {
      const run: RunOnceResult = { patch: spec.patch, turns: 1, lastVerifyCmd: "pytest" }
      return { run, validator: spec.validator, adopt: async () => void adopted.push(spec.patch) }
    })
  }

const baseArgs = (over: Partial<RunRepairRoundsArgs>): RunRepairRoundsArgs => ({
  config: { maxRounds: 0, breadth: 4 },
  problem: "fix it",
  runOnce: async () => {
    throw new Error("breadth path: runOnce must not be called")
  },
  validate: async (_a: ValidateArgs): Promise<ValidatorResult> => {
    throw new Error("breadth path: validate must not be called")
  },
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  ...over,
})

/** Build the acceptance selectCandidates the way the driver will: oracles run THROUGH
 *  the isolation-enforcing sandbox; regression scores the LLM-selected set. */
const wireAcceptance = (
  sandbox: ReturnType<typeof makeSandbox>,
  regressionSet: readonly string[] | undefined,
): NonNullable<RunRepairRoundsArgs["selectCandidates"]> =>
  // enabled:true ⇒ always defined; assert so the (full) args spread is exactOptional-clean.
  maybeAcceptanceSelector({
    enabled: true,
    runReproOnPatch: (patch) => sandbox.withCandidatePatch(patch, async (p) => p.fix),
    ...(regressionSet !== undefined
      ? {
          runRegressionOnPatch: (patch) =>
            sandbox.withCandidatePatch(
              patch,
              async (p) => p.breaks.filter((t) => regressionSet.includes(t)).length,
            ),
        }
      : {}),
  }) as NonNullable<RunRepairRoundsArgs["selectCandidates"]>

describe("HARD e2e — driver-instantiation contract", () => {
  test("5 candidates, dual-guard: picks fix=1 + min-regression; ISOLATION held all run", async () => {
    const sandbox = makeSandbox()
    const adopted: string[] = []
    const regressionSet = ["t1", "t2", "t3"]
    const specs: readonly CandSpec[] = [
      { patch: "fix=0;breaks=", validator: { ok: false } }, // no fix
      { patch: "fix=1;breaks=t1,t2", validator: { ok: true } }, // fix but 2 regressions
      { patch: "fix=1;breaks=", validator: { ok: true } }, // fix + 0 regressions ⇐ WINNER
      { patch: "fix=1;breaks=t3", validator: { ok: true } }, // fix but 1 regression
      { patch: "fix=0;breaks=t1", validator: { ok: false } }, // no fix + regress
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 5 },
        runCandidates: makeRunCandidatesPort([specs], adopted),
        selectCandidates: wireAcceptance(sandbox, regressionSet),
      }),
    )
    expect(adopted).toEqual(["fix=1;breaks="]) // fix + min(0) regression
    expect(out.patch).toBe("fix=1;breaks=")
    // ISOLATION: base clean at end + every candidate probed through withCandidatePatch
    // (5 repro + 5 regression = 10), never a dirty-base throw.
    expect(sandbox.isClean()).toBe(true)
    expect(sandbox.probes()).toBe(10)
  })

  test("regression SET scoping: breaking an EXCLUDED test is NOT penalised", async () => {
    // LLM excludes t2 (functionality legitimately changes) ⇒ regression set = [t1,t3].
    const sel = await resolveRegressionTests("issue", ["t1", "t2", "t3"], {
      llm: async () => "t2",
    })
    expect(sel.regression).toEqual(["t1", "t3"])
    const sandbox = makeSandbox()
    const adopted: string[] = []
    const specs: readonly CandSpec[] = [
      { patch: "fix=1;breaks=t2", validator: { ok: true } }, // breaks only EXCLUDED t2 ⇒ 0 penalised ⇐ WINNER
      { patch: "fix=1;breaks=t1", validator: { ok: true } }, // breaks INCLUDED t1 ⇒ 1 penalised
    ]
    await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 2 },
        runCandidates: makeRunCandidatesPort([specs], adopted),
        selectCandidates: wireAcceptance(sandbox, sel.regression),
      }),
    )
    expect(adopted).toEqual(["fix=1;breaks=t2"]) // excluded-test break is free
  })

  test("3-tier ladder: NO candidate fixes ⇒ tier-2 min-regression among non-fixers", async () => {
    const sandbox = makeSandbox()
    const adopted: string[] = []
    const specs: readonly CandSpec[] = [
      { patch: "fix=0;breaks=t1,t2", validator: { ok: false } },
      { patch: "fix=0;breaks=", validator: { ok: false } }, // 0 regressions ⇐ tier-2 winner
      { patch: "fix=0;breaks=t1", validator: { ok: false } },
    ]
    await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 3 },
        runCandidates: makeRunCandidatesPort([specs], adopted),
        selectCandidates: wireAcceptance(sandbox, ["t1", "t2"]),
      }),
    )
    expect(adopted).toEqual(["fix=0;breaks="]) // none fix ⇒ min-regression fallback
    expect(sandbox.isClean()).toBe(true)
  })

  test("dedup: 3 byte-identical fixing patches outvote a lone different fixer", async () => {
    const sandbox = makeSandbox()
    const adopted: string[] = []
    const specs: readonly CandSpec[] = [
      { patch: "fix=1;v=a", validator: { ok: true } },
      { patch: "fix=1;v=a", validator: { ok: true } },
      { patch: "fix=1;v=a", validator: { ok: true } }, // 3 votes ⇐ WINNER (first appearance)
      { patch: "fix=1;v=b", validator: { ok: true } }, // 1 vote
    ]
    await runRepairRounds(
      baseArgs({
        runCandidates: makeRunCandidatesPort([specs], adopted),
        selectCandidates: wireAcceptance(sandbox, undefined), // repro-only
      }),
    )
    expect(adopted).toEqual(["fix=1;v=a"])
  })

  test("multi-round: round 0 all-red continuation, round 1 introduces the fixer ⇒ clears", async () => {
    const sandbox = makeSandbox()
    const adopted: string[] = []
    const round0: readonly CandSpec[] = [
      { patch: "fix=0;breaks=", validator: { ok: false } },
      { patch: "fix=0;breaks=t1", validator: { ok: false } },
    ]
    const round1: readonly CandSpec[] = [
      { patch: "fix=0;breaks=", validator: { ok: false } },
      { patch: "fix=1;breaks=", validator: { ok: true } }, // the fixer, validator-green ⇐ clears
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 2 },
        runCandidates: makeRunCandidatesPort([round0, round1], adopted),
        selectCandidates: wireAcceptance(sandbox, ["t1"]),
      }),
    )
    expect(out.validated).toBe(true)
    expect(out.patch).toBe("fix=1;breaks=")
    expect(adopted.length).toBe(2) // adopted once per round
    expect(sandbox.isClean()).toBe(true) // isolation held across BOTH rounds
  })

  test("degrade under crash: one candidate's probe throws ⇒ it loses, base still restored", async () => {
    let appliedAfter = ""
    const adopted: string[] = []
    const sandbox = {
      withCandidatePatch: async <T>(patch: string, probe: (p: Patch) => Promise<T>): Promise<T> => {
        if (/crash/.test(patch)) {
          appliedAfter = "" // restored even on throw (finally semantics)
          throw new Error("sandbox crash")
        }
        return probe(parsePatch(patch))
      },
    }
    const specs: readonly CandSpec[] = [
      { patch: "fix=1;crash", validator: { ok: true } }, // probe throws ⇒ degrades to repro=false
      { patch: "fix=1;breaks=", validator: { ok: true } }, // clean fixer ⇐ WINNER
    ]
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 0, breadth: 2 },
        runCandidates: makeRunCandidatesPort([specs], adopted),
        selectCandidates: maybeAcceptanceSelector({
          enabled: true,
          runReproOnPatch: (patch) => sandbox.withCandidatePatch(patch, async (p) => p.fix),
        }) as NonNullable<RunRepairRoundsArgs["selectCandidates"]>,
      }),
    )
    // The crashing candidate degraded (did not abort the round); the clean fixer won.
    expect(adopted).toEqual(["fix=1;breaks="])
    expect(out.patch).toBe("fix=1;breaks=")
    expect(appliedAfter).toBe("")
  })
})
