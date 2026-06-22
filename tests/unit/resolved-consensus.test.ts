import { describe, expect, it } from "bun:test"
import type { ReproExecPort, ReproWriteFilePort } from "@/agent/repro-test/execute"
import type { ReproTestOutcome, ReproTestSample } from "@/agent/repro-test/types"
import { resolvedConsensus } from "@/agent/repro-test/vote"
import { makePatchedResolvedConsensus } from "@/runner/batch/eval/repair/resolved-consensus"

const sample = (outcome: ReproTestOutcome): ReproTestSample =>
  ({ outcome, stdout: "", stderr: "", code: 0 }) as unknown as ReproTestSample

describe("resolvedConsensus (pure → {votes,k} | null)", () => {
  it("votes = count of RESOLVED samples, against the caller's k", () => {
    const r = resolvedConsensus([sample("resolved"), sample("resolved"), sample("reproduced")], 2)
    expect(r).toEqual({ votes: 2, k: 2 })
  })

  it("RED-on-injection: flipping a resolved→reproduced drops votes below k", () => {
    const before = resolvedConsensus([sample("resolved"), sample("resolved")], 2)
    const after = resolvedConsensus([sample("resolved"), sample("reproduced")], 2)
    expect(before).toEqual({ votes: 2, k: 2 }) // admits (votes>=k)
    expect(after).toEqual({ votes: 1, k: 2 }) // rejects (votes<k)
  })

  it("only 'resolved' counts — reproduced / other / exec_failed are NOT resolved votes", () => {
    const r = resolvedConsensus(
      [sample("resolved"), sample("other"), sample("exec_failed"), sample("unknown")],
      1,
    )
    expect(r).toEqual({ votes: 1, k: 1 })
  })

  it("FAIL-OPEN: empty samples ⇒ null; non-positive k ⇒ null", () => {
    expect(resolvedConsensus([], 1)).toBeNull()
    expect(resolvedConsensus([sample("resolved")], 0)).toBeNull()
  })

  it("FAIL-OPEN: all-inconclusive (every script crashed) ⇒ null, NOT a 0-vote reject", () => {
    // 0 resolved AND 0 reproduced ⇒ no decisive signal. Returning {votes:0,k}
    // here would REJECT the candidate on a broken script (false-RED).
    expect(
      resolvedConsensus([sample("exec_failed"), sample("other"), sample("unknown")], 2),
    ).toBeNull()
  })

  it("a still-reproduced set legitimately yields votes:0 (bug not fixed = reject)", () => {
    expect(resolvedConsensus([sample("reproduced"), sample("reproduced")], 1)).toEqual({
      votes: 0,
      k: 1,
    })
  })
})

// ── port (driver-facing): re-run reproducing set on a patched sandbox ────────

const noWrite: ReproWriteFilePort = async () => {}

/** Exec port mapping each written script path → a canned stdout, by write order. */
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

describe("makePatchedResolvedConsensus (port)", () => {
  it("re-runs the reproducing set; default k = strict majority of the set size", async () => {
    const { exec, writeFile } = makeExec([
      "Issue resolved",
      "Issue resolved",
      "Issue reproduced", // brittle minority
    ])
    const probe = makePatchedResolvedConsensus({ sources: ["a", "b", "c"], exec, writeFile })
    const r = await probe("/patched")
    expect(r).toMatchObject({ votes: 2, k: 2 }) // majority(3)=2; 2 resolved ⇒ admits
    expect(r?.reproTrace.vote).toEqual({
      verdict: "resolved",
      resolved: 2,
      reproduced: 1,
      inconclusive: 0,
    })
  })

  it("RED-on-injection: one fewer resolved ⇒ votes drops under the majority quorum", async () => {
    const { exec, writeFile } = makeExec(["Issue resolved", "Issue reproduced", "Issue reproduced"])
    const probe = makePatchedResolvedConsensus({ sources: ["a", "b", "c"], exec, writeFile })
    const r = await probe("/patched")
    expect(r).toMatchObject({ votes: 1, k: 2 }) // 1 < 2 ⇒ bundle rejects
  })

  it("FAIL-OPEN: empty sources ⇒ null without exec", async () => {
    let called = false
    const exec: ReproExecPort = async () => {
      called = true
      return { code: 0, stdout: "Issue resolved", stderr: "" }
    }
    const r = await makePatchedResolvedConsensus({ sources: [], exec, writeFile: noWrite })("/p")
    expect(r).toBeNull()
    expect(called).toBe(false)
  })

  it("FAIL-OPEN: a throwing exec ⇒ null (never a false-RED rejection)", async () => {
    const exec: ReproExecPort = async () => {
      throw new Error("boom")
    }
    const r = await makePatchedResolvedConsensus({ sources: ["a"], exec, writeFile: noWrite })("/p")
    expect(r).toBeNull()
  })

  it("DEFECT1: crashed (inconclusive) samples must NOT inflate the quorum (decisive-only default k)", async () => {
    // 2 "resolved" + 3 post-fix crashes ("Other issues" ⇒ inconclusive). voteResolved
    // says FIXED (decisive 2-0). The default k must be a majority of DECISIVE votes
    // (=2), NOT of all 5 samples (=3) — else a correct patch is rejected (false-NEG).
    const { exec, writeFile } = makeExec([
      "Issue resolved",
      "Issue resolved",
      "Other issues",
      "Other issues",
      "Other issues",
    ])
    const r = await makePatchedResolvedConsensus({
      sources: ["a", "b", "c", "d", "e"],
      exec,
      writeFile,
    })("/p")
    expect(r).toMatchObject({ votes: 2, k: 2 }) // admits; NOT { votes:2, k:3 }
  })

  it("explicit k overrides the majority default", async () => {
    const { exec, writeFile } = makeExec(["Issue resolved", "Issue resolved"])
    const r = await makePatchedResolvedConsensus({ sources: ["a", "b"], exec, writeFile, k: 1 })(
      "/p",
    )
    expect(r).toMatchObject({ votes: 2, k: 1 })
  })
})
