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
 * Quorum `k` defaults to a STRICT MAJORITY of the DECISIVE votes
 * (resolved + reproduced) — NOT of the raw sample count. Post-fix crashes
 * (inconclusive: `other`/`exec_failed`/`unknown`) are "no evidence either way"
 * and must NOT inflate the bar, else a correct patch whose brittle scripts crash
 * after the fix would be rejected (the exact false-NEGATIVE this line removes).
 * This makes the default agree with {@link voteResolved}'s decisive-majority
 * verdict. An explicit `k` is honored verbatim.
 */

import {
  executeReproTests,
  type ReproExecPort,
  type ReproWriteFilePort,
} from "@/agent/repro-test/execute"
import type { ReproTestConfig, ReproTestOutcome, ReproTestSample } from "@/agent/repro-test/types"
import { type ReproResolvedVerdict, resolvedConsensus, voteResolved } from "@/agent/repro-test/vote"

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

export interface ReproConsensusTraceSample {
  readonly outcome: ReproTestOutcome
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly source: string
}

export interface ReproConsensusTrace {
  readonly vote: {
    readonly verdict: ReproResolvedVerdict
    readonly resolved: number
    readonly reproduced: number
    readonly inconclusive: number
  }
  readonly samples: readonly ReproConsensusTraceSample[]
}

export interface PatchedResolvedConsensusSignal {
  readonly votes: number
  readonly k: number
  readonly reproTrace: ReproConsensusTrace
}

/** Strict-majority quorum over a sample count (⌊n/2⌋+1). */
const majorityQuorum = (n: number): number => Math.floor(n / 2) + 1

const tail = (s: string | undefined, n = 1200): string => {
  const v = s ?? ""
  return v.length > n ? v.slice(-n) : v
}

const traceSamples = (samples: readonly ReproTestSample[]): readonly ReproConsensusTraceSample[] =>
  samples.map((sample) => ({
    outcome: sample.outcome,
    stdoutTail: tail(sample.stdout),
    stderrTail: tail(sample.stderr),
    source: sample.source,
  }))

const withTrace = (
  signal: { readonly votes: number; readonly k: number },
  samples: readonly ReproTestSample[],
): PatchedResolvedConsensusSignal => {
  const vote = voteResolved(samples)
  return {
    ...signal,
    reproTrace: {
      vote,
      samples: traceSamples(samples),
    },
  }
}

/**
 * Build the patched-resolved consensus probe. Returns a function that, given a
 * PATCHED sandbox, re-runs the reproducing set there and yields the
 * `{votes, k} | null` hard signal.
 */
export const makePatchedResolvedConsensus =
  (deps: PatchedResolvedConsensusDeps) =>
  async (sandbox: string): Promise<PatchedResolvedConsensusSignal | null> => {
    if (deps.sources.length === 0) return null
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
      // Default quorum = majority of DECISIVE votes (resolved+reproduced), so
      // post-fix crashes don't inflate the bar. Explicit `k` is honored as-is.
      const v = voteResolved(samples)
      const k = deps.k ?? majorityQuorum(v.resolved + v.reproduced)
      const signal = resolvedConsensus(samples, k)
      return signal === null ? null : withTrace(signal, samples)
    } catch {
      // A broken exec must never be a false-RED rejection — fail-open to null.
      return null
    }
  }
