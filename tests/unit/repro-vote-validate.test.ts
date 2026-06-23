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
})
