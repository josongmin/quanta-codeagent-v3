import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type AgentConfig, type AgentOutcome, runAgent, wireOptionalAgentPorts } from "@/agent"
import { evaluateSuccessPredicate, type PrimaryRailStep, resolveOwnerSiblings } from "@/agent/closure"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { analyzePatchBudget } from "@/agent/patch-budget"
import { decideEscalation } from "@/agent/repair-escalation"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import type { LLMPort, Message } from "@/llm"
import type { CapabilityManifest, SessionEvent } from "@/protocol/session"
import { buildClosureSession, buildPhasePatchHygiene } from "@/runner/batch/eval/closure-session"
import {
  applyBenchKnobs,
  type BenchKnobState,
  BenchObserver,
  type BenchPosture,
  benchOptIns,
  buildReproVoteValidate,
  buildConfig as buildRunnerConfig,
  composeWithReproHint,
  DEFAULT_POLICY,
  enumerateRepoSources,
  type IssueHintMode,
  knobsForReport,
  makeCalibratedReproConsensusPort,
  makeReproConsensusSelectionPort,
  type PrepareIssueHintDeps,
  type PrepareReproTestDeps,
  parseBenchBranchSearchK,
  parseBenchReproTestK,
  parseLocalizePhaseEnv,
  prepareIssueHint,
  prepareReproTest,
  prepareReproTestDetailed,
  projectOutcome,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
  runRetryLoop,
  type RunInstanceDeps as SharedRunInstanceDeps,
  UsageTap,
} from "@/runner/batch/eval/driver"
import { validateGoldPatch } from "@/runner/batch/eval/gold-sanity"
import { toRegressionGreen } from "@/runner/batch/eval/regression-oracle"
import { withCandidatePatch } from "@/runner/batch/eval/rematerialize"
import {
  benchInstallsReproHint,
  benchRunsRepairPhase,
  benchShouldRunRepairPhase,
  primaryRailRedAfterRepair,
} from "@/runner/batch/eval/repair-phase-policy"
import {
  type Candidate,
  runSelection,
  type SelectionTelemetry,
  summarizeSelection,
} from "@/runner/batch/eval/selection-executor"
import { BenchStreamTap, relFromSandbox } from "@/runner/batch/eval/stream-tap"
import { createTentativeRecorder } from "@/runner/batch/eval/tentative-patch"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import { errMessage, gateDisabled } from "@/shared"
import type {
  BenchReproTestTelemetry,
  Instance,
  InstanceResult,
  ReproOracleCalibration,
} from "../types"
import { runEnvPrep } from "./env-prep"
import { exec } from "./exec"
import { makeBenchRegressionOracle } from "./regression-oracle-adapter"
import { buildRepairContext } from "./repair/context"
import { runRepairRounds } from "./repair/index"
import type { RunOnceResult } from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import { makeDiscoveredRepoRegressionPort } from "./repo-regression-discovery-adapter"
import {
  buildWiring,
  emitPatch,
  emitSandbox,
  emitVerify,
  NullStream,
  ObservationError,
  type Wiring,
} from "./report"
import { cleanupSandbox, copyRepo, createSandbox, forkSandbox } from "./sandbox"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"
import { verify } from "./verdict"

export type { BenchKnobState, IssueHintMode, PrepareIssueHintDeps, PrepareReproTestDeps }
export {
  applyBenchKnobs,
  BenchObserver,
  benchInstallsReproHint,
  benchOptIns,
  benchRunsRepairPhase,
  buildRunnerConfig as buildConfig,
  composeWithReproHint,
  enumerateRepoSources,
  knobsForReport,
  parseBenchBranchSearchK,
  parseBenchReproTestK,
  parseLocalizePhaseEnv,
  prepareIssueHint,
  prepareReproTest,
  prepareReproTestDetailed,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
  UsageTap,
}

export interface RunInstanceDeps extends SharedRunInstanceDeps {
  readonly runtimeFactory?: typeof createRuntime
}

const capabilityManifestForConfig = (config: AgentConfig): CapabilityManifest => ({
  approvals: "none",
  tools: true,
  memory: false,
  artifacts: false,
  subagents: config.subagent !== undefined,
  automation: false,
  shellSnapshot: false,
  transport: "inproc",
})

const promptTextFromMessages = (messages: readonly Message[]): string => {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    if (text !== "") return text
  }
  return ""
}

const createBenchSessionHost = (config: AgentConfig): SessionHost => {
  const wiredConfig = wireOptionalAgentPorts(config, process.env)
  const sessionId = `bench-${crypto.randomUUID()}`
  // ADR-0334 — bench passes EMPTY deps so the install is a no-op
  // (byte-identical replay). The call site is recorded so a future
  // bench-determinism audit can opt deps in via a single edit.
  installCodexR2Wires(wiredConfig, {})
  return {
    describe: () => ({
      sessionId,
      permissionMode: wiredConfig.permission.mode,
      capabilityManifest: capabilityManifestForConfig(wiredConfig),
      identityMode: "default",
      toolProfile: "write",
    }),
    runTurn: async ({ signal }) => {
      const result = await runAgent({
        ...wiredConfig,
        ...(signal !== undefined ? { signal } : {}),
      })
      return { outcome: result, messages: result.messages }
    },
    close: async () => undefined,
  }
}

const captureBenchSessionEvents = (
  listenerPort: Pick<RuntimeSession, "subscribe">,
): {
  readonly events: SessionEvent[]
  readonly unsubscribe: () => void
} => {
  const events: SessionEvent[] = []
  const unsubscribe = listenerPort.subscribe((event) => {
    events.push(event)
  })
  return { events, unsubscribe }
}

const lastTerminalTurnEventOf = (
  events: readonly SessionEvent[],
): Extract<SessionEvent, { type: "turn.completed" | "turn.failed" }> | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === "turn.completed" || event?.type === "turn.failed") return event
  }
  return undefined
}

const runAgentViaSdk = async (
  config: AgentConfig,
  runtimeFactory: typeof createRuntime = createRuntime,
): Promise<AgentOutcome> => {
  const hostSession = createBenchSessionHost(config)
  const runtimeOptions = {
    host: createSingleSessionRuntimeHost(() => hostSession),
  } satisfies Parameters<typeof createRuntime>[0]
  const runtime =
    runtimeFactory === createRuntime
      ? await createRuntime(runtimeOptions)
      : await runtimeFactory(runtimeOptions)
  let session: Awaited<ReturnType<typeof runtime.createSession>> | undefined
  let unsubscribe: (() => void) | undefined
  try {
    const model = (config.llm as { model?: string }).model
    session = await runtime.createSession({
      cwd: config.cwd,
      ...(model !== undefined ? { model } : {}),
      permissionMode: config.permission.mode,
      identityMode: "default",
      toolProfile: "write",
    })
    const eventCapture = captureBenchSessionEvents(session)
    unsubscribe = eventCapture.unsubscribe
    await session.input.append(promptTextFromMessages(config.messages), undefined, {
      signal: config.signal,
    })
    const turn = await session.turn.run(undefined, { signal: config.signal })
    const outcome = turn.turn?.outcome
    if (outcome === undefined) {
      // The session ended without a turn outcome — almost always a deadline/cancel
      // abort MID-turn (e.g. #10097: SIGTERM during an LLM continuation at turn 50).
      // The agent has usually already edited the sandbox, so throwing here would
      // discard a real partial patch and surface as `harness_error:empty_patch`.
      // Instead synthesize a minimal `aborted` outcome: the caller's
      // `withGitSnapshot` still captures the sandbox diff as the candidate patch,
      // and the result is an honest `aborted` (not a misleading hard error).
      const turns = eventCapture.events.filter(
        (e) => e.type === "turn.completed" || e.type === "turn.failed",
      ).length
      return { reason: "aborted", turns, messages: [] }
    }
    const terminalEvent = lastTerminalTurnEventOf(eventCapture.events)
    if (terminalEvent === undefined) {
      throw new Error("bench SDK session completed without a terminal session event")
    }
    if (terminalEvent.type === "turn.completed" && terminalEvent.outcomeReason !== outcome.reason) {
      throw new Error("bench SDK outcome/session event mismatch")
    }
    return outcome
  } finally {
    unsubscribe?.()
    await session?.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
  }
}

interface InstallReproTestResult {
  readonly hint: string | undefined
  readonly telemetry: BenchReproTestTelemetry | undefined
  /** #2 repro-vote: scripts that REPRODUCED on the un-patched tree — re-run +
   *  majority-voted by the K-of-N RESOLVED gate when `repro-vote` is on. */
  readonly reproSources?: readonly string[]
}

const writeFailedTelemetry = (base: BenchReproTestTelemetry): BenchReproTestTelemetry => ({
  installed: false,
  reason: "write_failed",
  ...(base.samples !== undefined ? { samples: base.samples } : {}),
  ...(base.reproducedCount !== undefined ? { reproducedCount: base.reproducedCount } : {}),
})

const installReproTestHint = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
): Promise<InstallReproTestResult> => {
  // Unified posture: K resolves from the preset/env via the knob framework
  // (preset `agentless-v1` ⇒ K=5; explicit QUANTA_BENCH_REPRO_TEST overrides).
  const reproK = benchOptIns().reproTestK
  if (reproK === undefined) return { hint: undefined, telemetry: undefined }
  const preparation = await prepareReproTestDetailed(instance, sandbox, reproK, { llm })
  const { selection, telemetry } = preparation
  if (selection === null || selection.selected === null) return { hint: undefined, telemetry }
  // #2 repro-vote: keep EVERY reproducing script for the validation-time vote.
  const reproSources = selection.samples
    .filter((s) => s.outcome === "reproduced")
    .map((s) => s.source)
  const path = `${sandbox}/${REPRO_FILE_NAME}`
  try {
    await Bun.write(path, selection.selected)
    return {
      hint: REPRO_HINT_MESSAGE,
      reproSources,
      telemetry: {
        installed: true,
        path,
        samples: selection.samples.length,
        reproducedCount: selection.reproducedCount,
      },
    }
  } catch (_writeErr) {
    return { hint: undefined, reproSources, telemetry: writeFailedTelemetry(telemetry) }
  }
}

interface Phase {
  patch: string
  turns: number
  stopReason?: AgentOutcome["reason"]
  agentError?: string
  /** T-202/F6 stream-tap signals (single-pass path only). */
  firstEditFile?: string
  editCount?: number
  turnsToFirstEdit?: number
  /** T-601 — did a repair round clear the (primary-rail) validator? Repair path
   *  only; undefined on single-pass. Derives `primaryRailRedAfterRepair`. */
  validated?: boolean
  /** T-3 OBSERVE-ONLY — clearing round went green on exit code while its typed
   *  rail predicate was evaluable AND mismatched (the false green a
   *  predicate-aware gate would catch). Repair path only. */
  primaryFalseGreen?: boolean
  /** jun-18 RCA OBSERVE-ONLY — a repair round's rail (exit-code) rejected a patch
   *  the repro sentinel reports resolved (false-RED ⇒ wasteful churn). Repair only. */
  primaryFalseRed?: boolean
  verifyRounds?: number
  /** jun-20 — repro-oracle gold calibration for this verify-select run (eval-only
   *  telemetry). Set by the selection phase; undefined on single-pass/repair. */
  reproOracleCalibration?: ReproOracleCalibration
  /** jun-20 — verify-select winner/candidate telemetry (eval-only). Lets a run
   *  self-diagnose which fix sites were spanned, which candidates were
   *  admissible, and why the winner won without re-parsing trajectories. */
  selectionTelemetry?: SelectionTelemetry
}

// Bench stream tap is the SSOT in `@/runner/batch/eval/stream-tap` — imported
// above. This prod wrapper and the runner core share the one definition
// (they previously each carried a drifting private copy).

const runAgentOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  seedMsg: string | undefined,
  timeoutMs: number,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
): Promise<RunOnceResult> => {
  const tap = new BenchStreamTap(w.stream)
  const outcome = await runAgentViaSdk(
    buildRunnerConfig(
      instance,
      deps,
      sandbox,
      signal,
      tap,
      seedMsg,
      precomputedHint,
      reproHint,
      closureHint,
    ),
    deps.runtimeFactory,
  )
  const patch = await gitStageAndDiffCached(sandbox, timeoutMs)
  return {
    patch,
    turns: outcome.turns,
    ...(tap.lastVerifyCmd !== undefined ? { lastVerifyCmd: tap.lastVerifyCmd } : {}),
  }
}

const runAgentPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
): Promise<Phase> => {
  let turns = 0
  let stopReason: AgentOutcome["reason"] | undefined
  let agentError: string | undefined
  let firstEditFile: string | undefined
  let editCount: number | undefined
  let turnsToFirstEdit: number | undefined
  // P0 — tentative-patch retention (Sonar absorption). When ON, snapshot the
  // sandbox diff each time the agent's OWN verification passes; on a bad ending
  // (max_turns / aborted — `stopReason !== "completed"`) emit the last
  // verified-green snapshot instead of the empty/regressed final tree. Snapshots
  // run on a serialized best-effort chain (never throw past the run). OFF (or
  // non-swebench) ⇒ no `onVerifyPass` wired ⇒ tap + patch byte-identical.
  // DEFAULT-ON (2026-06-20): pure safety-net — A/B on the 5 max_turns-prone set
  // showed ON==OFF (2/5 each, identical instances) ⇒ regression==0, and the
  // mechanism is proven to fire correctly in a real run (pylint-4604 recovered a
  // verified 444B candidate over a 640B max_turns final). Per the safety-net
  // rule it ships ON the moment regression==0 is confirmed. Off-switch
  // `QUANTA_BENCH_TENTATIVE=0`. Single-pass path only (repair-path is a follow-up).
  const tentativeOn =
    instance.swebench !== undefined && !gateDisabled(process.env, "QUANTA_BENCH_TENTATIVE")
  const recorder = createTentativeRecorder()
  let snapChain: Promise<void> = Promise.resolve()
  const onVerifyPass = tentativeOn
    ? (seq: number): void => {
        snapChain = snapChain.then(async () => {
          try {
            recorder.record(await gitStageAndDiffCached(sandbox, deps.timeoutMs), true, seq)
          } catch {
            /* best-effort: a failed mid-run snapshot must never break the run */
          }
        })
      }
    : undefined
  const rawPatch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const tap = new BenchStreamTap(w.stream, onVerifyPass)
      const outcome = await runAgentViaSdk(
        buildRunnerConfig(
          instance,
          deps,
          sandbox,
          signal,
          tap,
          undefined,
          precomputedHint,
          reproHint,
          closureHint,
        ),
        deps.runtimeFactory,
      )
      turns = outcome.turns
      stopReason = outcome.reason
      agentError = tap.lastErrorMessage
      firstEditFile = relFromSandbox(sandbox, tap.firstEditFile)
      editCount = tap.editCount
      turnsToFirstEdit = tap.turnsToFirstEdit
    },
  )
  // Drain any in-flight snapshots, then select what to emit. `finalOk` = the
  // agent declared done cleanly; any other reason is the "ran out mid-validate"
  // case the retention targets.
  await snapChain
  const patch = tentativeOn
    ? recorder.selectEmitted(rawPatch, stopReason === "completed")
    : rawPatch
  if (tentativeOn && patch !== rawPatch) {
    // P0 telemetry — log ONLY when retention actually substitutes (the rare,
    // interesting case): the run ended badly and we recovered a verified-green
    // intermediate over the empty/regressed final tree.
    console.error(
      `[tentative] ${instance.id}: ENGAGED — emitted verified candidate ` +
        `(${recorder.count} recorded, stopReason=${stopReason}) ` +
        `${patch.length}B over ${rawPatch.length}B final`,
    )
  }
  return {
    patch,
    turns,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(agentError !== undefined ? { agentError } : {}),
    ...(firstEditFile !== undefined ? { firstEditFile } : {}),
    ...(editCount !== undefined ? { editCount } : {}),
    ...(turnsToFirstEdit !== undefined ? { turnsToFirstEdit } : {}),
  }
}

const runRepairPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  repair: NonNullable<RunInstanceDeps["repair"]>,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  primaryRailStep: PrimaryRailStep | undefined,
  siblingOwners: readonly string[],
  reproSources: readonly string[],
): Promise<Phase> => {
  let turns = 0
  let finalPatch = ""
  let repairValidated = false
  let repairFalseGreen = false
  let repairFalseRed = false
  let repairRounds = 0
  // #2 repro-vote: K-of-N RESOLVED majority gate when the knob is on AND a
  // reproducing set exists; else byte-identical `repair.validate ?? defaultValidate`.
  const validate = buildReproVoteValidate(
    instance,
    reproSources,
    repair.validate ?? defaultValidate,
  )
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const out = await runRepairRounds({
        config: { ...(repair.maxRounds !== undefined ? { maxRounds: repair.maxRounds } : {}) },
        problem: instance.problemStatement,
        runOnce: (seedMsg) =>
          runAgentOnce(
            instance,
            deps,
            sandbox,
            signal,
            w,
            seedMsg,
            deps.timeoutMs,
            precomputedHint,
            reproHint,
            closureHint,
          ),
        validate,
        // WS2 widen: bind sibling co-change owners into every repair seed (the
        // gate's `sibling_coverage_missing` record made actionable for the
        // model). Empty list ⇒ byte-identical to the base builder.
        buildContext: (ctxArgs) =>
          (repair.buildContext ?? buildRepairContext)({ ...ctxArgs, siblingOwners }),
        sandbox,
        exec,
        timeoutMs: deps.timeoutMs,
        evaluatePredicate: evaluateSuccessPredicate,
        ...(primaryRailStep !== undefined ? { primaryRailStep } : {}),
      })
      turns = out.turns
      finalPatch = out.patch
      repairValidated = out.validated
      repairFalseGreen = out.primaryFalseGreen
      repairFalseRed = out.primaryFalseRed
      repairRounds = out.rounds
    },
  )
  return {
    patch: patch !== "" ? patch : finalPatch,
    turns,
    validated: repairValidated,
    primaryFalseGreen: repairFalseGreen,
    primaryFalseRed: repairFalseRed,
    ...(repairRounds > 0 ? { verifyRounds: repairRounds } : {}),
  }
}

/** Repo-relative files a unified diff touches (its `+++ b/<f>` headers, plus
 *  `--- a/<f>` for pure deletions). Used for owner-coverage scoring. */
const filesFromPatch = (patch: string): string[] => {
  const files = new Set<string>()
  for (const line of patch.split("\n")) {
    const m = /^(?:\+\+\+ b\/|--- a\/)(.+)$/.exec(line)
    if (m !== null) {
      const f = (m[1] as string).trim()
      if (f !== "" && f !== "/dev/null") files.add(f)
    }
  }
  return [...files]
}

export interface SelectionReproPolicy {
  readonly enabled: boolean
  readonly goldCalibrate: boolean
  readonly resolvedKofNMode: "hard" | "soft"
}

/** Live-like no-oracle rule for verify-select repro use:
 *  - `positive` keeps the generated repro signal as SOFT-ONLY and MUST NOT peek
 *    at gold calibration.
 *  - unset / `hard` preserves the legacy eval-only gold-calibrated hard gate.
 *  - `off` removes the selection signal entirely. */
export const selectionReproPolicy = (
  mode: BenchPosture["verifySelectRepro"],
): SelectionReproPolicy => {
  if (mode === "off") {
    return { enabled: false, goldCalibrate: false, resolvedKofNMode: "hard" }
  }
  if (mode === "positive") {
    return { enabled: true, goldCalibrate: false, resolvedKofNMode: "soft" }
  }
  return { enabled: true, goldCalibrate: true, resolvedKofNMode: "hard" }
}

/**
 * TD — verify-and-select phase. Generates N closure-diversity-seeded candidates
 * (candidate 0 = unbiased; candidate i>0 nudged toward the i-th ranked owner so
 * the set spans different FIX SITES) and submits the {@link runSelection} pick.
 * Each candidate is a full agent run on a fresh snapshot (`withGitSnapshot`
 * resets the tree between them). Reached ONLY when the `verify-select` knob set
 * `verifySelectN`; otherwise the single-pass path runs (byte-identical).
 */
const runSelectionPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  n: number,
  concurrency: number | undefined,
  verifySelectRegression: BenchPosture["verifySelectRegression"],
  verifySelectRepro: BenchPosture["verifySelectRepro"],
  localizeCandidates: readonly string[],
  baseValidatedRed: boolean,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  reproSources: readonly string[],
): Promise<Phase> => {
  const owners = new Set(localizeCandidates)
  const reproPolicy = selectionReproPolicy(verifySelectRepro)
  const generationErrors = new Map<number, string>()
  const seedFor = (i: number): string | undefined => {
    if (i === 0) return undefined
    const file = localizeCandidates[i - 1]
    return file === undefined
      ? undefined
      : `Focus your investigation on \`${file}\`. Confirm the ROOT CAUSE lives there (not merely where the symptom surfaces) before editing.`
  }
  const mergeHint = (seed: string | undefined): string | undefined =>
    seed === undefined
      ? closureHint
      : closureHint === undefined
        ? seed
        : `${closureHint}\n\n${seed}`

  let totalTurns = 0
  // jun-20 — GOLD-CALIBRATE the resolved-consensus oracle BEFORE generation (it
  // resets the sandbox to base). A confirmed false-negative oracle ⇒ the
  // resolvedKofN port fails open (never rejects a candidate); the calibration is
  // surfaced as eval-only telemetry so the campaign self-measures the oracle's
  // false-negative rate (the verify-and-select bottleneck).
  const calibrationUnavailable: ReproOracleCalibration = {
    goldCalibrated: false,
    falseNegative: false,
    available: false,
    goldVotes: null,
    goldK: null,
  }
  const { port: resolvedKofNPort, calibration } =
    reproPolicy.enabled === false
      ? { port: () => Promise.resolve(null), calibration: calibrationUnavailable }
      : reproPolicy.goldCalibrate
        ? await makeCalibratedReproConsensusPort(instance, reproSources, sandbox, deps.timeoutMs)
        : {
            port: makeReproConsensusSelectionPort(instance, reproSources, sandbox, deps.timeoutMs),
            calibration: calibrationUnavailable,
          }
  const discoveredRegressionPort =
    verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionPort({ instance, sandbox, timeoutMs: deps.timeoutMs })
      : undefined
  const resolvedKofNSelectionPort = reproPolicy.enabled ? resolvedKofNPort : undefined
  // No-oracle verify-select (`discovered`) must not let synthesized repro
  // authority veto admissibility. In that mode, impacted repo tests are the hard
  // regression signal and repro consensus is already downgraded to positive-only
  // soft credit / fail-open; keep repro-authority absent as `null`, not `false`.
  const selectionBaseValidatedRed =
    verifySelectRegression === "discovered" ? null : baseValidatedRed
  const result = await runSelection({
    n,
    owners,
    seeds: Array.from({ length: n }, (_, i) => seedFor(i)),
    resolvedKofNMode: reproPolicy.resolvedKofNMode,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ports: {
      generate: async (i, seed): Promise<Candidate> => {
        const isolated = concurrency !== undefined && concurrency > 1
        const candidateSandbox = isolated ? await forkSandbox(instance.id, sandbox) : sandbox
        try {
          const phase = await runAgentPhase(
            instance,
            deps,
            candidateSandbox,
            signal,
            w,
            precomputedHint,
            reproHint,
            mergeHint(seed),
          )
          totalTurns += phase.turns
          const generationError = agentPhaseError(phase)
          if (generationError !== undefined) {
            generationErrors.set(i, generationError)
            throw new Error(generationError)
          }
          return {
            id: `cand-${i}`,
            patch: phase.patch,
            turns: phase.turns,
            files: filesFromPatch(phase.patch),
            baseValidatedRed: selectionBaseValidatedRed,
          }
        } finally {
          if (isolated) await cleanupSandbox(candidateSandbox)
        }
      },
      // TB regression HARD gate. Source is knob-selected:
      //   unset/gold => legacy eval-only PASS_TO_PASS set,
      //   discovered => no-oracle impacted repo-test discovery,
      //   off => ablation.
      // Every path fails open on missing/non-running tests.
      regression: (c) => {
        if (verifySelectRegression === "off") return Promise.resolve(null)
        if (verifySelectRegression === "discovered") {
          return discoveredRegressionPort?.(c) ?? Promise.resolve(null)
        }
        const tests = instance.swebench?.passToPass ?? []
        if (tests.length === 0) return Promise.resolve(null)
        return withCandidatePatch({
          sandbox,
          patch: c.patch,
          baseCommit: instance.swebench?.baseCommit,
          timeoutMs: deps.timeoutMs,
          probe: async (sb) => {
            const r = await makeBenchRegressionOracle()
              .run({ tests, sandbox: sb })
              .catch(() => null)
            return toRegressionGreen(tests, r)
          },
        })
      },
      // SOTA++ repro-vote as the SELECTION scorer: re-materialize each candidate
      // and re-run the reproducing repro set there → the VerificationBundle's
      // `patchedResolvedKofN` HARD signal (votes<k ⇒ reject). So selection picks
      // the candidate the repro set reports RESOLVED. Empty reproducing set ⇒ a
      // port that yields null (no objection). Gold-calibrated above — a confirmed
      // false-negative oracle is failed open so it never rejects a correct fix.
      ...(resolvedKofNSelectionPort !== undefined
        ? { resolvedKofN: resolvedKofNSelectionPort }
        : {}),
    },
  })
  if (result.successfulGenerations === 0 && result.generationFailures > 0) {
    const orderedErrors = [...generationErrors.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, error]) => error)
    const sample = orderedErrors.slice(0, 2).join("; ")
    return {
      patch: "",
      turns: totalTurns,
      stopReason: "error",
      agentError:
        "agent stopped with error before verification: " +
        `verify-select candidate generation failed for all ${n} candidates` +
        (sample === "" ? "" : ` (${sample})`),
      reproOracleCalibration: calibration,
      selectionTelemetry: summarizeSelection(result),
    }
  }
  return {
    patch: result.winner?.patch ?? "",
    turns: totalTurns,
    reproOracleCalibration: calibration,
    selectionTelemetry: summarizeSelection(result),
  }
}

const okResult = (
  instance: Instance,
  phase: Phase,
  v: { passed: boolean; error?: string },
  extra: Partial<InstanceResult>,
): InstanceResult => ({
  id: instance.id,
  passed: v.passed,
  patch: phase.patch,
  turns: phase.turns,
  ...(v.error !== undefined ? { error: v.error } : {}),
  ...extra,
})

const reproResultExtra = (
  reproTest: BenchReproTestTelemetry | undefined,
): Partial<InstanceResult> => (reproTest === undefined ? {} : { reproTest })

const shouldValidateGold = (deps: RunInstanceDeps, agentPassed: boolean): boolean =>
  deps.goldSanity !== undefined && (deps.goldSanity.mode === "always" || agentPassed === false)

const agentPhaseError = (phase: Phase): string | undefined => {
  if (phase.stopReason === "error") {
    return phase.agentError ?? "agent stopped with error before verification"
  }
  if (phase.stopReason === "refusal") return "agent stopped with refusal before verification"
  if (phase.stopReason === "budget_exhausted") {
    return "agent exhausted token budget before verification"
  }
  return undefined
}

const generationFailureResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly generationError: string
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult => {
  const extra: Partial<InstanceResult> = reproResultExtra(args.reproTest)
  if (args.deps.observe && args.wiring.observer) {
    extra.verdict = "ok"
    extra.durationMs = Date.now() - args.startedAt
    extra.patchPath = emitPatch(
      args.deps.observe,
      args.instance,
      args.wiring.observer,
      args.phase.patch,
    )
    const usage = args.wiring.usage?.total()
    if (usage) extra.usage = usage
    if (args.phase.reproOracleCalibration !== undefined) {
      extra.reproOracleCalibration = args.phase.reproOracleCalibration
    }
    if (args.phase.selectionTelemetry !== undefined) {
      extra.selectionTelemetry = args.phase.selectionTelemetry
    }
  }
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    error: args.generationError,
    ...extra,
  }
}

const noPatchResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult => {
  const extra: Partial<InstanceResult> = reproResultExtra(args.reproTest)
  if (args.deps.observe && args.wiring.observer) {
    extra.verdict = "ok"
    extra.durationMs = Date.now() - args.startedAt
    extra.patchPath = emitPatch(
      args.deps.observe,
      args.instance,
      args.wiring.observer,
      args.phase.patch,
    )
    const usage = args.wiring.usage?.total()
    if (usage) extra.usage = usage
    if (args.phase.reproOracleCalibration !== undefined) {
      extra.reproOracleCalibration = args.phase.reproOracleCalibration
    }
    if (args.phase.selectionTelemetry !== undefined) {
      extra.selectionTelemetry = args.phase.selectionTelemetry
    }
  }
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...extra,
  }
}

const terminalAgentResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult | undefined => {
  const generationError = agentPhaseError(args.phase)
  if (generationError !== undefined) {
    return generationFailureResult({ ...args, generationError })
  }
  if (args.phase.patch.trim() === "") return noPatchResult(args)
  return undefined
}

const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  // The per-instance wall-clock deadline bounds the AGENT SOLVE only — NOT env
  // setup (copyRepo + setupCmd + hint/repro install), which have their own
  // timeouts (runEnvPrep). Starting the timer here (pre-setup) let cold-start
  // overhead eat the agent's think budget and abort it mid-solve under
  // concurrency (observed: 68% spurious aborts). The timer is armed below, once
  // setup is done, so the agent always gets the full `timeoutMs`.
  let deadline: ReturnType<typeof setTimeout> | undefined
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  let reproTest: BenchReproTestTelemetry | undefined
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)

    const prep = await runEnvPrep(instance, sandbox, deps.timeoutMs)
    if (!prep.ok) {
      return {
        id: instance.id,
        passed: false,
        patch: "",
        turns: 0,
        verdict: "env_prep_failed",
        error: `env prep (setupCmd) failed (code ${prep.code}): ${prep.stderr.slice(0, 500)}`,
      }
    }

    const posture = benchOptIns()
    const hintMode = posture.issueHintMode
    // T-201: capture agentless ranked candidates from the same localization pass.
    let localizeCandidates: readonly string[] = []
    const precomputedHint = await prepareIssueHint(instance, sandbox, hintMode, {
      llm: deps.llm,
      onCandidates: (files) => {
        localizeCandidates = files
      },
    })
    // `bench-in-loop-exec` OFF (mini-swe posture): skip the host-python repro-test
    // hint — the agent isn't told to run tests, so a repro script is dead weight.
    // ON ⇒ byte-identical to the pre-knob path.
    const reproInstall = benchInstallsReproHint(posture.inLoopExec)
      ? await installReproTestHint(instance, sandbox, deps.llm)
      : { hint: undefined, telemetry: undefined }
    const reproHint = reproInstall.hint
    reproTest = reproInstall.telemetry
    // #2 repro-vote: reproducing set for the validation-time K-of-N RESOLVED gate.
    const reproSources = reproInstall.reproSources ?? []

    // T-302 primary-rail SELECTION (default-OFF, knob `primary-rail`). A repro that
    // reproduced the bug on the unpatched base (`reproducedCount > 0` ⇒ red-on-
    // injection) IS the primary rail — buildVerificationPlan only promotes it
    // because baseValidatedRed is true. Its cmd then GATES the repair loop (the
    // agent's own verify can no longer clear a round = false-green killer). Knob
    // OFF / no red repro ⇒ undefined ⇒ byte-identical agent-command gate.
    const stage1Files = localizeCandidates.map((file, i) => ({
      file,
      score: localizeCandidates.length - i,
    }))
    // WS2: LSP owner-sibling resolve fills `ownerResolved` — the stream the feeder
    // audit confirmed NONE populated, which starved the T-601 escalation gate
    // (#14315 parent/child override never reached the candidate set). Gated on the
    // closure posture (faultEvidence + lspNav); BLIND (issue symbols + stage-1 +
    // LSP only). Runs in the SETUP window (before `deadline` is armed below),
    // bounded to a few files/symbols. `[]` (ran, found none) un-`partial`s the
    // packet; `undefined` (LSP off) keeps the byte-identical stage-1-only path.
    const ownerResolved =
      instance.swebench !== undefined && posture.faultEvidence && posture.lspNav
        ? await resolveOwnerSiblings()({
            stage1Files,
            issueText: instance.problemStatement,
            cwd: sandbox,
            readSource: (rel) => {
              try {
                return readFileSync(join(sandbox, rel), "utf8")
              } catch {
                return null
              }
            },
            signal: abort.signal,
          })
        : undefined
    const closureSession =
      instance.swebench !== undefined
        ? buildClosureSession({
            problemStatement: instance.problemStatement,
            stage1Files,
            ...(ownerResolved !== undefined ? { ownerResolved } : {}),
            ...(reproTest?.installed === true && reproTest.reproducedCount > 0
              ? { reproScript: { cmd: `python "${reproTest.path}"`, baseValidatedRed: true } }
              : {}),
            posture: {
              lspNav: posture.lspNav,
              primaryRail: posture.primaryRail,
              faultEvidence: posture.faultEvidence,
            },
          })
        : undefined
    const verificationPlan = closureSession?.bundle.plan
    const primaryRailStep = closureSession?.primaryRailStep
    const closureHint = closureSession?.closureHint

    // Setup is done — arm the solve deadline now so the agent gets the full
    // `timeoutMs` of think time (see note where `deadline` is declared).
    deadline = setTimeout(() => abort.abort(), deps.timeoutMs)

    // `bench-in-loop-exec` OFF ⇒ force single-pass (the repair loop re-runs the
    // agent's verify against the same unrunnable host env). ON ⇒ byte-identical.
    //
    // The closure bundle's EXECUTION half: the verify-first repair loop is enabled
    // by the operator's `--repair-rounds` CLI override (`deps.repair`, which can
    // carry custom validate/buildContext) OR — when the caller didn't set it — by
    // the PRESET's `closure-repair` knob (`posture.repairRounds`). CLI wins; both
    // absent ⇒ undefined ⇒ byte-identical single-pass. Without this an
    // `agentless-v2` run SELECTS a primary rail (primary_rail_present_rate ≈ 0.82)
    // but NEVER gates (gate_enter_rate was n=0) because repair was disconnected
    // from the preset — the rail was an inert judgment, not an executor.
    const repair =
      deps.repair ??
      (posture.repairRounds !== undefined ? { maxRounds: posture.repairRounds } : undefined)
    const repairGateEligible = benchRunsRepairPhase(
      repair !== undefined,
      instance.swebench !== undefined,
      posture.inLoopExec,
    )
    const gateDecisionVerify = repairGateEligible && closureSession?.bundle.gate.action === "verify"
    const runRepair =
      repair !== undefined &&
      benchShouldRunRepairPhase({
        eligible: repairGateEligible,
        primaryRailEnabled: posture.primaryRail,
        gateAction: closureSession?.bundle.gate.action,
        primaryRailStep,
        verificationPlan,
      })
    // `&& repair !== undefined` is implied by `runRepair` (the predicate's first
    // term) — kept only so TS narrows `repair` to NonNullable for the call.
    phase =
      // TD verify-and-select (knob `verify-select`): N closure-diversity-seeded
      // candidates → VerificationBundle pick. SWE-bench only; unset ⇒ skip ⇒
      // byte-identical single-pass below.
      posture.verifySelectN !== undefined && instance.swebench !== undefined
        ? await runSelectionPhase(
            instance,
            deps,
            sandbox,
            abort.signal,
            w,
            posture.verifySelectN,
            posture.verifySelectConcurrency,
            posture.verifySelectRegression,
            posture.verifySelectRepro,
            localizeCandidates,
            verificationPlan?.baseValidatedRed ?? false,
            precomputedHint,
            reproHint,
            closureHint,
            reproSources,
          )
        : runRepair && repair !== undefined
          ? await runRepairPhase(
              instance,
              deps,
              sandbox,
              abort.signal,
              w,
              repair,
              precomputedHint,
              reproHint,
              closureHint,
              primaryRailStep,
              // WS2 widen: the blind LSP/grep sibling owners (empty when feeder
              // off or no sibling) — co-change pressure injected into repair seeds.
              ownerResolved !== undefined ? ownerResolved.map((o) => o.file) : [],
              reproSources,
            )
          : await runAgentPhase(
              instance,
              deps,
              sandbox,
              abort.signal,
              w,
              precomputedHint,
              reproHint,
              closureHint,
            )

    const terminal = terminalAgentResult({ instance, phase, reproTest, deps, wiring: w, startedAt })
    if (terminal !== undefined) {
      // Gold sanity runs even on early terminal returns (no-patch / gen-error)
      // because the agent always failed — the reference patch is still checkable.
      if (shouldValidateGold(deps, false)) {
        const gold = await validateGoldPatch(instance, { ...deps, signal: abort.signal })
        if (!gold.ok)
          return { ...terminal, passed: false, verdict: "grader_invalid", error: gold.error }
      }
      return terminal
    }

    let v = await verify(instance, phase.patch, sandbox, { ...deps, signal: abort.signal })
    const extra: Partial<InstanceResult> = reproResultExtra(reproTest)
    if (shouldValidateGold(deps, v.passed)) {
      const gold = await validateGoldPatch(instance, { ...deps, signal: abort.signal })
      if (!gold.ok) {
        v = { ...v, passed: false, error: gold.error }
        extra.verdict = "grader_invalid"
      }
    }
    if (deps.observe && w.observer) {
      extra.verdict ??= "ok"
      extra.durationMs = Date.now() - startedAt
      extra.patchPath = emitPatch(deps.observe, instance, w.observer, phase.patch)
      emitVerify(w.observer, v)
      const usage = w.usage?.total()
      if (usage) extra.usage = usage
      // T-202/F6 closure signals — only attached when observing, so non-observe
      // report.json stays byte-identical. Consumed offline by closure-diagnostics.
      if (phase.firstEditFile !== undefined) extra.firstEditFile = phase.firstEditFile
      if (phase.editCount !== undefined) extra.editCount = phase.editCount
      if (phase.turnsToFirstEdit !== undefined) extra.turnsToFirstEdit = phase.turnsToFirstEdit
      // T-3 closure measurement signals (observe-only; gated on the closure knobs
      // ⇒ byte-identical report when off). Drive primary_rail_present_rate /
      // required_verification_coverage.
      if (posture.verificationPlan || posture.primaryRail) {
        extra.primaryRailPresent = primaryRailStep !== undefined
        extra.requiredVerificationCovered =
          verificationPlan?.required.some((s) => s.successPredicate !== undefined) ?? false
        if (verificationPlan !== undefined)
          extra.synthReproBaseRed = verificationPlan.baseValidatedRed
        // Only meaningful when a primary RAIL was gated; repair-without-rail ⇒ omit
        // ⇒ null (emitting false would skew the rate denominator). Mirrors runner.
        if (primaryRailStep !== undefined && phase.primaryFalseGreen !== undefined)
          extra.primaryFalseGreen = phase.primaryFalseGreen
        // jun-18 RCA instrument: false-RED (rail rejected a repro-says-resolved patch).
        if (primaryRailStep !== undefined && phase.primaryFalseRed !== undefined)
          extra.primaryFalseRed = phase.primaryFalseRed
      }
      if (repairGateEligible) {
        extra.gateEntered = gateDecisionVerify
        extra.gateBypassed = !gateDecisionVerify
        if (phase.verifyRounds !== undefined) extra.verifyRounds = phase.verifyRounds
      }
      // jun-20 — repro-oracle gold calibration (verify-select path; eval-only).
      // Surfaces the resolved-oracle false-negative signal into report.json so a
      // campaign self-measures the bottleneck rate with no extra runs.
      if (phase.reproOracleCalibration !== undefined) {
        extra.reproOracleCalibration = phase.reproOracleCalibration
      }
      if (phase.selectionTelemetry !== undefined) {
        extra.selectionTelemetry = phase.selectionTelemetry
      }
      // T-401 patch-hygiene report (knob-gated + swebench-only + observe-only ⇒
      // byte-identical report.json when OFF). Telemetry-first: emit, don't deny.
      const ownerHint = relFromSandbox(sandbox, phase.firstEditFile)
      const hygiene =
        instance.swebench !== undefined ? buildPhasePatchHygiene(phase.patch, ownerHint) : undefined
      if (posture.patchHygiene && hygiene !== undefined) {
        extra.patchHygiene = hygiene
        extra.outOfScopeFiles = hygiene.filesOutsideOwner.length > 0
      }
      // jun-19 patch-budget (minimal-edit admission, #13417). Observe-only: emit
      // the typed budget over the diff so over_budget/new_def/cross_file rates feed
      // the A/B. Owner evidence = the closure localization candidates (justifies
      // cross-file). The SOFT-WITH-ESCALATION admission is a later measure-first step.
      if (posture.patchBudget && instance.swebench !== undefined) {
        const ownerFiles = closureSession?.bundle.evidence.candidates.map((c) => c.file) ?? []
        extra.patchBudget = analyzePatchBudget(phase.patch, {
          ownerFiles,
          repo: instance.swebench.repo,
        })
      }
      // T-301 verification-plan telemetry (knob-gated, observe-only).
      if (posture.verificationPlan && verificationPlan !== undefined) {
        extra.verificationPlan = verificationPlan
      }
      if (posture.faultEvidence && closureSession !== undefined) {
        extra.faultEvidence = closureSession.bundle.evidence
        extra.ownerAdmission = closureSession.bundle.owner
      }
      if (posture.repairEscalation && closureSession !== undefined) {
        extra.repairEscalation = decideEscalation({
          candidates: closureSession.bundle.evidence.candidates.map((c) => ({
            file: c.file,
            score: c.score,
            sources: c.sources,
          })),
          primaryRailRedAfterRepair: primaryRailRedAfterRepair(
            primaryRailStep,
            phase.validated,
            phase.primaryFalseGreen,
          ),
          // WS2: the gate keys off the SAME unsliced ownerResolved the seed-widen
          // uses (see the runRepairPhase call) — NOT the post-maxCandidates-slice
          // packet candidates — so the gate's telemetry can't disagree with the
          // actual widen behavior on a sibling ranked out of the top-K.
          siblingFiles: ownerResolved !== undefined ? ownerResolved.map((o) => o.file) : [],
        })
      }
    }
    // jun-19 — surface the official-grade regression-vs-didn't-fix breakdown so a
    // campaign run self-measures how often our patches break PASS_TO_PASS (the
    // regression-gate justification) with NO extra runs. Present for swebench
    // grades only; absent ⇒ byte-identical report.
    if (v.breakdown !== undefined) extra.gradeBreakdown = v.breakdown
    return okResult(instance, phase, v, extra)
  } catch (error) {
    if (error instanceof ObservationError) {
      return {
        id: instance.id,
        passed: false,
        patch: phase.patch,
        turns: phase.turns,
        verdict: "degraded",
        error: `observation failed (strict): ${error.message}`,
        ...reproResultExtra(reproTest),
      }
    }
    return {
      id: instance.id,
      passed: false,
      patch: phase.patch,
      turns: phase.turns,
      error: errMessage(error),
      ...reproResultExtra(reproTest),
    }
  } finally {
    clearTimeout(deadline)
    w.observer?.close()
    await cleanupSandbox(sandbox)
  }
}

/**
 * Public entry-point with the transient-retry wrapper (measurement-stability).
 *
 * `maxAttempts` precedence: `deps.measurementStability?.maxAttempts` (test seam)
 * > unified posture `retryTransient` (preset/env via the knob framework — preset
 * `agentless-v1` ⇒ 3; explicit `QUANTA_BENCH_RETRY_TRANSIENT` overrides) > 1.
 *
 * Byte-identical fence: when `maxAttempts === 1` (default, no preset/env) the
 * wrapper calls `runInstanceOnce` EXACTLY ONCE and returns its result verbatim
 * (no `budget` stamp) — identical to the pre-wrapper single-pass shape and
 * wall-clock. Only the multi-attempt path stamps `budget`.
 *
 * Unlike the (dead) runner-driver wrapper this DELIBERATELY does NOT scale the
 * per-attempt timeout by knob `costMultiplier`: those multipliers are a
 * matrix-budget construct (e.g. repro-test=40) and using them as a wall-clock
 * multiplier balloons an `agentless-v1` instance ~15× unexpectedly. Per-attempt
 * timeout stays operator-controlled (`--timeout` / `QUANTA_BENCH_TIMEOUT_MS`).
 */
export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const maxAttempts = Math.max(
    1,
    Math.floor(deps.measurementStability?.maxAttempts ?? benchOptIns().retryTransient ?? 1),
  )
  if (maxAttempts === 1) return runInstanceOnce(instance, deps)

  const policy = deps.measurementStability?.policy ?? DEFAULT_POLICY
  const { result, loop } = await runRetryLoop(
    async () => runInstanceOnce(instance, deps),
    maxAttempts,
    policy,
  )
  return {
    ...result,
    budget: {
      baseTimeoutMs: deps.timeoutMs,
      adaptedTimeoutMs: deps.timeoutMs,
      attempts: loop.attempts,
      attemptOutcomes: loop.outcomes.map(projectOutcome),
    },
  }
}
