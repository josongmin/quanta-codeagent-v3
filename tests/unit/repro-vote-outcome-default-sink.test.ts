import { beforeEach, describe, expect, it } from "bun:test"
import type { ReproExecPort, ReproWriteFilePort } from "@/agent/repro-test/execute"
import {
  drainReproVoteOutcomes,
  makeReproVoteValidate,
  resetReproVoteOutcomes,
} from "@/runner/batch/eval/repair/repro-vote"
import type { ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * A5 — repro-vote outcome telemetry must be recorded BY DEFAULT (live by
 * construction), not only when the caller threads an optional
 * `recordReproVoteOutcome` arg. The driver's `buildReproVoteValidate` calls
 * `makeReproVoteValidate` WITHOUT a recorder, so the only way the A/B campaign
 * can observe the vote lever is a default sink the validator records into
 * unconditionally. These tests run the validator with NO injected recorder and
 * assert the outcome + tally still land in the drainable module sink — exactly
 * the production call shape.
 *
 * RED-WITHOUT-FIX: before the fix `drainReproVoteOutcomes` /
 * `resetReproVoteOutcomes` do not exist (import fails) and the default sink is
 * never written — every assertion below is unsatisfiable.
 */

const noWrite: ReproWriteFilePort = async () => {}

/** Exec port that maps each script (in WRITE order) → a canned stdout, so the
 *  test can drive the vote into each verdict deterministically. */
const makeExec = (
  stdoutByIndex: readonly string[],
): { exec: ReproExecPort; writeFile: ReproWriteFilePort } => {
  const pathToIdx = new Map<string, number>()
  let n = 0
  const writeFile: ReproWriteFilePort = async (path) => {
    pathToIdx.set(path, n)
    n += 1
  }
  const exec: ReproExecPort = async (argv) => {
    const path = argv[argv.length - 1] as string
    const idx = pathToIdx.get(path) ?? 0
    return { code: 0, stdout: stdoutByIndex[idx] ?? "", stderr: "" }
  }
  return { exec, writeFile }
}

const baseArgs = (): ValidateArgs => ({
  sandbox: "/sbx",
  exec: async () => ({ code: 1, stdout: "LEGACY", stderr: "" }),
  timeoutMs: 1000,
})

const LOUD_FALLBACK = async (): Promise<ValidatorResult> => ({
  ok: false,
  failTail: "FALLBACK_RAN",
})

describe("makeReproVoteValidate — DEFAULT outcome sink (no injected recorder)", () => {
  beforeEach(() => {
    resetReproVoteOutcomes()
  })

  it("records 'vote_resolved' + the tally with NO injected recorder", async () => {
    const { exec, writeFile } = makeExec([
      "Issue resolved",
      "Issue resolved",
      "Issue resolved",
      "Issue reproduced",
    ])
    // PRODUCTION SHAPE: deps WITHOUT recordReproVoteOutcome (what the driver passes).
    const result = await makeReproVoteValidate({
      sources: ["a", "b", "c", "d"],
      exec,
      writeFile,
      fallback: LOUD_FALLBACK,
    })(baseArgs())

    expect(result).toEqual({ ok: true })
    const drained = drainReproVoteOutcomes()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.outcome).toBe("vote_resolved")
    // The TALLY (not merely "something recorded").
    expect(drained[0]?.detail).toEqual({ resolved: 3, reproduced: 1, inconclusive: 0 })
  })

  it("records 'vote_unresolved' + the tally with NO injected recorder", async () => {
    const { exec, writeFile } = makeExec([
      "boom\nIssue reproduced",
      "Issue reproduced",
      "Issue resolved",
    ])
    const result = await makeReproVoteValidate({
      sources: ["a", "b", "c"],
      exec,
      writeFile,
      fallback: LOUD_FALLBACK,
    })(baseArgs())

    expect(result.ok).toBe(false)
    const drained = drainReproVoteOutcomes()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.outcome).toBe("vote_unresolved")
    expect(drained[0]?.detail).toEqual({ resolved: 1, reproduced: 2, inconclusive: 0 })
  })

  it("records 'vote_inconclusive' + the tally with NO injected recorder", async () => {
    const { exec, writeFile } = makeExec(["Issue resolved", "Issue reproduced"])
    const result = await makeReproVoteValidate({
      sources: ["a", "b"],
      exec,
      writeFile,
      fallback: LOUD_FALLBACK,
    })(baseArgs())

    expect(result).toEqual({ ok: false, failTail: "FALLBACK_RAN" })
    const drained = drainReproVoteOutcomes()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.outcome).toBe("vote_inconclusive")
    expect(drained[0]?.detail).toEqual({ resolved: 1, reproduced: 1, inconclusive: 0 })
  })

  it("records 'empty_sources' (no tally) with NO injected recorder", async () => {
    const result = await makeReproVoteValidate({
      sources: [],
      exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })(baseArgs())

    expect(result).toEqual({ ok: false, failTail: "FALLBACK_RAN" })
    const drained = drainReproVoteOutcomes()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.outcome).toBe("empty_sources")
    expect(drained[0]?.detail).toBeUndefined()
  })

  it("records 'exec_failed' (no tally) with NO injected recorder when executeReproTests rejects", async () => {
    let lengthReads = 0
    const explodingSources = new Proxy(["a"] as readonly string[], {
      get(target, prop, recv) {
        if (prop === "length") {
          lengthReads += 1
          return target.length
        }
        if (prop === "0" && lengthReads > 1) throw new Error("tests[i] exploded")
        return Reflect.get(target, prop, recv)
      },
    })
    const result = await makeReproVoteValidate({
      sources: explodingSources,
      exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })(baseArgs())

    expect(result).toEqual({ ok: false, failTail: "FALLBACK_RAN" })
    const drained = drainReproVoteOutcomes()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.outcome).toBe("exec_failed")
    expect(drained[0]?.detail).toBeUndefined()
  })

  it("VOTE-DECIDED visibility: the confound is observable — an analyst can SEE that the round was vote-decided vs fallback-deferred", async () => {
    // Two runs: one decided by the vote (vote_resolved), one deferred to the
    // legacy gate (empty_sources). The sink must distinguish them so the
    // documented primary_false_red_rate confound (vote-decided rounds suppress
    // that signal) is VISIBLE rather than conflated.
    const decided = makeExec(["Issue resolved", "Issue resolved"])
    await makeReproVoteValidate({
      sources: ["a", "b"],
      exec: decided.exec,
      writeFile: decided.writeFile,
      fallback: LOUD_FALLBACK,
    })(baseArgs())
    await makeReproVoteValidate({
      sources: [],
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })(baseArgs())

    const drained = drainReproVoteOutcomes()
    expect(drained.map((e) => e.outcome)).toEqual(["vote_resolved", "empty_sources"])
    const voteDecided = new Set(["vote_resolved", "vote_unresolved", "vote_inconclusive"])
    const decidedCount = drained.filter((e) => voteDecided.has(e.outcome)).length
    const deferredCount = drained.length - decidedCount
    expect(decidedCount).toBe(1)
    expect(deferredCount).toBe(1)
  })

  it("drain is consuming: a second drain returns empty (each campaign read is exclusive)", async () => {
    const { exec, writeFile } = makeExec(["Issue resolved", "Issue resolved"])
    await makeReproVoteValidate({ sources: ["a", "b"], exec, writeFile, fallback: LOUD_FALLBACK })(
      baseArgs(),
    )
    expect(drainReproVoteOutcomes()).toHaveLength(1)
    expect(drainReproVoteOutcomes()).toHaveLength(0)
  })

  it("FAN-OUT: an injected recorder STILL fires AND the default sink ALSO records (no override)", async () => {
    const injected: string[] = []
    const { exec, writeFile } = makeExec(["Issue resolved", "Issue resolved"])
    await makeReproVoteValidate({
      sources: ["a", "b"],
      exec,
      writeFile,
      fallback: LOUD_FALLBACK,
      recordReproVoteOutcome: (outcome) => injected.push(outcome),
    })(baseArgs())

    expect(injected).toEqual(["vote_resolved"])
    const drained = drainReproVoteOutcomes()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.outcome).toBe("vote_resolved")
  })
})
