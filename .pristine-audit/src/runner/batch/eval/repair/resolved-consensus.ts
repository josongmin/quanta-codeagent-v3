/**
 * TC — patched-side resolved K-of-N consensus PORT (driver-facing).
 *
 * Re-runs the REPRODUCING repro set (the scripts whose sidecar was red on the
 * un-patched tree) inside a PATCHED sandbox and projects the resolved count
 * into the VerificationBundle's `patchedResolvedKofN` HARD signal via
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
  type ReproReadFilePort,
  type ReproWriteFilePort,
} from "@/agent/repro-test/execute"
import type { ReproTestConfig, ReproTestOutcome, ReproTestSample } from "@/agent/repro-test/types"
import {
  type ReproResolvedVerdict,
  type ReproVote,
  resolvedConsensus,
  voteResolved,
} from "@/agent/repro-test/vote"

export interface PatchedResolvedConsensusDeps {
  /** Reproducing scripts (outcome === "reproduced" on the un-patched tree). */
  sources: readonly string[]
  /** Injected exec port (argv form) — SAME wiring the base-red check used. */
  exec: ReproExecPort
  /** Injected file-write port (writes each script under the sandbox). */
  writeFile: ReproWriteFilePort
  /** Reads the controlled pytest report sidecar for each script. */
  readFile?: ReproReadFilePort
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

export type ReproConsensusProofState =
  | "not_available"
  | "base_red_candidate_green"
  | "base_red_candidate_red"
  | "false_negative_suspected"
  | "execution_failed"

export interface ReproConsensusProofReceipt extends PatchedResolvedConsensusSignal {
  readonly state: ReproConsensusProofState
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

const emptyVote: ReproVote = {
  verdict: "inconclusive",
  resolved: 0,
  reproduced: 0,
  inconclusive: 0,
}

const notAvailableReceipt = (): ReproConsensusProofReceipt => ({
  state: "not_available",
  votes: 0,
  k: 0,
  reproTrace: { vote: emptyVote, samples: [] },
})

const executionFailedReceipt = (
  deps: PatchedResolvedConsensusDeps,
): ReproConsensusProofReceipt => ({
  state: "execution_failed",
  votes: 0,
  k: deps.k ?? majorityQuorum(deps.sources.length),
  reproTrace: { vote: emptyVote, samples: [] },
})

const runConsensusSamples = (
  deps: PatchedResolvedConsensusDeps,
  sandbox: string,
): Promise<readonly ReproTestSample[]> =>
  executeReproTests({
    tests: deps.sources,
    repoRoot: sandbox,
    exec: deps.exec,
    writeFile: deps.writeFile,
    ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
    ...(deps.config !== undefined ? { config: deps.config } : {}),
    ...(deps.buildArgv !== undefined ? { buildArgv: deps.buildArgv } : {}),
    ...(deps.pythonBin !== undefined ? { pythonBin: deps.pythonBin } : {}),
  })

const unresolvedConsensusReceipt = (
  samples: readonly ReproTestSample[],
  vote: ReproVote,
  k: number,
): ReproConsensusProofReceipt => {
  const everyExecFailed =
    samples.length > 0 && samples.every((sample) => sample.outcome === "exec_failed")
  return {
    state: everyExecFailed ? "execution_failed" : "false_negative_suspected",
    votes: vote.resolved,
    k,
    reproTrace: {
      vote,
      samples: traceSamples(samples),
    },
  }
}

const decisiveConsensusReceipt = (
  signal: { readonly votes: number; readonly k: number },
  samples: readonly ReproTestSample[],
): ReproConsensusProofReceipt => ({
  state: signal.votes >= signal.k ? "base_red_candidate_green" : "base_red_candidate_red",
  ...withTrace(signal, samples),
})

/**
 * Build the patched-resolved consensus proof probe. Returns a function that,
 * given a PATCHED sandbox, re-runs the reproducing set there and yields a typed
 * receipt preserving the executed trace.
 */
export const makePatchedResolvedConsensusProof =
  (deps: PatchedResolvedConsensusDeps) =>
  async (sandbox: string): Promise<ReproConsensusProofReceipt> => {
    if (deps.sources.length === 0) return notAvailableReceipt()
    try {
      const samples = await runConsensusSamples(deps, sandbox)
      // Default quorum = majority of DECISIVE votes (resolved+reproduced), so
      // post-fix crashes don't inflate the bar. Explicit `k` is honored as-is.
      const v = voteResolved(samples)
      const k = deps.k ?? majorityQuorum(v.resolved + v.reproduced)
      const signal = resolvedConsensus(samples, k)
      return signal === null
        ? unresolvedConsensusReceipt(samples, v, k)
        : decisiveConsensusReceipt(signal, samples)
    } catch {
      // A broken exec must never be a false-RED rejection — fail-open to null.
      return executionFailedReceipt(deps)
    }
  }

/**
 * Back-compat projection: only executed candidate-green/candidate-red receipts
 * speak to the legacy `{votes,k} | null` signal. Missing/infra/false-negative
 * receipts remain fail-open null.
 */
export const makePatchedResolvedConsensus =
  (deps: PatchedResolvedConsensusDeps) =>
  async (sandbox: string): Promise<PatchedResolvedConsensusSignal | null> => {
    const receipt = await makePatchedResolvedConsensusProof(deps)(sandbox)
    return receipt.state === "base_red_candidate_green" ||
      receipt.state === "base_red_candidate_red"
      ? {
          votes: receipt.votes,
          k: receipt.k,
          reproTrace: receipt.reproTrace,
        }
      : null
  }
