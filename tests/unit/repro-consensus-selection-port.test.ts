/**
 * SOTA++ verify-and-select wiring — `makeReproConsensusSelectionPort` connects
 * the inner repro-vote (makePatchedResolvedConsensus, tested in
 * resolved-consensus.test.ts) to the selection executor's `resolvedKofN` port.
 *
 * The non-empty path re-materializes each candidate via `withCandidatePatch`
 * (real git) and is covered at integration level; the UNIT teeth here is the
 * FAIL-OPEN gate: an empty reproducing set must yield a port that returns null
 * WITHOUT touching git — so a candidate is never rejected (or a sandbox mutated)
 * when there is no consensus signal to begin with.
 */
import { describe, expect, it } from "bun:test"
import { makeReproConsensusSelectionPort } from "@/runner/batch/eval/driver"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import type { Instance } from "@/runner/batch/types"

const INSTANCE = {
  swebench: { repo: "django/django", baseCommit: "deadbeef" },
} as unknown as Instance

const CAND: Candidate = {
  id: "cand-0",
  patch: "diff --git a/x b/x\n",
  turns: 1,
  files: ["x"],
  baseValidatedRed: true,
}

describe("makeReproConsensusSelectionPort — selection scorer wiring", () => {
  it("FAIL-OPEN: empty reproducing set ⇒ a port that returns null without git", async () => {
    const port = makeReproConsensusSelectionPort(INSTANCE, [], "/sbx-does-not-exist", 1000)
    // No reproducing set ⇒ no consensus objection. Must NOT attempt to apply the
    // patch (the sandbox path is bogus — a git attempt would throw, not return null).
    expect(await port(CAND)).toBeNull()
  })

  it("returns a callable port (the resolvedKofN seam the bundle scores on)", () => {
    const port = makeReproConsensusSelectionPort(INSTANCE, ["repro-a"], "/sbx", 1000)
    expect(typeof port).toBe("function")
  })
})
