import { describe, expect, it } from "bun:test"
import {
  pytestReportPathFor,
  type ReproExecPort,
  type ReproReadFilePort,
  type ReproWriteFilePort,
} from "@/agent/repro-test/execute"
import { makeReproVoteValidate } from "@/runner/batch/eval/repair/repro-vote"
import type { ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

const noWrite: ReproWriteFilePort = async () => {}

type Intent = "resolved" | "reproduced" | "unknown"

const sidecarFor = (intent: Intent): string => {
  if (intent === "reproduced") {
    return JSON.stringify({
      schema: 1,
      collected: 1,
      exitstatus: 1,
      reports: [
        { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "AssertionError" },
      ],
    })
  }
  if (intent === "resolved") {
    return JSON.stringify({
      schema: 1,
      collected: 1,
      exitstatus: 0,
      reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
    })
  }
  return JSON.stringify({ schema: 1, collected: 0, exitstatus: 5, reports: [] })
}

/** Exec port that maps each script SOURCE → a canned pytest result, keyed by a
 *  marker the test embeds in the source. The argv is `[python, path]`; we recover
 *  the intended outcome from the path's index via the writeFile capture. */
const makeExec = (
  intentsByIndex: readonly Intent[],
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
    const intent = intentsByIndex[idx] ?? "unknown"
    reports.set(pytestReportPathFor(path), sidecarFor(intent))
    return intent === "reproduced"
      ? { code: 1, stdout: "assertion failed", stderr: "" }
      : { code: intent === "resolved" ? 0 : 5, stdout: "", stderr: "" }
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

describe("makeReproVoteValidate — K-of-N resolved gate", () => {
  it("majority resolved sidecars clear the gate even with a brittle minority", async () => {
    const { exec, writeFile, readFile } = makeExec([
      "resolved",
      "resolved",
      "resolved",
      "reproduced",
    ])
    const validate = makeReproVoteValidate({
      sources: ["a", "b", "c", "d"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(true)
  })

  it("majority reproduced sidecars reject and seed a reproducing failTail", async () => {
    const { exec, writeFile, readFile } = makeExec(["reproduced", "reproduced", "resolved"])
    const validate = makeReproVoteValidate({
      sources: ["a", "b", "c"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.failTail).toContain("assertion failed")
    expect(r.failTail).not.toBe("FALLBACK_RAN") // the vote decided, not the legacy gate
  })

  it("empty sources ⇒ fail-closed, no legacy fallback", async () => {
    const validate = makeReproVoteValidate({
      sources: [],
      exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.failTail).toContain("empty_sources")
  })

  it("a tie is inconclusive ⇒ fail-closed, no legacy fallback", async () => {
    const { exec, writeFile, readFile } = makeExec(["resolved", "reproduced"])
    const validate = makeReproVoteValidate({
      sources: ["a", "b"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.failTail).not.toBe("FALLBACK_RAN")
  })

  it("throwing exec port is fail-closed, never legacy fallback", async () => {
    const throwingExec: ReproExecPort = async () => {
      throw new Error("spawn ENOENT")
    }
    const validate = makeReproVoteValidate({
      sources: ["a"],
      exec: throwingExec,
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.reproOutcome).toBe("exec_failed")
    expect(r.failTail).toContain("[exec threw]")
  })

  // FLAG 1 — captured per-test crash evidence reaches the model, not a bare label.
  // A per-test exec throw is captured by execute.ts as an `exec_failed` sample with
  // a `[exec threw] <reason>` stderr; the validator must surface THAT reason in the
  // failTail (the next repair round's seed), not a fixed "execution failed" string.
  it("exec_failed sample's captured [exec threw] reason is in failTail (not a bare label)", async () => {
    const reason = "spawn /usr/bin/python ENOENT — interpreter missing"
    const crashingExec: ReproExecPort = async () => {
      throw new Error(reason)
    }
    const validate = makeReproVoteValidate({
      sources: ["a"],
      exec: crashingExec,
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    // The real crash reason is present...
    expect(r.failTail).toContain("[exec threw]")
    expect(r.failTail).toContain(reason)
    // ...and the model is NOT fed a determinative-free asserted label.
    expect(r.failTail).not.toBe("repro vote execution failed")
    expect(r.failTail).not.toBe("repro vote unavailable: empty_sources")
  })

  // FLAG 1 (per-test writeFile throw) — execute.ts captures a writeFile exception
  // as a `[writeFile threw] <reason>` exec_failed sample; that reason must reach
  // failTail (the next-round seed), not a fixed asserted label.
  it("captured [writeFile threw] reason reaches failTail (not a bare label)", async () => {
    const reason = "EACCES /sbx/__repro permission denied"
    const throwingWrite: ReproWriteFilePort = async () => {
      throw new Error(reason)
    }
    const validate = makeReproVoteValidate({
      sources: ["a"],
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: throwingWrite,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.reproOutcome).toBe("exec_failed")
    expect(r.failTail).toContain("[writeFile threw]")
    expect(r.failTail).toContain(reason)
    expect(r.failTail).not.toBe("repro vote execution failed")
  })

  // FLAG 2 — inconclusive failTail comes from the CRASHED sample, NOT a green one.
  // samples = [resolved, exec_failed]: the vote is inconclusive (1 resolved vs 0
  // reproduced is a strict majority -> resolved actually). Force a true tie/
  // inconclusive where samples[0] is GREEN and samples[1] CRASHED.
  it("inconclusive tail is the failing sample's output, never the passing samples[0]", async () => {
    // [resolved, exec_failed]: resolved=1, reproduced=0 -> verdict resolved.
    // To get an INCONCLUSIVE round with a green samples[0] and a crashed sample,
    // use [resolved, reproduced, exec_failed]: resolved=1, reproduced=1 -> tie ->
    // inconclusive. samples[0] is the GREEN one; the crashed sample is samples[2].
    const GREEN_MARKER = "EXPECTED OUTPUT — ASSERTION PASSED CLEANLY"
    const CRASH_MARKER = "Traceback: KeyError 'widget' — sandbox crash detail"
    // Build a hand-rolled exec/readFile so we can plant distinct stdout per sample.
    const pathToIdx = new Map<string, number>()
    let n = 0
    const writeFile: ReproWriteFilePort = async (path) => {
      pathToIdx.set(path, n)
      n += 1
    }
    // outcome per index: 0=resolved(green), 1=reproduced, 2=exec_failed(crash)
    const reports = new Map<string, string>()
    const exec: ReproExecPort = async (argv) => {
      const path = argv[argv.length - 1] as string
      const idx = pathToIdx.get(path) ?? 0
      if (idx === 0) {
        reports.set(
          pytestReportPathFor(path),
          JSON.stringify({
            schema: 1,
            collected: 1,
            exitstatus: 0,
            reports: [{ nodeid: "t::t", when: "call", outcome: "passed" }],
          }),
        )
        return { code: 0, stdout: GREEN_MARKER, stderr: "" }
      }
      if (idx === 1) {
        reports.set(
          pytestReportPathFor(path),
          JSON.stringify({
            schema: 1,
            collected: 1,
            exitstatus: 1,
            reports: [
              { nodeid: "t::t", when: "call", outcome: "failed", exc_type: "AssertionError" },
            ],
          }),
        )
        return { code: 1, stdout: "still reproduces", stderr: "" }
      }
      // idx 2: exec_failed — pytest report missing -> classified exec_failed; the
      // crash detail lives in stderr.
      return { code: 2, stdout: "", stderr: CRASH_MARKER }
    }
    const readFile: ReproReadFilePort = async (path) => reports.get(path) ?? ""

    const validate = makeReproVoteValidate({
      sources: ["green", "repro", "crash"],
      exec,
      writeFile,
      readFile,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.reproOutcome).toBe("unknown") // mixed inconclusive (not all exec_failed)
    // The crashed sample's detail reaches the model...
    expect(r.failTail).toContain(CRASH_MARKER)
    expect(r.failTail).toContain("outcome=exec_failed")
    // TEETH: a blind samples[0] pick would surface the GREEN/passing output as the
    // "failure" — assert that misdirection does NOT happen.
    expect(r.failTail).not.toContain(GREEN_MARKER)
    expect(r.failTail).not.toBe("FALLBACK_RAN")
  })

  // FLAG 2 sibling — all-exec_failed inconclusive still carries the crash tail and
  // is labeled exec_failed (reproOutcome), proving the all-crashed path surfaces
  // determinative evidence rather than samples[0]'s empty/asserted label.
  it("all-exec_failed inconclusive surfaces the crash tail + exec_failed outcome", async () => {
    const CRASH = "ModuleNotFoundError: No module named 'app' — env broke"
    const exec: ReproExecPort = async () => ({ code: 2, stdout: "", stderr: CRASH })
    const validate = makeReproVoteValidate({
      sources: ["a", "b"],
      exec,
      writeFile: noWrite,
      // no readFile -> report-missing -> exec_failed for every sample
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.reproOutcome).toBe("exec_failed")
    expect(r.failTail).toContain(CRASH)
    expect(r.failTail).toContain("outcome=exec_failed")
  })
})
