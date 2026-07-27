import { type AgentConfig, type AgentOutcome, runAgent, wireOptionalAgentPorts } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import type { LLMPort, Message } from "@/llm"
import type { CapabilityManifest, SessionEvent } from "@/protocol/session"
import {
  classifyDoneTimeCapture,
  type DoneTimeCaptureClass,
  isCaptureFailure,
} from "@/runner/batch/eval/capture-correctness"
import {
  type BenchKnobState,
  type BenchPosture,
  benchVerifyAuthorityCommandsOf,
  type buildRepairBreadthRunCandidates,
  buildConfig as buildRunnerConfig,
  emitKnobsApplied,
} from "@/runner/batch/eval/driver"
import type { LlmEvidenceArtifacts } from "@/runner/batch/eval/llm-evidence-packet"
import { installProjectEnvPythonShim } from "@/runner/batch/eval/project-env-python-shim"
import type { SelectionTelemetry } from "@/runner/batch/eval/selection-executor"
import { filesFromPatch } from "@/runner/batch/eval/selection-executor"
import {
  createSessionScopedSignal,
  withSessionScopedSignal,
} from "@/runner/batch/eval/session-signal"
import { BenchStreamTap, relFromSandbox } from "@/runner/batch/eval/stream-tap"
import { createTentativeRecorder } from "@/runner/batch/eval/tentative-patch"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import { gateDisabled, gateOn, logger } from "@/shared"
import { patchRunMeta } from "../../trajectory"
import { debugSink, isTrajectoryDebugEnabled } from "../../trajectory-debug-sink"
import type { Instance, InstanceResult, ReproOracleCalibration } from "../../types"
import { exec } from "../exec"
import type { RunOnceResult } from "../repair/types"
import { emitSandbox, type Wiring } from "../report"
import { gitStageAndDiffCached, gitWorktreeHasStagedChanges, withGitSnapshot } from "../snapshot"
import type { RunInstanceDeps } from "./deps"

/**
 * DEBUG enricher `verdict` (jul-08 platform, ADR-0539). Push the grade/verify
 * outcome into the CURRENT lane's debug buffer so the recorder drains it onto
 * `metadata.debug.verdict` of the recorded LLM turn — the exact loose-coupling
 * shape `toolExec` uses (append/contribute → drain at turn-commit). The payload
 * is the pass/fail bit, the patch size, and any observation verdict / harness
 * error summary already decided at the call site.
 *
 * CONTRACT: metadata-only ⇒ REPLAY-NEUTRAL. The debug slice rides `metadata`,
 * which is never hashed (the cassette key is `stripEphemeralRequest(input)`), so
 * this can NEVER perturb the request hash / a cross-box replay hit. `contribute`
 * is itself a no-op when the debug gate is off, so callers still guard with
 * {@link isTrajectoryDebugEnabled} only to skip building the payload.
 */
export const contributeVerdictDebug = (result: {
  readonly passed: boolean
  readonly patch: string
  readonly verdict?: InstanceResult["verdict"]
  readonly error?: string
}): void => {
  debugSink.contribute("verdict", {
    passed: result.passed,
    patchBytes: result.patch.length,
    ...(result.verdict !== undefined ? { observationVerdict: result.verdict } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  })
}

/**
 * DEBUG enricher `editTrace` (jul-13 platform, ADR-0539). The THIRD (and final)
 * debug-sink contributor, mirroring `verdict` and `toolExec`: when the `edit`
 * tool runs during a bench turn, shape a per-edit trace slice and APPEND it into
 * the CURRENT lane's debug buffer so the recorder drains it onto
 * `metadata.debug.editTrace` — a LIST (multiple edits per turn accumulate, never
 * overwrite; mirrors `toolExec`'s `append`).
 *
 * SCOPE: `edit` ONLY. The tap fires `onEditResult` for EVERY file-mutating
 * tool_result (`write`, `scripted_replace`, `apply_patch`, and the office/image
 * writers are all classified `write_filesystem` too), but the mode/outcome
 * grammar below is the EDIT tool's output vocabulary specifically -- `write`
 * ("Overwrote/Created ... (N bytes)"), `scripted_replace` ("... (replacements=N)"),
 * `apply_patch` ("added:/updated:/deleted:") and the binary writers speak a
 * different language. Applying the edit grammar to them would silently tag them
 * `mode:"exact"` and drop their real counts -- dishonest debug data. So this
 * shaper is a HARD no-op for any `name !== "edit"`; those writers are simply not
 * captured in `editTrace` (their timing/outcome already ride `toolExec`). A
 * `tool` field is stamped on every slice defensively so a future scope widening
 * can never leave a slice mislabeled.
 *
 * ZERO RECOMPUTE: every field is derived from a signal the edit tool ALREADY
 * produced — the target `file`, the applied bit (`ok`), the bulk-replace intent
 * (`replaceAll`), and the tool's own output message (`preview`, which encodes the
 * strategy/mode + occurrence count the edit already decided). NO diff recompute,
 * NO file re-read.
 *
 * The `preview` is `"<path>: <message>…"`; the `message` vocabulary (edit tool
 * SSOT -- `src/tool/edit/**`) is the mode/outcome oracle:
 *   - `applied via fast-apply merge`               → mode `fast-apply`
 *   - `…via whitespace-flexible|anchored-trim match`
 *     · `…via scored-candidate best match (…)`     → mode `fuzzy` (escalated)
 *   - `Replaced N occurrence(s)[ within line_ranges]`
 *     · `…via exact match`                          → mode `exact`
 *   - `stale_precondition` / `stale_read`          → outcome `stale`
 * A non-`ok` result with no stale marker is outcome `failed`; `ok` is `matched`.
 *
 * CONTRACT: metadata-only ⇒ REPLAY-NEUTRAL (rides `metadata`, never the request
 * hash). `append` is itself a no-op off-gate, so the tap only builds/forwards the
 * raw signals when `isTrajectoryDebugEnabled()` (the tap wires `onEditResult`
 * only then), and this shaper is only reached on that wired path.
 */
export const contributeEditTraceDebug = (raw: {
  readonly name: string
  readonly file: string
  readonly ok: boolean
  readonly preview: string
  readonly replaceAll: boolean
}): void => {
  // Scope guard: the mode/outcome grammar below is EDIT-tool-specific. Any other
  // write tool (write / scripted_replace / apply_patch / office+image writers)
  // would be silently mis-moded, so drop it -- it is NOT captured in editTrace
  // (its timing/outcome already rides `toolExec`).
  if (raw.name !== "edit") return
  const p = raw.preview
  const isStale = /stale_precondition|stale_read/.test(p)
  const outcome = raw.ok ? "matched" : isStale ? "stale" : "failed"
  const isFuzzy = /whitespace-flexible|anchored-trim|scored-candidate/.test(p)
  const isFastApply = p.includes("fast-apply merge")
  const mode = isFastApply ? "fast-apply" : isFuzzy ? "fuzzy" : "exact"
  const occ = p.match(/Replaced (\d+) occurrence/)
  const occurrences = occ?.[1] !== undefined ? Number.parseInt(occ[1], 10) : undefined
  debugSink.append("editTrace", {
    tool: raw.name,
    file: raw.file,
    mode,
    outcome,
    ...(occurrences !== undefined ? { occurrences } : {}),
    ...(raw.replaceAll ? { replaceAll: true } : {}),
    ...(mode === "fuzzy" ? { fuzzyEscalated: true } : {}),
  })
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
  // ADR-0540 W1-B — bench sessions have no daemon continuation owner.
  serverAutoContinues: false,
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

export const captureLostEditsError = (editCount: number | undefined, sandbox: string): string =>
  `capture_lost_edits: ${editCount ?? 0} edit(s) made but 0-byte source diff on a clean worktree ` +
  `(fork-worktree desync, sandbox=${sandbox})`

export const lastTerminalTurnEventOf = (
  events: readonly SessionEvent[],
):
  | Extract<SessionEvent, { type: "turn.completed" | "turn.failed" | "turn.aborted" }>
  | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    // ALBB-04 added a dedicated `turn.aborted` terminal wire event; a cooperative
    // RETURN-abort (deadline/budget abort that surfaced a partial patch) now
    // settles it here. Match it too — otherwise the terminal-event lookup below
    // fails and throws, DISCARDING the honest partial patch (#10097 fallback).
    if (
      event?.type === "turn.completed" ||
      event?.type === "turn.failed" ||
      event?.type === "turn.aborted"
    )
      return event
  }
  return undefined
}

const runAgentViaSdk = async (
  config: AgentConfig,
  runtimeFactory: typeof createRuntime = createRuntime,
): Promise<AgentOutcome> => {
  const sessionSignal = createSessionScopedSignal(config.signal)
  const scopedConfig = withSessionScopedSignal(config, sessionSignal.signal)
  const hostSession = createBenchSessionHost(scopedConfig)
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
    await session.input.append(promptTextFromMessages(scopedConfig.messages), undefined, {
      signal: scopedConfig.signal,
    })
    const turn = await session.turn.run(undefined, { signal: scopedConfig.signal })
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
        (e) => e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.aborted",
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
    sessionSignal.abort()
    unsubscribe?.()
    await session?.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
  }
}

export interface Phase {
  patch: string
  turns: number
  stopReason?: AgentOutcome["reason"]
  agentError?: string
  /** T-202/F6 stream-tap signals (single-pass path only). */
  firstEditFile?: string
  editCount?: number
  /** Successful SOURCE edits (excludes test/scratch edits). Threaded so the
   *  capture-miss guard can distinguish a real source-edit capture desync from a
   *  test-only-edit timeout. See runner driver `patchCaptureMissErrorOf`. */
  sourceAppliedEditCount?: number
  turnsToFirstEdit?: number
  /** T5 — done-time patch-capture class. `lost-edits` ⇒ the agent edited but the
   *  captured tree is empty AND clean (fork-worktree desync, 11138 class): an
   *  infra capture failure to retry, never a silent empty submit. Single-pass. */
  captureClass?: DoneTimeCaptureClass
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
  /** jun-28 A2 — final repair-gate authority decision (observe-only). */
  repairValidationDecision?: import("@/runner/batch/eval/repair/decision").ValidationDecision
  verifyRounds?: number
  /** jun-20 — repro-oracle gold calibration for this verify-select run (eval-only
   *  telemetry). Set by the selection phase; undefined on single-pass/repair. */
  reproOracleCalibration?: ReproOracleCalibration
  /** jun-20 — verify-select winner/candidate telemetry (eval-only). Lets a run
   *  self-diagnose which fix sites were spanned, which candidates were
   *  admissible, and why the winner won without re-parsing trajectories. */
  selectionTelemetry?: SelectionTelemetry
  /** OPC-07 — stage packets actually used during this phase. */
  llmEvidence?: LlmEvidenceArtifacts
  /** Structural owner widening actually consumed before this phase ran. */
  ownerWidening?: NonNullable<InstanceResult["ownerWidening"]>
}

// Bench stream tap is the SSOT in `@/runner/batch/eval/stream-tap` — imported
// above. This prod wrapper and the runner core share the one definition
// (they previously each carried a drifting private copy).

export const runAgentOnce = async (
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
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  /** repair-loop BREADTH (jun-28): per-candidate provider lane port. Routed by
   *  the breadth fan-out so candidate `i` is generated by lane `i mod laneCount`
   *  when model-lane-diversity + ≥2 lanes are configured. Absent ⇒ `deps.llm`
   *  (byte-identical single-candidate / non-breadth path). */
  laneLlm?: LLMPort,
): Promise<RunOnceResult> => {
  const tap = new BenchStreamTap(
    w.stream,
    undefined,
    benchVerifyAuthorityCommandsOf(instance),
    // Per-action progress → run.log (live "what the agent did" under concurrency).
    // One concise line per tool call. The verify-select phase below already wired
    // this; the single-pass path (the default for most presets) was the gap, so a
    // full-remote run.log showed only coarse "▶ instance" milestones and never the
    // per-turn agent actions — exactly the live LLM-process visibility that was
    // missing.
    (name, detail) => logger.info(`  · ${instance.id} ${name}${detail ? ` ${detail}` : ""}`),
    // toolExec debug enricher: record per-tool-result timing + outcome into the
    // debug-sink so the trajectory viewer can show a per-turn tool breakdown.
    // No-op unless QUANTA_BENCH_RECORD_TRAJECTORY=debug.
    isTrajectoryDebugEnabled() ? (args) => debugSink.append("toolExec", args) : undefined,
    // editTrace debug enricher (jul-13): shape a per-edit trace (mode / outcome /
    // occurrences / fuzzy-escalation) from the edit's own signals and append it to
    // metadata.debug.editTrace. No-op off-gate (byte-identical).
    isTrajectoryDebugEnabled() ? contributeEditTraceDebug : undefined,
  )
  // Knob telemetry: emit ONE `knobs_applied` event per runAgent invocation —
  // the greppable per-run marker of which knobs/preset actually ran. The runner
  // driver emits it at both agent entry points; this prod (SDK) wrapper must
  // match or every real trajectory is silently missing the line (split-brain).
  emitKnobsApplied(tap, process.env, stateOverride)
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
      postureOverride,
      stateOverride,
      undefined,
      laneLlm,
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

/** Bind the app driver's fixed repair inputs once for breadth fork attempts. */
export const repairForkRunner =
  (
    instance: Instance,
    deps: RunInstanceDeps,
    signal: AbortSignal,
    w: Wiring,
    precomputedHint: string | undefined,
    reproHint: string | undefined,
    closureHint: string | undefined,
    repairPosture: BenchPosture,
    stateOverride: BenchKnobState | undefined,
  ): Parameters<typeof buildRepairBreadthRunCandidates>[0]["runAgentOnFork"] =>
  (forkSandbox, seedMsg, laneLlm) =>
    runAgentOnce(
      instance,
      deps,
      forkSandbox,
      signal,
      w,
      seedMsg,
      deps.timeoutMs,
      precomputedHint,
      reproHint,
      closureHint,
      repairPosture,
      stateOverride,
      laneLlm,
    )

const classifyPhaseCapture = async (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly timeoutMs: number
  readonly rawPatch: string
  readonly sourceAppliedEditCount: number | undefined
  readonly totalEditCount: number | undefined
  readonly firstEditFile: string | undefined
  readonly agentError: string | undefined
}): Promise<{
  readonly captureClass: DoneTimeCaptureClass
  readonly agentError: string | undefined
}> => {
  const facts = classifyDoneTimeCapture({
    sourcePatch: args.rawPatch,
    rawDirty: await gitWorktreeHasStagedChanges(args.sandbox, args.timeoutMs),
    editCount: args.sourceAppliedEditCount ?? 0,
    touchedFiles: filesFromPatch(args.rawPatch),
  })
  const captureClass = facts.captureClass
  if (!isCaptureFailure(captureClass)) {
    return { captureClass, agentError: args.agentError }
  }
  logger.warn(
    `[capture] ${args.instance.id}: LOST-EDITS — ${args.sourceAppliedEditCount ?? 0} successful ` +
      "source edit(s) observed but the done-time source diff is empty and the " +
      "worktree is clean (capture desync or outside-sandbox write). Routed as infra capture " +
      "failure, NOT a model miss.",
  )
  if (gateOn(process.env, "QUANTA_CAPTURE_DEBUG")) {
    const dbgStatus = await exec(
      "git status --porcelain --untracked-files=all",
      args.sandbox,
      args.timeoutMs,
    ).catch(() => null)
    logger.warn(
      `[capture-debug] ${args.instance.id}: sandbox=${args.sandbox} firstEditFile=${args.firstEditFile ?? "?"} ` +
        `sourceBytes=${facts.sourcePatchBytes} appliedEdits=${facts.editCount} rawDirty=${facts.rawDirty} ` +
        `touched=[${facts.touchedFiles.join(",").slice(0, 200)}] ` +
        `status=[${(dbgStatus?.stdout ?? "git-fail").slice(0, 400).replace(/\n/g, "|")}]`,
    )
  }
  return {
    captureClass,
    agentError: args.agentError ?? captureLostEditsError(args.totalEditCount, args.sandbox),
  }
}

export const runAgentPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  laneLlm?: LLMPort,
): Promise<Phase> => {
  let turns = 0
  let stopReason: AgentOutcome["reason"] | undefined
  let agentError: string | undefined
  let firstEditFile: string | undefined
  let editCount: number | undefined
  let sourceAppliedEditCount: number | undefined
  let turnsToFirstEdit: number | undefined
  let capturedActionTrace: readonly string[] | undefined
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
      const tap = new BenchStreamTap(
        w.stream,
        onVerifyPass,
        benchVerifyAuthorityCommandsOf(instance),
        // Per-action progress → run.log (live "what the agent did" under
        // concurrency). One concise line per tool call.
        (name, detail) => logger.info(`  · ${instance.id} ${name}${detail ? ` ${detail}` : ""}`),
        // toolExec debug enricher: per-tool-result timing + file path (edit tools).
        // No-op unless QUANTA_BENCH_RECORD_TRAJECTORY=debug.
        isTrajectoryDebugEnabled() ? (args) => debugSink.append("toolExec", args) : undefined,
        // editTrace debug enricher (jul-13): per-edit mode/outcome/occurrences from
        // the edit's own signals → metadata.debug.editTrace. No-op off-gate.
        isTrajectoryDebugEnabled() ? contributeEditTraceDebug : undefined,
      )
      // Knob telemetry: emit once per phase entry (matches the contract on
      // `emitKnobsApplied`). The single-pass path bypasses `runAgentOnce`, so
      // the emit lives here directly — mirrors the runner driver's runAgentPhase.
      emitKnobsApplied(tap, process.env, stateOverride)
      await installProjectEnvPythonShim(instance, sandbox)
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
          postureOverride,
          stateOverride,
          undefined,
          laneLlm,
        ),
        deps.runtimeFactory,
      )
      turns = outcome.turns
      stopReason = outcome.reason
      agentError = tap.lastErrorMessage
      firstEditFile = relFromSandbox(sandbox, tap.firstEditFile)
      editCount = tap.editCount
      sourceAppliedEditCount = tap.sourceAppliedEditCount
      turnsToFirstEdit = tap.turnsToFirstEdit
      if (isTrajectoryDebugEnabled() && tap.actionTrace.length > 0) {
        capturedActionTrace = tap.actionTrace.slice()
      }
    },
    instance.swebench?.repo,
  )
  // Drain any in-flight snapshots, then select what to emit. `finalOk` = the
  // agent declared done cleanly; any other reason is the "ran out mid-validate"
  // case the retention targets.
  await snapChain
  if (capturedActionTrace !== undefined) {
    void patchRunMeta(instance.id, { actionTrace: capturedActionTrace })
  }
  const patch = tentativeOn
    ? recorder.selectEmitted(rawPatch, stopReason === "completed")
    : rawPatch
  // T5 — classify on successful SOURCE edits only. Counting failed/blocked
  // attempts, test edits, or scratch edits would misread a no-source-change run
  // as a fork-worktree desync. Classify on `rawPatch`, not tentative `patch`.
  const capture = await classifyPhaseCapture({
    instance,
    sandbox,
    timeoutMs: deps.timeoutMs,
    rawPatch,
    sourceAppliedEditCount,
    totalEditCount: editCount,
    firstEditFile,
    agentError,
  })
  const captureClass = capture.captureClass
  agentError = capture.agentError
  if (tentativeOn && patch !== rawPatch) {
    // P0 telemetry — log ONLY when retention actually substitutes (the rare,
    // interesting case): the run ended badly and we recovered a verified-green
    // intermediate over the empty/regressed final tree.
    logger.warn(
      `[tentative] ${instance.id}: ENGAGED — emitted verified candidate ` +
        `(${recorder.count} recorded, stopReason=${stopReason}) ` +
        `${patch.length}B over ${rawPatch.length}B final`,
    )
  }
  return {
    patch,
    turns,
    captureClass,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(agentError !== undefined ? { agentError } : {}),
    ...(firstEditFile !== undefined ? { firstEditFile } : {}),
    ...(editCount !== undefined ? { editCount } : {}),
    ...(sourceAppliedEditCount !== undefined ? { sourceAppliedEditCount } : {}),
    ...(turnsToFirstEdit !== undefined ? { turnsToFirstEdit } : {}),
  }
}
