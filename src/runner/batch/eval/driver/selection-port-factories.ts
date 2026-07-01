/**
 * Selection / repair-round PORT FACTORIES + stage-wiring leaves (pure code
 * motion from `driver.ts`, byte-identical). Owns the shared repro exec bundle,
 * the repro-vote validator composer, the acceptance `selectCandidates` builder,
 * the repro-consensus selection/proof/calibrated port factories, and the small
 * stage helpers (`applySampleTemperature`, `maybeReviewSubmission`,
 * `resolveLocationFanoutSeeder`, `resolveAcceptanceLlmRerank`). These are the
 * SSOT wiring shared by BOTH bench drivers; they depend only on leaf sibling
 * modules + the extracted env-knob resolver, so there is NO driver import cycle.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  executeReproTests,
  type ReproExecPort,
  type ReproReadFilePort,
  type ReproWriteFilePort,
} from "@/agent"
import { voteResolved } from "@/agent/repro-test/vote"
import {
  type LLMPort,
  modelSupportsSamplingTemperature,
  sampleTemperatureForCandidate,
  withTemperature,
} from "@/llm"
import { gateOn } from "@/shared"
import type { Instance, ReproOracleCalibration } from "../../types"
import { buildLlmRerankFromPort, resolveLlmSelectMode } from "../acceptance-llm-rerank-wire"
import type { AcceptanceLlmRerank, AcceptanceSelectionObserver } from "../acceptance-select"
import { buildReproAcceptanceSelector, regressionFailureCount } from "../acceptance-selector"
import { execArgv } from "../exec"
import { buildLocationSeeder, type PerCandidateSeed } from "../location-set-fanout"
import { buildProjectPytestArgv, makeBenchRegressionOracle } from "../regression-oracle-adapter"
import { withCandidatePatch } from "../rematerialize"
import { makeReproVoteValidate, type PersistReproVoteRoundArgs } from "../repair/repro-vote"
import {
  makePatchedResolvedConsensus,
  makePatchedResolvedConsensusProof,
} from "../repair/resolved-consensus"
import type { ValidateArgs, ValidatorResult } from "../repair/types"
import { preferredReproExecRuntime, resolveReproAdapter } from "../repro-adapter"
import { reproArtifactVoteRoundPath } from "../repro-artifacts-fs"
import {
  boundReproArtifactSidecar,
  boundReproArtifactTail,
  sourceHashOf,
} from "../repro-artifacts-sink"
import {
  calibrateReproOracle,
  unavailableReproOracleCalibration,
} from "../repro-oracle-calibration"
import type { Candidate } from "../selection-executor"
import { reviewSubmission, type SubmissionReview } from "../submission-review"
import { strongVoteKey } from "../vote-key-normalize"
import { benchOptIns } from "./env-knob-parse"

/**
 * #2 repro-vote — compose the repair validator. SHARED by both bench drivers
 * (runner core + apps prod wrapper) so the production exec wiring is identical.
 *
 * Default-OFF byte-identical: returns `fallback` UNCHANGED unless the
 * `repro-vote` knob is on. ON ⇒ wraps the K-of-N RESOLVED majority vote that
 * re-runs the reproducing set on the patched sandbox (`makeReproVoteValidate`).
 * Empty/inconclusive/infra states fail closed inside that validator; they do not
 * fall back to legacy markers. The exec port mirrors the base-red run.
 */
/** Shared repro exec wiring — uvx project-env argv (SWE-bench) + the instance's
 *  localEnv, mirroring the base-red run so imports resolve identically. Used by
 *  BOTH the repro-vote validator and the consensus selection scorer (one SSOT so
 *  they can never drift in how a candidate's repro set is executed). */
export const reproExecBundle = (
  instance: Instance,
): {
  exec: ReproExecPort
  writeFile: ReproWriteFilePort
  readFile: ReproReadFilePort
  buildArgv?: (s: string) => readonly string[]
} => {
  const repo = instance.swebench?.repo
  const version = instance.swebench?.version
  // Same repro runtime policy as prepareReproTests: Verified/Live Python stay on the host argv,
  // Pro Python with `dockerhubTag` run inside the instance image, and unsupported languages omit
  // buildArgv entirely (the non-Python repro set is already fail-closed upstream in prepareReproTests).
  const adapter = resolveReproAdapter(instance)
  return {
    exec: (argv, cwd, timeoutMs) =>
      execArgv(argv, cwd, timeoutMs, {
        ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
      }),
    writeFile: async (p: string, c: string): Promise<void> => {
      await Bun.write(p, c)
    },
    readFile: async (p: string): Promise<string> => Bun.file(p).text(),
    ...(repo !== undefined && adapter !== null
      ? {
          buildArgv: (scriptPath: string) => [
            ...adapter.buildExecArgv({
              repo,
              version,
              scriptPath,
              ...preferredReproExecRuntime(instance, scriptPath),
            }),
          ],
        }
      : {}),
  }
}

/** A1 follow-through: persist ONE repro-vote round's raw samples under the same
 *  per-instance artifact tree as generation candidates. */
export const persistReproVoteRoundArtifacts = async (args: {
  rootDir: string
  instanceId: string
  round: number
  payload: PersistReproVoteRoundArgs
}): Promise<void> => {
  const dir = reproArtifactVoteRoundPath(args.rootDir, args.instanceId, args.round)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "vote.json"),
    `${JSON.stringify(
      {
        round: args.payload.round,
        outcome: args.payload.outcome,
        ...(args.payload.detail !== undefined ? { detail: args.payload.detail } : {}),
        ...(args.payload.error !== undefined ? { error: args.payload.error } : {}),
        samples:
          args.payload.samples?.map((sample, index) => ({
            candidateId: `canonical-${index}`,
            sourceHash: sourceHashOf(sample.source),
            outcome: sample.outcome,
            ...(sample.execFailure !== undefined ? { execFailure: sample.execFailure } : {}),
            sidecarPresent: sample.sidecarReport !== undefined,
          })) ?? [],
      },
      null,
      2,
    )}\n`,
  )
  for (const [index, sample] of (args.payload.samples ?? []).entries()) {
    const sampleDir = join(dir, `canonical-${index}`)
    await mkdir(sampleDir, { recursive: true })
    await writeFile(join(sampleDir, "candidate.py"), sample.source)
    await writeFile(
      join(sampleDir, "outcome.json"),
      `${JSON.stringify(
        {
          round: args.payload.round,
          candidateId: `canonical-${index}`,
          sourceHash: sourceHashOf(sample.source),
          outcome: sample.outcome,
          ...(sample.execFailure !== undefined ? { execFailure: sample.execFailure } : {}),
          sidecarPresent: sample.sidecarReport !== undefined,
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(join(sampleDir, "stdout.txt"), boundReproArtifactTail(sample.stdout))
    await writeFile(join(sampleDir, "stderr.txt"), boundReproArtifactTail(sample.stderr ?? ""))
    if (sample.sidecarReport !== undefined) {
      await writeFile(
        join(sampleDir, "sidecar.json"),
        boundReproArtifactSidecar(sample.sidecarReport),
      )
    }
  }
}

export const buildReproVoteValidate = (
  instance: Instance,
  reproSources: readonly string[],
  fallback: (args: ValidateArgs) => Promise<ValidatorResult>,
  reproArtifactRootPath?: string,
): ((args: ValidateArgs) => Promise<ValidatorResult>) => {
  if (benchOptIns().reproVote !== true) return fallback
  return makeReproVoteValidate({
    sources: reproSources,
    ...reproExecBundle(instance),
    fallback,
    ...(reproArtifactRootPath !== undefined
      ? {
          persistReproVoteRound: (payload: PersistReproVoteRoundArgs) =>
            persistReproVoteRoundArtifacts({
              rootDir: reproArtifactRootPath,
              instanceId: instance.id,
              round: payload.round,
              payload,
            }),
        }
      : {}),
  })
}

/**
 * jun-28 SOTA++ Phase-A — SHARED acceptance `selectCandidates` builder (both
 * drivers call this so the probe wiring is one SSOT). When `enabled` AND a
 * reproducing set exists, each breadth candidate's patch is scored ONCE by the
 * repro oracle (re-run the reproducing set on the candidate's patched tree via
 * {@link withCandidatePatch} reset→apply→probe→reset; RESOLVED iff the K-of-N vote
 * resolves) and the winner is chosen by the Agentless-faithful rerank. ABSENT ⇒
 * `undefined` ⇒ legacy validator-rank selection (byte-identical). No-leak: scores
 * ONLY the agent-side reproSources.
 */
export const makeAcceptanceSelectCandidates = (
  instance: Instance,
  reproSources: readonly string[],
  sandbox: string,
  timeoutMs: number,
  enabled: boolean,
  /** OPTIONAL dual-guard regression set (no-leak: base-tree-green tests an operator/
   *  upstream selected). Non-empty ⇒ the acceptance rerank ALSO scores regression
   *  failures; absent/empty ⇒ repro-only (byte-identical). The base-green capture
   *  that feeds this is the measure-first follow-up (≈2× test cost — opt-in). */
  regressionSet?: readonly string[],
  /** OPTIONAL LLM soft-reranker over the admissible survivors (chooser/reviewer
   *  knobs, `QUANTA_BENCH_LLM_SELECT`). Absent ⇒ deterministic vote only
   *  (byte-identical). Never-veto / fail-open (see acceptance-select). */
  llmRerank?: AcceptanceLlmRerank,
  /** OPTIONAL observe-only tier-readout sink — called per repair round with the
   *  winning rerank tier (operator selection telemetry). Absent ⇒ no telemetry. */
  onSelection?: AcceptanceSelectionObserver,
) =>
  buildReproAcceptanceSelector(enabled, reproSources, {
    withCandidatePatch: (patch, probe) =>
      withCandidatePatch({
        sandbox,
        patch,
        baseCommit: instance.swebench?.baseCommit,
        timeoutMs,
        ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
        probe,
      }),
    ...(llmRerank !== undefined ? { llmRerank } : {}),
    reproResolvedOnSandbox: async (sb) => {
      const samples = await executeReproTests({
        tests: reproSources,
        repoRoot: sb,
        ...reproExecBundle(instance),
      })
      return voteResolved(samples).verdict === "resolved"
    },
    // #3 Agentless-parity vote-key dedup (QUANTA_BENCH_VOTE_NORMALIZE): stronger
    // key so comment/blank/whitespace variants reinforce the majority instead of
    // splitting it. OFF ⇒ undefined ⇒ raw-trim key (byte-identical).
    ...(gateOn(process.env, "QUANTA_BENCH_VOTE_NORMALIZE")
      ? { normalizePatch: strongVoteKey }
      : {}),
    // Dual-guard regression probe (only when a regression set was supplied): run it
    // on the patched tree and count failures (ran && !pass ⇒ failed.length, else 0).
    ...(regressionSet !== undefined && regressionSet.length > 0
      ? {
          regressionFailuresOnSandbox: async (sb: string): Promise<number> => {
            const buildArgv = buildProjectPytestArgv(
              instance.swebench?.repo,
              instance.swebench?.version,
            )
            const r = await makeBenchRegressionOracle(buildArgv, {
              ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
            }).run({ tests: regressionSet, sandbox: sb, timeoutMs })
            return regressionFailureCount(r)
          },
        }
      : {}),
    ...(onSelection !== undefined ? { onSelection } : {}),
  })

/**
 * Strategy #2 — Agentless-style sampling diversity for the repair-breadth fanout.
 * Wraps a candidate's lane port so candidate 0 stays greedy (unwrapped ⇒
 * byte-identical) and candidates ≥1 sample at temperature 0.8
 * ({@link sampleTemperatureForCandidate}). Gated by `QUANTA_BENCH_SAMPLE_TEMP`
 * (OFF ⇒ base port ⇒ byte-identical). SHARED by both drivers. Composition at the
 * wiring layer — repair-breadth + the LLM loop stay untouched.
 */
export const applySampleTemperature = (base: LLMPort, index: number): LLMPort => {
  if (!gateOn(process.env, "QUANTA_BENCH_SAMPLE_TEMP")) return base
  // Model-capability guard: OpenAI reasoning models (o-series / GPT-5) 400 on a
  // `temperature` field, so the knob NO-OPS (greedy lanes) on them rather than
  // collapsing the breadth fanout to failed forks. Sampling diversity needs a
  // sampling-capable model (Claude / GPT-4o). The "sampling-capable lanes only"
  // contract is now ENFORCED here, not just documented at the wire.
  if (!modelSupportsSamplingTemperature(base.model ?? "")) return base
  const t = sampleTemperatureForCandidate(index)
  return t === undefined ? base : withTemperature(base, t)
}

/**
 * Strategy #6 — observe-only submission review (SWE-agent `review_on_submit`
 * deterministic check). When `QUANTA_BENCH_SUBMIT_REVIEW` is on, classify the final
 * captured patch (clean / empty / test-edits) for telemetry + as a strip-regression
 * sentinel (the test-revert itself is already unconditional via `sourceOnlyDiff`).
 * OFF ⇒ `undefined` ⇒ nothing attached ⇒ byte-identical.
 */
export const maybeReviewSubmission = (patch: string): SubmissionReview | undefined =>
  gateOn(process.env, "QUANTA_BENCH_SUBMIT_REVIEW") ? reviewSubmission(patch) : undefined

/**
 * Strategy #7 — resolve the optional per-candidate location-set seeder from the
 * preset/env-projected bench posture. OFF / no localizer files / <2 files /
 * breadth≤1 ⇒ `undefined` ⇒ every breadth candidate uses the base seed
 * (byte-identical). SHARED by both drivers. Pure (built from the localizer's
 * ranked files only — no-leak).
 */
export const resolveLocationFanoutSeeder = (
  enabled: boolean,
  rankedFiles: readonly string[],
  breadth: number,
  issueSymbols: readonly string[] = [],
): PerCandidateSeed | undefined => {
  if (!enabled || breadth <= 1) return undefined
  return buildLocationSeeder(rankedFiles, breadth, issueSymbols)
}

/**
 * Resolve the optional LLM acceptance soft-reranker from `QUANTA_BENCH_LLM_SELECT`
 * (chooser/reviewer). Unset/invalid ⇒ `undefined` ⇒ deterministic vote only
 * (byte-identical). SHARED by both drivers so the knob behaves identically.
 */
export const resolveAcceptanceLlmRerank = (
  instance: Instance,
  llm: LLMPort,
  signal?: AbortSignal,
): AcceptanceLlmRerank | undefined => {
  const mode = resolveLlmSelectMode(process.env)
  if (mode === undefined) return undefined
  return buildLlmRerankFromPort({
    llm,
    problemStatement: instance.problemStatement,
    mode,
    ...(signal !== undefined ? { signal } : {}),
  })
}

/**
 * SOTA++ verify-and-select — repro-vote as the candidate SELECTION scorer.
 *
 * Builds the selection executor's `resolvedKofN` port: for each candidate patch,
 * RE-MATERIALIZE its tree (reset → `git apply` → probe → reset, via
 * {@link withCandidatePatch} — the anti-theater seam so the consensus measures
 * THIS candidate, not the shared/base tree) and re-run the REPRODUCING repro set
 * there, projecting the resolved-majority into the VerificationBundle's
 * `patchedResolvedKofN` HARD signal. So the OUTER selection picks the candidate
 * the repro set actually reports as RESOLVED: the inner repro-vote becomes the
 * outer selection's verification signal (generate N → verify each by the vote →
 * select the consensus-resolved winner).
 *
 * FAIL-OPEN: an empty reproducing set ⇒ a port that always yields `null` (no
 * consensus objection, the bundle never rejects on a missing signal); a
 * non-applying candidate patch ⇒ `withCandidatePatch` returns `null`.
 */
export const makeReproConsensusSelectionPort = (
  instance: Instance,
  reproSources: readonly string[],
  sandbox: string,
  timeoutMs: number,
): ((c: Candidate) => Promise<{ votes: number; k: number } | null>) => {
  if (reproSources.length === 0) return () => Promise.resolve(null)
  const probe = makePatchedResolvedConsensus({
    sources: reproSources,
    ...reproExecBundle(instance),
  })
  return (c) =>
    withCandidatePatch<{ votes: number; k: number } | null>({
      sandbox,
      patch: c.patch,
      baseCommit: instance.swebench?.baseCommit,
      ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
      timeoutMs,
      probe: (sb) => probe(sb),
    })
}

export const makeReproConsensusProofSelectionPort = (
  instance: Instance,
  reproSources: readonly string[],
  sandbox: string,
  timeoutMs: number,
) => {
  const probe = makePatchedResolvedConsensusProof({
    sources: reproSources,
    ...reproExecBundle(instance),
  })
  return (c: Candidate) =>
    withCandidatePatch({
      sandbox,
      patch: c.patch,
      baseCommit: instance.swebench?.baseCommit,
      ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
      timeoutMs,
      probe: (sb) => probe(sb),
    })
}

/**
 * EVAL-ONLY DIAGNOSTIC — the GOLD-CALIBRATED repro-consensus selection port (NOT a
 * production solving capability; gold is absent on live tasks ⇒ inert off-bench).
 * Same selection signal as {@link makeReproConsensusSelectionPort}, but FIRST
 * calibrates the consensus oracle against the gold patch ({@link calibrateReproOracle}):
 * if the oracle is a CONFIRMED false negative (says "not resolved" on the
 * known-correct gold fix), the returned port FAILS OPEN (always `null`) so a
 * proven-unreliable oracle can never REJECT a correct candidate — the convergent
 * root-cause (jun-20: ~75–79% of misses are "right place, fix unrecognized by the
 * oracle"). Returns the calibration alongside for eval-only telemetry so a campaign
 * self-measures the false-negative rate with no extra runs.
 *
 * ⚠️ ASYMMETRIC: fail-open removes a false-RED, it does NOT add a true-GREEN — with
 * `resolvedKofN` nulled, selection degrades to the weak minimality+ownerCoverage
 * signals, so the correct candidate may still lose to a wrong sibling. This guard
 * stops the oracle DISCARDING a correct fix; it does not PICK one.
 *
 * EVAL-ONLY boundary: the gold patch is the dataset reference, the same boundary the
 * closure oracle's gold files use — never handed to the agent loop (audit-verified:
 * no `goldPatch` reaches `src/agent`). The calibration mutates the sandbox
 * (reset → gold → reset, via withCandidatePatch) but leaves it at base, so it MUST
 * run before the candidate-generation loop.
 */
export const makeCalibratedReproConsensusPort = async (
  instance: Instance,
  reproSources: readonly string[],
  sandbox: string,
  timeoutMs: number,
): Promise<{
  port: (c: Candidate) => Promise<{ votes: number; k: number } | null>
  calibration: ReproOracleCalibration
}> => {
  const base = makeReproConsensusSelectionPort(instance, reproSources, sandbox, timeoutMs)
  if (reproSources.length === 0) {
    return { port: base, calibration: unavailableReproOracleCalibration() }
  }
  const probe = makePatchedResolvedConsensus({
    sources: reproSources,
    ...reproExecBundle(instance),
  })
  const calibration = await calibrateReproOracle({
    resolvedProbe: probe,
    goldPatch: instance.goldPatch,
    sandbox,
    baseCommit: instance.swebench?.baseCommit,
    ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
    timeoutMs,
  })
  // A confirmed-false-negative oracle must NEVER reject a candidate ⇒ fail-open.
  const port = calibration.falseNegative ? () => Promise.resolve(null) : base
  return { port, calibration }
}
