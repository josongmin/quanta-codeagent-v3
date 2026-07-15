/**
 * Shared REPAIR-ROUNDS phase LIBRARY (pure code motion from `driver.ts`,
 * byte-identical). Owns the repair-loop BREADTH candidate factory
 * (`buildRepairBreadthRunCandidates`) and the in-snapshot repair-rounds runner
 * (`runRepairRoundsInSnapshot`) — ONE `withGitSnapshot` wraps ALL rounds
 * (continue-from-patched-tree), the official `verify()` runs ONCE outside on the
 * cumulative patch (no-leak). The sole per-instance orchestrator that CALLS
 * these helpers is the app driver (`src/apps/bench/eval/driver.ts`); the runner
 * core is now purely the shared library. Depends on the extracted agent-phase /
 * selection / port-factory modules + `./context-types`.
 */

import type { extractIssueHint } from "@/agent"
import type { PrimaryRailStep } from "@/agent/closure"
import type { OwnerCritic } from "@/agent/observation/critic"
import { lspOwnerRefuter } from "@/agent/observation/critic/lsp-refuter"
import { makeOwnerCritic } from "@/agent/observation/critic/owner-critic"
import { logger } from "@/shared"
import type { Instance } from "../../types"
import type { ChaRepairTarget } from "../cha-multisite"
import { diffTouchedSymbols } from "../diff-touched-symbols"
import { exec } from "../exec"
import { coeditFamilyCoverageCandidate } from "../family-coverage-coedit"
import type { BenchPosture } from "../knobs-bench"
import {
  type LlmEvidenceArtifacts,
  recordLlmEvidencePacket,
  type VerificationTargetFact,
} from "../llm-evidence-packet"
import type { PerCandidateSeed } from "../location-set-fanout"
import { applyCandidatePatch, materializeBuildEnv, resetToBase } from "../rematerialize"
import { writeCandidatePool } from "../repair/candidate-ledger-sink"
import { runRepairRounds } from "../repair/index"
import { buildRepairRoundSeedMessage } from "../repair/llm-evidence"
import { buildRepairRoundsConfig, makeRepairBreadthRunCandidates } from "../repair-breadth"
import { emitSandbox, type Wiring } from "../report"
import { cleanupSandbox, forkSandbox } from "../sandbox"
import type { Candidate } from "../selection-executor"
import { filesFromPatch } from "../selection-paths"
import { withGitSnapshot } from "../snapshot"
import { deriveCandidateStructuralRepair } from "./candidate-family-ports"
import { type CriticRefuteSummary, type RunInstanceDeps, readSandboxSource } from "./context-types"
import { familyCoverageCoeditEnabled, resolveLaneLlm } from "./selection-phase"
import {
  applySampleTemperature,
  type makeAcceptanceSelectCandidates,
} from "./selection-port-factories"

/** jul-6 S1 — observe-only OwnerCritic pass over a repair's captured patch. Default-OFF
 *  (`enabled=false` ⇒ undefined ⇒ the Phase is byte-identical). Fail-open: any error is
 *  logged and swallowed to undefined — the critic is telemetry and MUST NEVER break the
 *  repair phase. Runs the LSP-backed critic over each (file × symbol) the patch edits and
 *  records only the ones the callgraph could POSITIVELY refute (wrong-owner signal for the
 *  critic_saved_edit_rate A/B). The refuter is itself abs-path-safe + abort-bounded. */
export const maybeCriticRefute = async (args: {
  readonly enabled: boolean
  readonly patch: string
  readonly cwd: string
  readonly issueText: string
  readonly signal: AbortSignal
  /** Test seam — inject a critic; production builds the LSP-backed one from `cwd`. */
  readonly critic?: OwnerCritic
}): Promise<CriticRefuteSummary | undefined> => {
  if (!args.enabled || args.patch === "") return undefined
  try {
    const critic = args.critic ?? makeOwnerCritic(lspOwnerRefuter(args.cwd))
    const files = filesFromPatch(args.patch)
    const symbols = diffTouchedSymbols(args.patch)
    const refuted: { file: string; symbol: string; reason: string }[] = []
    let checked = 0
    for (const file of files) {
      for (const symbol of symbols) {
        if (args.signal.aborted) return { refuted, checked }
        checked++
        const r = await critic.refute(
          { file, symbol },
          { cwd: args.cwd, issueText: args.issueText, repoFiles: [] },
        )
        if (r.verdict === "refuted") refuted.push({ file, symbol, reason: r.reason })
      }
    }
    return { refuted, checked }
  } catch (e) {
    logger.warn("observation: owner-critic pass failed (observe-only, ignored)", {
      error: e instanceof Error ? e.message : String(e),
    })
    return undefined
  }
}

/**
 * Repair-path phase: ONE `withGitSnapshot` wraps ALL rounds (so the prior
 * round's edits persist into round N+1 — no `git reset/clean` between rounds).
 * The official `verify()` is NEVER invoked here — it runs ONCE outside, on the
 * cumulative final patch (no-leak invariant). The validator/buildContext are
 * injectable; production defaults are G1's `validate`/`buildRepairContext`.
 */
/** Shared repair-loop BREADTH candidate factory (jun-28). Both bench drivers
 *  (this runner core + `apps/bench/eval/driver.ts`) build the SAME B>1 fan-out
 *  here; the ONLY per-driver divergence — how a forked round runs the agent
 *  (the runner threads `chaMultisiteSteer`, the app does not) — is injected as
 *  `runAgentOnFork`. B≤1 ⇒ undefined ⇒ the orchestrator takes the legacy single
 *  path (byte-identical). Derives its types from `makeRepairBreadthRunCandidates`
 *  so the seam can never silently drift from the breadth contract. */
type RepairBreadthDeps = Parameters<typeof makeRepairBreadthRunCandidates>[0]
export const buildRepairBreadthRunCandidates = (args: {
  instance: Instance
  deps: RunInstanceDeps
  sandbox: string
  signal: AbortSignal
  repairPosture: BenchPosture
  repairBreadth: number
  validate: RepairBreadthDeps["validate"]
  repairEvaluatePredicate: RepairBreadthDeps["validateInputs"]["evaluatePredicate"]
  primaryRailStep: PrimaryRailStep | undefined
  chaRepairTargets: readonly ChaRepairTarget[] | undefined
  perCandidateSeed: PerCandidateSeed | undefined
  runAgentOnFork: RepairBreadthDeps["runAgentOnFork"]
}): ReturnType<typeof makeRepairBreadthRunCandidates> | undefined => {
  if (args.repairBreadth <= 1) return undefined
  return makeRepairBreadthRunCandidates({
    instanceId: args.instance.id,
    mainSandbox: args.sandbox,
    baseCommit: args.instance.swebench?.baseCommit,
    repo: args.instance.swebench?.repo,
    timeoutMs: args.deps.timeoutMs,
    resolveLaneLlm: (index) =>
      applySampleTemperature(
        resolveLaneLlm(args.deps, args.repairPosture.modelLaneDiversity, index),
        index,
      ),
    runAgentOnFork: args.runAgentOnFork,
    validate: args.validate,
    validateInputs: {
      exec,
      timeoutMs: args.deps.timeoutMs,
      readFile: async (path: string): Promise<string> => Bun.file(path).text(),
      evaluatePredicate: args.repairEvaluatePredicate,
      ...(args.primaryRailStep !== undefined ? { primaryRailStep: args.primaryRailStep } : {}),
    },
    sandboxPorts: { forkSandbox, cleanupSandbox },
    gitPorts: { resetToBase, applyCandidatePatch, materializeBuildEnv },
    // jun-29 OBSERVE-ONLY pool capture: when a run artifact root exists, persist
    // the FULL candidate pool per round (decision impact 0). Absent ⇒ no sink ⇒
    // byte-identical.
    ...(args.deps.reproArtifactRootPath !== undefined
      ? {
          recordCandidates: (round, candidates) =>
            writeCandidatePool(
              args.deps.reproArtifactRootPath as string,
              args.instance.id,
              round,
              candidates,
            ),
        }
      : {}),
    ...(args.repairPosture.selectorMode === "clean"
      ? {
          deriveCandidateStructuralRepair: (candidate: Candidate, candidateSandbox: string) =>
            deriveCandidateStructuralRepair({
              instance: args.instance,
              candidate,
              sandbox: candidateSandbox,
              signal: args.signal,
              ...(args.chaRepairTargets !== undefined
                ? { preferredTargets: args.chaRepairTargets }
                : {}),
            }),
        }
      : {}),
    ...(args.repairPosture.selectorMode === "clean" && familyCoverageCoeditEnabled(process.env)
      ? {
          repairFamilyCoverage: ({ sandbox: candidateSandbox, candidate, family, missingFiles }) =>
            coeditFamilyCoverageCandidate({
              sandbox: candidateSandbox,
              candidate,
              family,
              missingFiles,
              timeoutMs: args.deps.timeoutMs,
              baseCommit: args.instance.swebench?.baseCommit,
              repo: args.instance.swebench?.repo,
              ...(args.chaRepairTargets !== undefined
                ? { preferredTargets: args.chaRepairTargets }
                : {}),
            }),
        }
      : {}),
    // #7 location-set fanout: per-candidate lead-file seed (OFF ⇒ undefined ⇒
    // shared base seed ⇒ byte-identical).
    ...(args.perCandidateSeed !== undefined ? { perCandidateSeed: args.perCandidateSeed } : {}),
  })
}

/** Shared repair-round orchestration inside a git snapshot (jun-28). Both bench
 *  drivers run the SAME `runRepairRounds` here — owner-evidence seed assembly,
 *  acceptance/breadth wiring, repro-rail readFile. The ONLY per-driver divergence
 *  (the runner threads `chaMultisiteSteer` into the per-round agent, the app does
 *  not) is injected as `runOnce`. Returns the snapshot's final diff plus the raw
 *  rounds result so the caller derives the Phase verdict (no closure mutation). */
export const runRepairRoundsInSnapshot = async (args: {
  instance: Instance
  deps: RunInstanceDeps
  sandbox: string
  w: Wiring
  repair: NonNullable<RunInstanceDeps["repair"]>
  repairPosture: BenchPosture
  repairBreadth: number
  validate: RepairBreadthDeps["validate"]
  repairEvaluatePredicate: RepairBreadthDeps["validateInputs"]["evaluatePredicate"]
  primaryRailStep: PrimaryRailStep | undefined
  runCandidates: ReturnType<typeof makeRepairBreadthRunCandidates> | undefined
  acceptanceSelectCandidates: ReturnType<typeof makeAcceptanceSelectCandidates>
  siblingOwners: readonly string[]
  repairIssueSymbols: ReturnType<typeof extractIssueHint>["symbols"]
  verificationTarget: VerificationTargetFact | undefined
  repairLlmEvidence: Partial<LlmEvidenceArtifacts>
  runOnce: Parameters<typeof runRepairRounds>[0]["runOnce"]
}): Promise<{ patch: string; out: Awaited<ReturnType<typeof runRepairRounds>> }> => {
  let captured: Awaited<ReturnType<typeof runRepairRounds>> | undefined
  const patch = await withGitSnapshot(
    args.sandbox,
    args.deps.timeoutMs,
    args.instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(
        args.w.observer,
        args.sandbox,
        args.instance.swebench?.baseCommit,
        args.deps.timeoutMs,
      )
      captured = await runRepairRounds({
        config: buildRepairRoundsConfig(
          args.repair.maxRounds,
          args.repairBreadth,
          args.repairPosture.repairStrongOracle,
        ),
        problem: args.instance.problemStatement,
        runOnce: args.runOnce,
        validate: args.validate,
        buildContext: (ctxArgs) => {
          const repairArgs = {
            ...ctxArgs,
            siblingOwners: args.siblingOwners,
            issueSymbols: args.repairIssueSymbols,
            readSource: (rel: string) => readSandboxSource(args.sandbox, rel),
            ...(args.verificationTarget !== undefined
              ? { verificationTarget: args.verificationTarget }
              : {}),
          }
          const repairSeed = buildRepairRoundSeedMessage(
            repairArgs,
            args.repair.buildContext?.(repairArgs),
          )
          recordLlmEvidencePacket(args.repairLlmEvidence, repairSeed.packet)
          return repairSeed.seedMsg
        },
        sandbox: args.sandbox,
        exec,
        readFile: async (path: string): Promise<string> => Bun.file(path).text(),
        timeoutMs: args.deps.timeoutMs,
        evaluatePredicate: args.repairEvaluatePredicate,
        ...(args.primaryRailStep !== undefined ? { primaryRailStep: args.primaryRailStep } : {}),
        // jun-28 BREADTH: present only when B>1 (else undefined ⇒ legacy single path).
        ...(args.runCandidates !== undefined ? { runCandidates: args.runCandidates } : {}),
        // jun-28 SOTA++ acceptance: present only when opt-in is on + a repro set exists.
        ...(args.acceptanceSelectCandidates !== undefined
          ? { selectCandidates: args.acceptanceSelectCandidates }
          : {}),
      })
    },
    args.instance.swebench?.repo,
  )
  // withGitSnapshot always invokes the callback, so `captured` is set; guard
  // defensively so a future refactor that changes that contract fails loudly.
  if (captured === undefined) throw new Error("runRepairRounds did not execute in snapshot")
  return { patch, out: captured }
}
