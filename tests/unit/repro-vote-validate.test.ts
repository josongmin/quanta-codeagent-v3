import { describe, expect, it } from "bun:test"
import type { ReproExecPort, ReproWriteFilePort } from "@/agent/repro-test/execute"
import { makeReproVoteValidate } from "@/runner/batch/eval/repair/repro-vote"
import type { ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

const noWrite: ReproWriteFilePort = async () => {}

/** Exec port that maps each script SOURCE → a canned stdout, keyed by a marker
 *  the test embeds in the source. The argv is `[python, path]`; we recover the
 *  intended outcome from the path's index suffix via the writeFile capture. */
const makeExec = (stdoutByIndex: readonly string[]): { exec: ReproExecPort; writeFile: ReproWriteFilePort } => {
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

const LOUD_FALLBACK = async (): Promise<ValidatorResult> => ({ ok: false, failTail: "FALLBACK_RAN" })

describe("makeReproVoteValidate — K-of-N resolved gate", () => {
  it("THE FIX: majority 'Issue resolved' clears the gate even with a brittle minority", async () => {
    const { exec, writeFile } = makeExec([
      "Issue resolved",
      "Issue resolved",
      "Issue resolved",
      "Issue reproduced", // the brittle one that legacy single-gate would trip on
    ])
    const validate = makeReproVoteValidate({
      sources: ["a", "b", "c", "d"],
      exec,
      writeFile,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(true)
  })

  it("majority 'Issue reproduced' rejects and seeds a reproducing failTail", async () => {
    const { exec, writeFile } = makeExec([
      "boom\nIssue reproduced",
      "Issue reproduced",
      "Issue resolved",
    ])
    const validate = makeReproVoteValidate({ sources: ["a", "b", "c"], exec, writeFile, fallback: LOUD_FALLBACK })
    const r = await validate(baseArgs())
    expect(r.ok).toBe(false)
    expect(r.failTail).toContain("Issue reproduced")
    expect(r.failTail).not.toBe("FALLBACK_RAN") // the vote decided, not the legacy gate
  })

  it("empty sources ⇒ byte-identical fallback (default-OFF posture)", async () => {
    const validate = makeReproVoteValidate({
      sources: [],
      exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
      writeFile: noWrite,
      fallback: LOUD_FALLBACK,
    })
    const r = await validate(baseArgs())
    expect(r).toEqual({ ok: false, failTail: "FALLBACK_RAN" })
  })

  it("a tie is inconclusive ⇒ falls back to the legacy gate (does NOT guess)", async () => {
    const { exec, writeFile } = makeExec(["Issue resolved", "Issue reproduced"])
    const validate = makeReproVoteValidate({ sources: ["a", "b"], exec, writeFile, fallback: LOUD_FALLBACK })
    const r = await validate(baseArgs())
    expect(r).toEqual({ ok: false, failTail: "FALLBACK_RAN" })
  })

  it("FAIL-OPEN: a throwing exec port defers to the legacy gate, never a silent pass", async () => {
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
    expect(r).toEqual({ ok: false, failTail: "FALLBACK_RAN" })
  })
})
