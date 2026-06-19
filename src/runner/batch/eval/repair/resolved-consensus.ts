/**
 * TC — patched-side resolved K-of-N consensus PORT (driver-facing).
 *
 * Re-runs the REPRODUCING repro set (the scripts that printed "Issue reproduced"
 * on the un-patched tree) inside a PATCHED sandbox and projects the resolved
 * count into the VerificationBundle's `patchedResolvedKofN` HARD signal via
 * {@link resolvedConsensus}. Symmetric to {@link makeReproVoteValidate} — same
 * execution seam, but it yields the bundle's `{votes, k} | null` signal instead
 * of a binary validator verdict, so the selection executor can fold it into
 * candidate scoring.
 *
 * No-leak preserved: inputs are EXCLUSIVELY the agent-side repro scripts
 * (`@/agent/repro-test`) + the sandbox path — never FAIL_TO_PASS / test_patch /
 * the official report.
 *
 * FAIL-OPEN by construction:
 *   - empty reproducing set      ⇒ null (no signal; the bundle never rejects on
 *                                  a missing consensus).
 *   - executeReproTests throws   ⇒ null (a broken exec is not a "still buggy"
 *                                  verdict — never a false-RED rejection).
 *
 * Quorum `k` defaults to a STRICT MAJORITY of the reproducing-set size — the
 * same majority semantics the base-side vote uses, not a tuned threshold.
 */

import {
  executeReproTests,
  type ReproExecPort,
  type ReproWriteFilePort,
} from "@/agent/repro-test/execute"
import type { ReproTestConfig } from "@/agent/repro-test/types"
import { resolvedConsensus } from "@/agent/repro-test/vote"

export interface PatchedResolvedConsensusDeps {
  /** Reproducing scripts (outcome === "reproduced" on the un-patched tree). */
  sources: readonly string[]
  /** Injected exec port (argv form) — SAME wiring the base-red check used. */
  exec: ReproExecPort
  /** Injected file-write port (writes each script under the sandbox). */
  writeFile: ReproWriteFilePort
  /** SWE-bench project-env argv builder, identical to the base-red run. */
  buildArgv?: (scriptPath: string) => readonly string[]
  pythonBin?: string
  config?: ReproTestConfig
  /** Quorum. Default = strict majority of `sources.length`. */
  k?: number
}

/** Strict-majority quorum over a sample count (⌊n/2⌋+1). */
const majorityQuorum = (n: number): number => Math.floor(n / 2) + 1

/**
 * Build the patched-resolved consensus probe. Returns a function that, given a
 * PATCHED sandbox, re-runs the reproducing set there and yields the
 * `{votes, k} | null` hard signal.
 */
export const makePatchedResolvedConsensus =
  (deps: PatchedResolvedConsensusDeps) =>
  async (sandbox: string): Promise<{ votes: number; k: number } | null> => {
    if (deps.sources.length === 0) return null
    const k = deps.k ?? majorityQuorum(deps.sources.length)
    try {
      const samples = await executeReproTests({
        tests: deps.sources,
        repoRoot: sandbox,
        exec: deps.exec,
        writeFile: deps.writeFile,
        ...(deps.config !== undefined ? { config: deps.config } : {}),
        ...(deps.buildArgv !== undefined ? { buildArgv: deps.buildArgv } : {}),
        ...(deps.pythonBin !== undefined ? { pythonBin: deps.pythonBin } : {}),
      })
      return resolvedConsensus(samples, k)
    } catch {
      // A broken exec must never be a false-RED rejection — fail-open to null.
      return null
    }
  }
