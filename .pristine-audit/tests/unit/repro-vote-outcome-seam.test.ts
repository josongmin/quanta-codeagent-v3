import { describe, expect, it } from "bun:test"
import {
  pytestReportPathFor,
  type ReproExecPort,
  type ReproReadFilePort,
  type ReproWriteFilePort,
} from "@/agent/repro-test/execute"
import {
  makeReproVoteValidate,
  type ReproVoteOutcome,
  type ReproVoteOutcomeDetail,
} from "@/runner/batch/eval/repair/repro-vote"
import type { ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

const noWrite: ReproWriteFilePort = async () => {}

type Intent = "resolved" | "reproduced"

const sidecarFor = (intent: Intent): string =>
  intent === "reproduced"
    ? JSON.stringify({
        schema: 1,
        collected: 1,
        exitstatus: 1,
        reports: [
          { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "AssertionError" },
        ],
      })
    : JSON.stringify({
        schema: 1,
        collected: 1,
        exitstatus: 0,
        reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
      })

/** Exec port that maps each script (in WRITE order) → a canned pytest result, so
 *  the test can drive the vote into each verdict deterministically. */
const makeExec = (
  intentByIndex: readonly Intent[],
): { exec: ReproExecPort; writeFile: ReproWriteFilePort; readFile: ReproReadFilePort } => {
  const pathToIdx = new Map<string, number>()
  const reports = new Map<string, string>()
  let n = 0
  const writeFile: ReproWriteFilePort = async (path) => {
    pathToIdx.set(path, n)
    n += 1
  }
  const exec: ReproExecPort = async (argv) => {
    const path = argv[argv.length - 1] as string
    const idx = pathToIdx.get(path) ?? 0
    const intent = intentByIndex[idx] ?? "resolved"
    reports.set(pytestReportPathFor(path), sidecarFor(intent))
    return intent === "reproduced"
      ? { code: 1, stdout: "assertion failed", stderr: "" }
      : { code: 0, stdout: "", stderr: "" }
  }
  return { exec, writeFile, readFile: async (path) => reports.get(path) ?? "" }
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

/** Capturing sink + the validator result, paired so each branch can assert BOTH
 *  the emitted outcome AND that the result is unchanged vs. the no-sink control. */
const runWithSink = async (
  deps: Parameters<typeof makeReproVoteValidate>[0],
): Promise<{
  result: ValidatorResult
  emitted: { outcome: ReproVoteOutcome; detail?: ReproVoteOutcomeDetail }[]
}> => {
  const emitted: { outcome: ReproVoteOutcome; detail?: ReproVoteOutcomeDetail }[] = []
  const validate = makeReproVoteValidate({
    ...deps,
    recordReproVoteOutcome: (outcome, detail) =>
      emitted.push({ outcome, ...(detail !== undefined ? { detail } : {}) }),
  })
  const result = await validate(baseArgs())
  return { result, emitted }
}

describe("makeReproVoteValidate — outcome MEASUREMENT seam", () => {
  it("empty sources ⇒ emits 'empty_sources' (no vote detail)", async () => {
    const { result, emitted } = await runWithSink({
      sources: [],
      exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.outcome).toBe("empty_sources")
    expect(emitted[0]?.detail).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(result.failTail).toContain("empty_sources")
  })

  it("executeReproTests THROWS (not a per-script throw) ⇒ emits 'exec_failed' (no vote detail)", async () => {
    // FINDING: `executeReproTests` swallows a per-script exec throw into an
    // `exec_failed` SAMPLE (→ inconclusive vote), so a throwing `exec` port does
    // NOT reach the validator's catch (see the 'inconclusive' branch below). The
    // validator's own catch only fires if `executeReproTests` ITSELF rejects. We
    // simulate that with a `sources` whose element access throws inside the loop
    // — the defensive "broken exec must not be a silent pass" path.
    let lengthReads = 0
    const explodingSources = new Proxy(["a"] as readonly string[], {
      get(target, prop, recv) {
        if (prop === "length") {
          lengthReads += 1
          return target.length // guard read (===0 check) passes; loop read fine
        }
        if (prop === "0" && lengthReads > 1) throw new Error("tests[i] exploded")
        return Reflect.get(target, prop, recv)
      },
    })
    const { result, emitted } = await runWithSink({
      sources: explodingSources,
      exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.outcome).toBe("exec_failed")
    expect(emitted[0]?.detail).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(result.reproOutcome).toBe("exec_failed")
    // FLAG 1: the thrown reason is surfaced in failTail (next-round seed), not a
    // determinative-free bare "execution failed" label.
    expect(result.failTail).toContain("repro vote execution failed")
    expect(result.failTail).toContain("tests[i] exploded")
  })

  it("resolved majority ⇒ emits 'vote_resolved' with the vote tally", async () => {
    const { exec, writeFile, readFile } = makeExec([
      "resolved",
      "resolved",
      "resolved",
      "reproduced",
    ])
    const { result, emitted } = await runWithSink({
      sources: ["a", "b", "c", "d"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.outcome).toBe("vote_resolved")
    expect(emitted[0]?.detail).toEqual({ resolved: 3, reproduced: 1, inconclusive: 0 })
    // jun-28 STRONG-ORACLE: a resolved vote carries the RESOLVED-side consensus
    // verdict so the strong-oracle clear gate can require it (no-leak: agent-side
    // repro vote only).
    expect(result).toEqual({ ok: true, consensus: "resolved" })
  })

  it("reproduced majority ⇒ emits 'vote_unresolved' with the vote tally", async () => {
    const { exec, writeFile, readFile } = makeExec(["reproduced", "reproduced", "resolved"])
    const { result, emitted } = await runWithSink({
      sources: ["a", "b", "c"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.outcome).toBe("vote_unresolved")
    expect(emitted[0]?.detail).toEqual({ resolved: 1, reproduced: 2, inconclusive: 0 })
    expect(result.ok).toBe(false)
    expect(result.failTail).toContain("assertion failed")
  })

  it("tie ⇒ emits 'vote_inconclusive' with the vote tally, then fail-closes", async () => {
    const { exec, writeFile, readFile } = makeExec(["resolved", "reproduced"])
    const { result, emitted } = await runWithSink({
      sources: ["a", "b"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.outcome).toBe("vote_inconclusive")
    expect(emitted[0]?.detail).toEqual({ resolved: 1, reproduced: 1, inconclusive: 0 })
    expect(result.ok).toBe(false)
    expect(result.failTail).not.toBe("FALLBACK_RAN")
  })

  it("PAIRED CONTROL: with NO sink, every branch's result is byte-identical (no-op seam)", async () => {
    // resolved (carries the STRONG-ORACLE consensus verdict; no-op seam = the
    // result shape is identical whether or not a sink was injected)
    const resolved = makeExec(["resolved", "resolved"])
    expect(
      await makeReproVoteValidate({ sources: ["a", "b"], ...resolved, fallback: LOUD_FALLBACK })(
        baseArgs(),
      ),
    ).toEqual({ ok: true, consensus: "resolved" })
    // reproduced
    const reproduced = makeExec(["reproduced", "reproduced"])
    const rRepro = await makeReproVoteValidate({
      sources: ["a", "b"],
      ...reproduced,
      fallback: LOUD_FALLBACK,
    })(baseArgs())
    expect(rRepro.ok).toBe(false)
    expect(rRepro.failTail).toContain("assertion failed")
    const tie = makeExec(["resolved", "reproduced"])
    expect(
      await makeReproVoteValidate({ sources: ["a", "b"], ...tie, fallback: LOUD_FALLBACK })(
        baseArgs(),
      ),
    ).toMatchObject({ ok: false })
    expect(
      await makeReproVoteValidate({
        sources: [],
        exec: resolved.exec,
        writeFile: noWrite,
        fallback: LOUD_FALLBACK,
      })(baseArgs()),
    ).toMatchObject({ ok: false })
  })
})
