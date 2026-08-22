/**
 * jun-28 repair-loop BREADTH — DRIVER-side fan-out (`makeRepairBreadthRunCandidates`).
 *
 * The orchestrator selection tests mock the `runCandidates` port; THIS suite
 * proves the driver seam the port is built from: fork B sandboxes, run the agent
 * on each (routed to lane i), validate EACH against the SAME repair-gate policy
 * with the fork's OWN sandbox, hand back outcomes, and (for the adopted one)
 * re-materialize it onto the main sandbox (reset-to-base + git apply). All ports
 * are fakes — no real fork / agent / git.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort } from "@/llm"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"
import {
  makeRepairBreadthRunCandidates,
  type RepairBreadthDeps,
} from "@/runner/batch/eval/repair-breadth"

// `model` doubles as the lane's identity tag: the driver now WRAPS each lane
// port (laneLabeledPort for recording + laneProgressPort for live progress),
// so the exact object no longer reaches runAgentOnFork — but the wrappers
// delegate `model` verbatim, so routing is still checkable via `.model`.
const fakeLane = (tag: string): LLMPort => ({ tag, model: tag }) as unknown as LLMPort

interface Recorder {
  forks: string[]
  cleaned: string[]
  agentCalls: { fork: string; seed: string | undefined; lane: LLMPort }[]
  validateCalls: ValidateArgs[]
  resets: { sandbox: string; base: string }[]
  applies: { sandbox: string; patch: string }[]
  buildEnvs: { sandbox: string; repo: string }[]
}

const freshRecorder = (): Recorder => ({
  forks: [],
  cleaned: [],
  agentCalls: [],
  validateCalls: [],
  resets: [],
  applies: [],
  buildEnvs: [],
})

/** Build deps where fork i ⇒ a deterministic path, the agent yields patch
 *  `PATCH_<i>` from a per-index map, and validation echoes a per-index verdict. */
const makeDeps = (
  rec: Recorder,
  opts: {
    patches: readonly string[]
    verdicts: readonly ValidatorResult[]
    baseCommit?: string | undefined
    repo?: string | undefined
    lanes?: readonly LLMPort[]
    runAgentOnFork?: RepairBreadthDeps["runAgentOnFork"]
  },
): RepairBreadthDeps => {
  let forkSeq = 0
  return {
    instanceId: "inst-1",
    mainSandbox: "/main",
    baseCommit: "baseCommit" in opts ? opts.baseCommit : "BASE",
    repo: "repo" in opts ? opts.repo : undefined,
    timeoutMs: 1000,
    resolveLaneLlm: (index) => opts.lanes?.[index] ?? fakeLane(`lane-${index}`),
    runAgentOnFork:
      opts.runAgentOnFork ??
      (async (fork, seed, lane): Promise<RunOnceResult> => {
        // Recover the candidate index from the fork path suffix.
        const idx = Number(fork.split("#")[1])
        rec.agentCalls.push({ fork, seed, lane })
        return { patch: opts.patches[idx] as string, turns: 1, lastVerifyCmd: "pytest" }
      }),
    validate: async (args: ValidateArgs): Promise<ValidatorResult> => {
      rec.validateCalls.push(args)
      const idx = Number(args.sandbox.split("#")[1])
      return opts.verdicts[idx] as ValidatorResult
    },
    validateInputs: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), timeoutMs: 1000 },
    sandboxPorts: {
      forkSandbox: async (_id, _src) => {
        const path = `/fork#${forkSeq++}`
        rec.forks.push(path)
        return path
      },
      cleanupSandbox: async (sandbox) => {
        rec.cleaned.push(sandbox)
      },
    },
    gitPorts: {
      resetToBase: async (sandbox, base, _t) => {
        rec.resets.push({ sandbox, base })
        return true
      },
      applyCandidatePatch: async (sandbox, patch, _t) => {
        rec.applies.push({ sandbox, patch })
        return true
      },
      materializeBuildEnv: async (sandbox, repo) => {
        rec.buildEnvs.push({ sandbox, repo })
        return true
      },
    },
  }
}

describe("repair-breadth fan-out — forks B sandboxes, runs+validates each", () => {
  test("B=3 ⇒ 3 forks, 3 agent runs (lane i), 3 validations on the FORK's sandbox, 3 cleanups", async () => {
    const rec = freshRecorder()
    const lanes = [fakeLane("L0"), fakeLane("L1"), fakeLane("L2")]
    const port = makeRepairBreadthRunCandidates(
      makeDeps(rec, {
        patches: ["P0", "P1", "P2"],
        verdicts: [{ ok: false }, { ok: true }, { ok: false }],
        lanes,
      }),
    )
    const outcomes = await port({ seedMsg: "seed-x", breadth: 3, round: 0 })

    expect(outcomes).toHaveLength(3)
    // 3 distinct forks. Guard-revert: a non-forking impl would create 0/1.
    expect(rec.forks).toHaveLength(3)
    // Each agent run got a port DERIVED from its lane (i mod laneCount) — the
    // driver wraps it for recording + progress, so we check the delegated
    // `.model` tag rather than object identity. Guard-revert: dropping the lane
    // arg would push `undefined` here (and `.model` would be undefined).
    const lanesByFork = new Map(rec.agentCalls.map((c) => [c.fork, c.lane]))
    expect(lanesByFork.get("/fork#0")?.model).toBe(lanes[0]?.model)
    expect(lanesByFork.get("/fork#1")?.model).toBe(lanes[1]?.model)
    expect(lanesByFork.get("/fork#2")?.model).toBe(lanes[2]?.model)
    // The seed propagated to every candidate.
    expect(rec.agentCalls.every((c) => c.seed === "seed-x")).toBe(true)
    // Validation ran against EACH FORK's own sandbox (not the main one). This is
    // the no-leak-relevant invariant: the oracle re-executes on the candidate's
    // tree. Guard-revert: validating `/main` would put "/main" here.
    expect(rec.validateCalls.map((v) => v.sandbox).sort()).toEqual([
      "/fork#0",
      "/fork#1",
      "/fork#2",
    ])
    // Every fork is cleaned up (loser AND would-be winner — adopt re-applies from
    // the captured diff, so the fork dir is disposable).
    expect(rec.cleaned.sort()).toEqual(["/fork#0", "/fork#1", "/fork#2"])
    // Outcomes carry the per-candidate run+validator.
    expect(outcomes.map((o) => o.run.patch).sort()).toEqual(["P0", "P1", "P2"])
  })

  test("validateInputs threads the primary-rail policy through to each fork", async () => {
    const rec = freshRecorder()
    const deps = makeDeps(rec, { patches: ["P0", "P1"], verdicts: [{ ok: false }, { ok: false }] })
    const railDeps: RepairBreadthDeps = {
      ...deps,
      validateInputs: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        timeoutMs: 1000,
        primaryRailStep: {
          kind: "repro",
          cmd: 'python "repro.py"',
          authority: "execution",
          successPredicate: { type: "stdout_contains", substring: "Issue resolved" },
        },
      },
    }
    await makeRepairBreadthRunCandidates(railDeps)({ seedMsg: undefined, breadth: 2, round: 1 })
    // Each validation used the PRIMARY-RAIL cmd (policy carried through
    // buildRepairValidateArgs), not the agent's lastVerifyCmd. Guard-revert:
    // ignoring validateInputs.primaryRailStep would set cmd to "pytest".
    expect(rec.validateCalls.every((v) => v.cmd === 'python "repro.py"')).toBe(true)
    expect(rec.validateCalls.every((v) => v.reproAuthority === true)).toBe(true)
  })
})

describe("repair-breadth fan-out — adopt() re-materializes the candidate onto MAIN", () => {
  test("adopt ⇒ reset main to base THEN git apply the candidate's cumulative diff", async () => {
    const rec = freshRecorder()
    const port = makeRepairBreadthRunCandidates(
      makeDeps(rec, {
        patches: ["DIFF_A", "DIFF_B"],
        verdicts: [{ ok: false }, { ok: true }],
        baseCommit: "BASE_SHA",
      }),
    )
    const outcomes = await port({ seedMsg: undefined, breadth: 2, round: 0 })
    // No git side-effects until adopt is called (generation must not mutate main).
    expect(rec.resets).toHaveLength(0)
    expect(rec.applies).toHaveLength(0)

    // Adopt candidate #1 (DIFF_B) — the green one a selector would pick.
    const winner = outcomes.find((o) => o.run.patch === "DIFF_B")
    expect(winner).toBeDefined()
    await winner?.adopt()

    // reset-to-base on MAIN, then apply the winner's cumulative diff to MAIN.
    // Guard-revert: dropping resetToBase (no continue-from-base) ⇒ resets empty;
    // dropping applyCandidatePatch ⇒ applies empty.
    expect(rec.resets).toEqual([{ sandbox: "/main", base: "BASE_SHA" }])
    expect(rec.applies).toEqual([{ sandbox: "/main", patch: "DIFF_B" }])
  })

  test("adopt re-materializes the build-env after reset+apply when a repo is set (next round can build)", async () => {
    const rec = freshRecorder()
    const port = makeRepairBreadthRunCandidates(
      makeDeps(rec, {
        patches: ["DIFF_A"],
        verdicts: [{ ok: true }],
        baseCommit: "BASE_SHA",
        repo: "astropy/astropy", // a build-time-import repo
      }),
    )
    const [only] = await port({ seedMsg: undefined, breadth: 1, round: 1 })
    await only?.adopt()
    // The leading reset wiped the build-env block ⇒ adopt re-injects it on MAIN so
    // the NEXT round's fork can build. Guard-revert: dropping the materialize call
    // leaves buildEnvs empty and astropy's round-2 forks fail to build.
    expect(rec.buildEnvs).toEqual([{ sandbox: "/main", repo: "astropy/astropy" }])
  })

  test("adopt does NOT materialize build-env when repo is unset (no build-time import)", async () => {
    const rec = freshRecorder()
    const port = makeRepairBreadthRunCandidates(
      makeDeps(rec, {
        patches: ["DIFF_A"],
        verdicts: [{ ok: true }],
        baseCommit: "BASE_SHA",
        repo: undefined,
      }),
    )
    const [only] = await port({ seedMsg: undefined, breadth: 1, round: 0 })
    await only?.adopt()
    expect(rec.buildEnvs).toHaveLength(0)
  })

  test("empty winner diff ⇒ reset main to base, but NO apply (continuation point is base)", async () => {
    const rec = freshRecorder()
    const port = makeRepairBreadthRunCandidates(
      makeDeps(rec, { patches: [""], verdicts: [{ ok: false }], baseCommit: "BASE_SHA" }),
    )
    // breadth 1 here exercises the helper directly (the orchestrator never calls
    // the port at breadth 1; this isolates the empty-diff adopt path).
    const [only] = await port({ seedMsg: undefined, breadth: 1, round: 0 })
    await only?.adopt()
    expect(rec.resets).toEqual([{ sandbox: "/main", base: "BASE_SHA" }])
    // The empty diff is NOT applied (git apply of "" is a no-op we skip).
    expect(rec.applies).toHaveLength(0)
  })

  test("missing baseCommit ⇒ adopt applies onto live main WITHOUT a reset (defensive)", async () => {
    const rec = freshRecorder()
    const port = makeRepairBreadthRunCandidates(
      makeDeps(rec, { patches: ["DIFF_X"], verdicts: [{ ok: true }], baseCommit: undefined }),
    )
    const [only] = await port({ seedMsg: undefined, breadth: 1, round: 0 })
    await only?.adopt()
    // No reset (no base to reset to); the diff is still applied best-effort.
    expect(rec.resets).toHaveLength(0)
    expect(rec.applies).toEqual([{ sandbox: "/main", patch: "DIFF_X" }])
  })
})

describe("repair-breadth fan-out — #7 location-set perCandidateSeed seam", () => {
  test("perCandidateSeed (when set) gives each candidate a DISTINCT seed; absent ⇒ shared base", async () => {
    const rec = freshRecorder()
    const deps: RepairBreadthDeps = {
      ...makeDeps(rec, {
        patches: ["P0", "P1", "P2"],
        verdicts: [{ ok: false }, { ok: false }, { ok: false }],
      }),
      // Inject a seeder mirroring buildLocationSeeder's shape (index-distinct).
      perCandidateSeed: (index, base) => `${base ?? ""}::lead-${index}`,
    }
    await makeRepairBreadthRunCandidates(deps)({ seedMsg: "BASE", breadth: 3, round: 1 })
    const seeds = rec.agentCalls.map((c) => c.seed).sort()
    // Each candidate got a DISTINCT, index-derived seed. Guard-revert: a seam that
    // ignored perCandidateSeed would push "BASE" three times here.
    expect(seeds).toEqual(["BASE::lead-0", "BASE::lead-1", "BASE::lead-2"])
  })

  test("typed location focus rides with the candidate outcome (no prompt reparsing)", async () => {
    const rec = freshRecorder()
    const seed = ((index: number, base: string | undefined) =>
      `${base ?? ""}::lead-${index}`) as NonNullable<RepairBreadthDeps["perCandidateSeed"]>
    seed.focusOf = (index) => ({
      leadFile: `f${index}.py`,
      relatedFiles: index === 0 ? ["shared.py"] : [],
      ...(index === 1 ? { leadSymbol: "render", otherSymbols: ["parse"] } : {}),
    })
    const deps: RepairBreadthDeps = {
      ...makeDeps(rec, { patches: ["P0", "P1"], verdicts: [{ ok: false }, { ok: false }] }),
      perCandidateSeed: seed,
    }
    const outcomes = await makeRepairBreadthRunCandidates(deps)({
      seedMsg: "BASE",
      breadth: 2,
      round: 0,
    })
    expect(outcomes[0]?.locationFocus).toEqual({
      leadFile: "f0.py",
      relatedFiles: ["shared.py"],
    })
    expect(outcomes[1]?.locationFocus).toEqual({
      leadFile: "f1.py",
      relatedFiles: [],
      leadSymbol: "render",
      otherSymbols: ["parse"],
    })
  })

  test("perCandidateSeed returning undefined for an index ⇒ that candidate falls back to base (byte-identical)", async () => {
    const rec = freshRecorder()
    const deps: RepairBreadthDeps = {
      ...makeDeps(rec, { patches: ["P0", "P1"], verdicts: [{ ok: false }, { ok: false }] }),
      perCandidateSeed: (index, base) => (index === 0 ? `${base}::lead-0` : undefined),
    }
    await makeRepairBreadthRunCandidates(deps)({ seedMsg: "BASE", breadth: 2, round: 1 })
    const byFork = new Map(rec.agentCalls.map((c) => [c.fork, c.seed]))
    expect(byFork.get("/fork#0")).toBe("BASE::lead-0")
    expect(byFork.get("/fork#1")).toBe("BASE") // undefined ⇒ base seed
  })
})

describe("repair-breadth fan-out — structural family coverage widening", () => {
  const BASE_PATCH = [
    "diff --git a/pkg/base.py b/pkg/base.py",
    "--- a/pkg/base.py",
    "+++ b/pkg/base.py",
    "@@",
    "-old",
    "+new",
  ].join("\n")

  const COEDITED_PATCH = [
    "diff --git a/pkg/base.py b/pkg/base.py",
    "--- a/pkg/base.py",
    "+++ b/pkg/base.py",
    "@@",
    "-old",
    "+new",
    "diff --git a/pkg/pg.py b/pkg/pg.py",
    "--- a/pkg/pg.py",
    "+++ b/pkg/pg.py",
    "@@",
    "-old",
    "+new",
  ].join("\n")

  test("bounded family co-edit widens a partial breadth candidate before adopt", async () => {
    const rec = freshRecorder()
    const deps: RepairBreadthDeps = {
      ...makeDeps(rec, { patches: [BASE_PATCH], verdicts: [{ ok: true }] }),
      deriveCandidateStructuralRepair: async (candidate, sandbox) => {
        expect(sandbox).toBe("/fork#0")
        expect(candidate.files).toEqual(["pkg/base.py"])
        return {
          family: {
            familyId: "override-family",
            ownerFiles: ["pkg/base.py", "pkg/pg.py"],
            reason: "same symbol across backends",
            seed: undefined,
            sourceEvidence: ["static-witness:ast"],
          },
        }
      },
      repairFamilyCoverage: async ({ candidate, family, missingFiles, sandbox }) => {
        expect(sandbox).toBe("/fork#0")
        expect(candidate.patch).toBe(BASE_PATCH)
        expect(family.ownerFiles).toEqual(["pkg/base.py", "pkg/pg.py"])
        expect(missingFiles).toEqual(["pkg/pg.py"])
        return {
          ...candidate,
          patch: COEDITED_PATCH,
          files: ["pkg/base.py", "pkg/pg.py"],
        }
      },
    }

    const [only] = await makeRepairBreadthRunCandidates(deps)({
      seedMsg: undefined,
      breadth: 1,
      round: 0,
    })
    expect(only?.run.patch).toBe(COEDITED_PATCH)

    await only?.adopt()
    expect(rec.applies).toEqual([{ sandbox: "/main", patch: COEDITED_PATCH }])
  })

  test("non-improving family co-edit is ignored and the original patch is kept", async () => {
    const rec = freshRecorder()
    const deps: RepairBreadthDeps = {
      ...makeDeps(rec, { patches: [BASE_PATCH], verdicts: [{ ok: true }] }),
      deriveCandidateStructuralRepair: async () => ({
        family: {
          familyId: "override-family",
          ownerFiles: ["pkg/base.py", "pkg/pg.py"],
          reason: "same symbol across backends",
          seed: undefined,
          sourceEvidence: ["static-witness:ast"],
        },
      }),
      repairFamilyCoverage: async ({ candidate }) => candidate,
    }

    const [only] = await makeRepairBreadthRunCandidates(deps)({
      seedMsg: undefined,
      breadth: 1,
      round: 0,
    })
    expect(only?.run.patch).toBe(BASE_PATCH)
  })

  test("derived family metadata is surfaced even when no co-edit port is wired", async () => {
    const rec = freshRecorder()
    const deps: RepairBreadthDeps = {
      ...makeDeps(rec, {
        patches: [BASE_PATCH],
        verdicts: [{ ok: false, reproOutcome: "reproduced" }],
      }),
      deriveCandidateStructuralRepair: async () => ({
        family: {
          familyId: "producer-consumer",
          ownerFiles: ["pkg/base.py", "pkg/pg.py"],
          reason: "writer + reader",
          seed: undefined,
          sourceEvidence: ["static-witness:ast"],
        },
      }),
    }

    const [only] = await makeRepairBreadthRunCandidates(deps)({
      seedMsg: undefined,
      breadth: 1,
      round: 0,
    })
    expect(only?.familyId).toBe("producer-consumer")
    expect(only?.familyCoverageMissing).toEqual(["pkg/pg.py"])
    expect(only?.run.patch).toBe(BASE_PATCH)
  })
})

describe("repair-breadth fan-out — resilience", () => {
  test("a candidate whose agent THROWS is dropped; the others still return + its fork is cleaned", async () => {
    const rec = freshRecorder()
    const deps = makeDeps(rec, {
      patches: ["P0", "P1", "P2"],
      verdicts: [{ ok: false }, { ok: false }, { ok: false }],
      runAgentOnFork: async (fork, _seed, _lane): Promise<RunOnceResult> => {
        const idx = Number(fork.split("#")[1])
        if (idx === 1) throw new Error("lane 1 blew up")
        return { patch: `P${idx}`, turns: 1 }
      },
    })
    const outcomes = await makeRepairBreadthRunCandidates(deps)({
      seedMsg: undefined,
      breadth: 3,
      round: 0,
    })
    // The throwing candidate is dropped (2 of 3 returned). Guard-revert: not using
    // allSettled would reject the whole round.
    expect(outcomes).toHaveLength(2)
    expect(outcomes.map((o) => o.run.patch).sort()).toEqual(["P0", "P2"])
    // ALL THREE forks (incl. the failed one) were created and cleaned up — no leak.
    expect(rec.forks).toHaveLength(3)
    expect(rec.cleaned.sort()).toEqual(["/fork#0", "/fork#1", "/fork#2"])
  })
})
