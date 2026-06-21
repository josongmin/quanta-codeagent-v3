/**
 * SCAFF-06 — executable public-MWE proof PORT hellgate. Drives the REAL port
 * builder with fake exec/reset/rematerialise deps (no Python), proving the
 * base-RED oracle polarity and the typed admit/veto/infra classification.
 *
 * The public MWE source is assembled from a fragment so the self-policing scan
 * (no gold/instance-id/FAIL_TO_PASS literal) stays clean.
 */
import { describe, expect, it } from "bun:test"
import { prepareMweProofSelectionPort } from "@/runner/batch/eval/mwe-proof-port"
import type { Candidate } from "@/runner/batch/eval/selection-executor"

const ISSUE = `Repro:\n\n\`\`\`python\nassert add(1, 2) == 3\n\`\`\`\n`
const instance = {
  problemStatement: ISSUE,
  swebench: { repo: "acme/widget", version: "1.0", baseCommit: "deadbeef" },
} as const
const cand = (id: string): Candidate => ({
  id,
  patch: `diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b`,
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
})

/** deps where base run = `baseRun`, every candidate run = `patchedRun`. */
const fakeDeps = (baseRun: boolean | null, patchedRun: boolean | null) => {
  let firstRun = true
  return {
    resetBase: async () => true,
    rematerialize: async <T>(a: { probe: (sb: string) => Promise<T> }) => a.probe("sb"),
    runScript: async () => {
      // first invocation is the BASE run; later invocations are candidate runs.
      if (firstRun) {
        firstRun = false
        return baseRun
      }
      return patchedRun
    },
  }
}

describe("SCAFF-06 — mwe-proof port (base-red oracle, fake exec)", () => {
  it("base RED + candidate PASS ⇒ patched_green (admit)", async () => {
    // base run false = non-zero exit = reproduces; candidate run true = passes.
    const port = await prepareMweProofSelectionPort(instance, "sb", 1000, fakeDeps(false, true))
    expect(port).toBeDefined()
    expect((await port?.(cand("c0")))?.state).toBe("patched_green")
  })

  it("base RED + candidate FAIL ⇒ candidate_red (veto)", async () => {
    const port = await prepareMweProofSelectionPort(instance, "sb", 1000, fakeDeps(false, false))
    expect((await port?.(cand("c0")))?.state).toBe("candidate_red")
  })

  it("base RED + candidate INFRA (null) ⇒ execution_failed (never a veto)", async () => {
    const port = await prepareMweProofSelectionPort(instance, "sb", 1000, fakeDeps(false, null))
    expect((await port?.(cand("c0")))?.state).toBe("execution_failed")
  })

  it("base GREEN (does not reproduce) ⇒ NO port (not a fix oracle)", async () => {
    const port = await prepareMweProofSelectionPort(instance, "sb", 1000, fakeDeps(true, true))
    expect(port).toBeUndefined()
  })

  it("base INFRA (null run) ⇒ NO port (not a proven oracle)", async () => {
    const port = await prepareMweProofSelectionPort(instance, "sb", 1000, fakeDeps(null, true))
    expect(port).toBeUndefined()
  })

  it("no extractable MWE ⇒ NO port", async () => {
    const port = await prepareMweProofSelectionPort(
      { ...instance, problemStatement: "no code fences here" },
      "sb",
      1000,
      fakeDeps(false, true),
    )
    expect(port).toBeUndefined()
  })

  it("base reset failure ⇒ NO port (fail-open, no false oracle)", async () => {
    const port = await prepareMweProofSelectionPort(instance, "sb", 1000, {
      ...fakeDeps(false, true),
      resetBase: async () => false,
    })
    expect(port).toBeUndefined()
  })
})
