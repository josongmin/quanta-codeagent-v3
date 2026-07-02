/**
 * Shared run-instance vocabulary + leaf helpers (pure code motion from
 * `driver.ts`, byte-identical). This module is the SSOT for the types every
 * driver phase speaks — `RunInstanceDeps` (the injectable dependency surface),
 * `Phase` (per-phase agent result), and the `PreparedAttemptContext` family —
 * plus three dependency-free helpers (`cleanUniqueList`, `stage1FilesOf`,
 * `readSandboxSource`). Everything here is a leaf: it imports only sibling
 * TYPES + node builtins, so the orchestration modules (and `driver.ts` itself)
 * can all import from HERE without any import cycle.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, StopReason } from "@/agent"
import type { OwnerSibling, PrimaryRailStep } from "@/agent/closure"
import type { LLMPort } from "@/llm"
import type { LspGroundingReceipt } from "@/shared"
import type { AttemptObservation } from "../../observe"
import type {
  BenchReproTestTelemetry,
  OwnerWideningTelemetry,
  ReproOracleCalibration,
} from "../../types"
import type { RerankTier } from "../acceptance-rerank"
import type { DoneTimeCaptureClass } from "../capture-correctness"
import type { ChaRepairTarget } from "../cha-multisite"
import type { ClosureSessionState } from "../closure-session"
import type { BenchKnobState, BenchPosture } from "../knobs-bench"
import type { LlmEvidenceArtifacts, LlmEvidencePacket } from "../llm-evidence-packet"
import type { BuildRepairContextArgs, ValidateArgs, ValidatorResult } from "../repair/types"
import type { ReproArtifactSink } from "../repro-artifacts-sink"
import type { ReproViabilityReview } from "../repro-viability"
import type { RetryPolicy } from "../retry-policy"
import type { SelectionTelemetry } from "../selection-executor"
import type { SubmissionReview } from "../submission-review"
import type { PythonSwebenchEvaluate } from "../verdict"

export interface RunInstanceDeps {
  llm: LLMPort
  /**
   * G1 cross-vendor diversity (jun-24) — OPTIONAL ordered list of provider-
   * DISTINCT LLM ports (the dual-provider seam). When the `model-lane-diversity`
   * posture is ON and this list has length ≥ 2, the verify-select driver routes
   * candidate `i` to lane `i mod llmLanes.length` (see {@link resolveLaneLlm}),
   * decorrelating the generation set across vendors/families instead of running
   * N correlated samples of `llm`. Each entry is a fully-wired `LLMPort` built
   * from the existing `createLLM` adapters (NO new transport). ABSENT or length
   * ≤ 1 ⇒ every candidate stays on `llm` (byte-identical single-vendor path).
   * The composition root (index.ts) builds this from the configured providers.
   */
  llmLanes?: readonly LLMPort[]
  /** Hard ceiling on agent turns per attempt. */
  maxTurns: number
  /** Wall-clock budget (ms) for the whole instance. */
  timeoutMs: number
  /**
   * Trajectory fork-experiment seam (troubleshooting). Threaded straight onto
   * `AgentConfig.turnContextMutator` so a named experiment can vary the per-turn
   * LLM input at a chosen turn. ABSENT (default) ⇒ not set on the config ⇒
   * byte-identical prompt. Wired by index.ts from `QUANTA_FORK_EXPERIMENT`.
   */
  turnContextMutator?: AgentConfig["turnContextMutator"]
  /**
   * Optional hard-budget factory for a single agent invocation. The factory is
   * threaded through `buildConfig`; callers may return a FRESH meter per nested
   * run, or close over ONE shared meter to enforce an attempt-wide budget
   * across repair rounds / breadth candidates / selector runs.
   *
   * Absent (default) ⇒ no budget meter is wired and the loop stays
   * byte-identical to the pre-budget path.
   */
  budgetMeterFactory?: () => AgentConfig["budgetMeter"]
  /**
   * A1 (jun-28): per-candidate repro artifact sink. When present, every generated
   * repro candidate (canonical + hardening) is persisted under the run's observe
   * dir before the unselected breadth candidates are discarded — durable RCA
   * evidence that survives the full-remote tarball. Observe-only (never gates a
   * decision); ABSENT ⇒ no-op (default-OFF, byte-identical). The composition root
   * builds it from the observe handle, gated by the `reproArtifacts` opt-in.
   */
  reproArtifactSink?: ReproArtifactSink
  /** Absolute root dir bound into `reproArtifactSink`; used only to surface the
   *  per-instance artifact directory in results/report.json. */
  reproArtifactRootPath?: string
  /**
   * Official-harness verifier. When present AND the instance carries swebench
   * metadata, the captured patch is graded by the Python harness instead of
   * the local `testCmd`. Absent (default) ⇒ unchanged local testCmd path.
   * `opts` is forwarded to `evaluateWithPythonSwebench` (injectable spawn/probe
   * keep tests hermetic). index.ts gates this behind `QUANTA_SWEBENCH_PYTHON=1`.
   */
  pythonSwebench?: {
    evaluate?: PythonSwebenchEvaluate
    opts?: unknown
  }
  /**
   * RFC-0002 §8 observability. ABSENT (default) ⇒ `NullStream`, byte-identical
   * to pre-W-D behavior — no files written. PRESENT ⇒ the agent stream is
   * `TeeStream([NullStream, JsonlRecorder(<run>/<id>.<attempt>.jsonl)])` with
   * `strict:true` (eval), plus bench-produced `sandbox`/`patch_generated`/
   * `verify` lines. A strict recorder failure ⇒ `verdict:"degraded"`.
   */
  observe?: AttemptObservation
  /**
   * b2 — External repair rounds (RFC §16, ADR-0014). ABSENT (default) ⇒ feature
   * OFF / byte-identical single-pass; same gating posture as `pythonSwebench?`/
   * `observe?`. When present AND `instance.swebench` is set, the runner wraps
   * `runAgentPhase` in `runRepairRounds`: rounds share ONE sandbox (continue-
   * from-patched-tree, no git reset between rounds), the official `verify()`
   * runs EXACTLY ONCE at the end (no-leak invariant — never fed back to the
   * agent), and the seed message handed to round ≥1 is built from the agent's
   * own validator failure tail (NOT from any dataset hidden field).
   * `validate`/`buildContext` are injectable test seams; production defaults
   * are the G1 implementations.
   */
  repair?: {
    maxRounds?: number
    /** jun-28 repair-loop BREADTH (oracle-selected best-of-N). When `> 1`, each
     *  repair round generates `breadth` forked candidates and continues from the
     *  one the validator turns green. Test seam > preset `repairBreadth` posture.
     *  Absent / 1 ⇒ byte-identical single candidate. */
    breadth?: number
    validate?: (args: ValidateArgs) => Promise<ValidatorResult>
    buildContext?: (args: BuildRepairContextArgs) => string
  }
  /**
   * Measurement-stability slice: knob-aware adaptive timeout + transient-retry
   * loop. ABSENT (default) ⇒ feature OFF (byte-identical single-pass path) —
   * `deps.timeoutMs` is the deadline, retries are not attempted, and the
   * `budget` field is omitted from `InstanceResult`. PRESENT ⇒ the driver:
   *   1. resolves `maxAttempts` (test seam > preset `retryTransient` > 1);
   *   2. runs up to `maxAttempts` attempts, classifying each `InstanceResult`
   *      and retrying ONLY transient outcomes (empty-patch / infra-fail).
   *   3. stamps `result.budget` with the per-attempt history.
   *
   * NOTE: the per-attempt timeout is the operator-controlled `deps.timeoutMs`
   * verbatim — knob `costMultiplier` is a matrix-budget construct (e.g.
   * repro-test=40) and was intentionally NOT used as a wall-clock multiplier
   * (it would balloon an `agentless-v1` instance ~15×). `budget.adaptedTimeoutMs`
   * therefore always equals `baseTimeoutMs`.
   *
   * `maxAttempts === 1` is byte-identical to the pre-feature single-pass
   * path EXCEPT that `budget` is recorded. To keep the JSON report
   * byte-identical, the wrapper omits `budget` when neither adaptive nor
   * retry produced a non-baseline value.
   *
   * The wrapper layer is ON TOP of Best-of-N (`apps/bench/index.ts`'s
   * `resolveInstance`) — each retry attempt is itself a full Best-of-N
   * round.
   */
  measurementStability?: {
    /** Max retries on transient outcome (1 = no retry, byte-identical). */
    maxAttempts?: number
    /** Custom retry policy (default: `DEFAULT_POLICY` — only empty-patch +
     *  infra-fail are retried). */
    policy?: RetryPolicy
  }
  /**
   * Reference-patch sanity check. When enabled, the runner validates
   * `instance.goldPatch` with the SAME verifier used for the agent patch. If
   * the reference patch is rejected, the instance is marked
   * `verdict:"grader_invalid"` and excluded from resolved/total. Default-OFF;
   * callers that load a corpus with trustworthy gold patches opt in.
   */
  goldSanity?: {
    /** `"on-fail"` validates only when the agent patch failed; `"always"`
     *  validates every gold-bearing instance. Omitted ⇒ `"on-fail"`. */
    mode?: "on-fail" | "always"
  }
}

export interface Phase {
  patch: string
  turns: number
  stopReason?: StopReason
  agentError?: string
  /** T5 — done-time capture class (single-pass path). When this is a capture
   *  failure (`lost-edits`), {@link agentPhaseError} surfaces the `capture_lost_edits`
   *  marker so classifyOutcome routes the run to infra-fail/retry, symmetric with the
   *  selection path's `isCaptureFailure` throw. Undefined elsewhere ⇒ no effect. */
  captureClass?: DoneTimeCaptureClass
  /** T-202/F6 stream-tap signals (single-pass path only). */
  firstEditFile?: string
  editCount?: number
  /** Successful SOURCE edits (excludes test/scratch edits) — same predicate the
   *  `lost-edits` capture classifier uses. The capture-miss guard gates on THIS,
   *  not raw {@link editCount}: a test-only-edit timeout (raw editCount>0,
   *  sourceAppliedEditCount=0) must NOT be mislabeled a capture-desync infra fail. */
  sourceAppliedEditCount?: number
  turnsToFirstEdit?: number
  /** T-601 — did a repair round clear the (primary-rail) validator? Only set on
   *  the repair path; undefined on single-pass. Used to derive
   *  `primaryRailRedAfterRepair` for the escalation decision (telemetry). */
  validated?: boolean
  /** T-3 OBSERVE-ONLY — the clearing round went green on exit code while its typed
   *  rail predicate was evaluable AND mismatched (the false green a predicate-aware
   *  gate would catch). Repair path only; undefined on single-pass ⇒ measurement
   *  null (no rail ⇒ no false-green signal). */
  primaryFalseGreen?: boolean
  /** jun-18 RCA OBSERVE-ONLY — the primary rail still rejected a patch whose repro
   *  stdout classified RESOLVED (false RED). Repair path only; undefined on single-
   *  pass ⇒ measurement null. */
  primaryFalseRed?: boolean
  /** jun-28 A2 — final repair-gate authority decision (observe-only). */
  repairValidationDecision?: import("../repair/decision").ValidationDecision
  /** jun-30 SOTA++ — winning acceptance rerank tier (observe-only). Set only when
   *  the `acceptance` opt-in routed selection through the ladder; undefined on
   *  legacy validator-rank. `all_patches` ⇒ the oracle gave no real selection. */
  acceptanceTier?: RerankTier
  /** Number of repair/verify rounds consumed when verify-first ran. */
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
  ownerWidening?: OwnerWideningTelemetry
  /** #6 submit-review (QUANTA_BENCH_SUBMIT_REVIEW): observe-only verdict over the
   *  final captured patch (clean / empty / test-edits). Absent ⇒ knob off. */
  submissionReview?: SubmissionReview
  /** Spec step-5 (QUANTA_BENCH_REPRO_VIABILITY): observe-only fix-free viability
   *  label over the captured patch vs the ACTUAL reproducing test source. Telemetry
   *  only — reject-mode NOT wired. Absent ⇒ knob off ⇒ byte-identical. */
  reproViabilityReview?: ReproViabilityReview
}

export type RepairConfig = NonNullable<RunInstanceDeps["repair"]>

export interface HintReproContext {
  readonly posture: BenchPosture
  readonly precomputedHint: string
  readonly chaMultisiteSteer: string | undefined
  readonly chaRepairTargets: readonly ChaRepairTarget[]
  readonly localizeCandidates: readonly string[]
  readonly reproHint: string | undefined
  readonly reproTest: BenchReproTestTelemetry | undefined
  /** CANONICAL reproducing sources — the submit-gate oracle set (jun-23 split). */
  readonly reproSources: readonly string[]
  /** Advisory HARDENING reproducing sources — repair seeding only (jun-23 split). */
  readonly hardeningReproSources: readonly string[]
}

export interface PreparedAttemptContext extends HintReproContext {
  readonly state: BenchKnobState
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly closureSession: ClosureSessionState | undefined
  readonly verificationPlan: ClosureSessionState["bundle"]["plan"] | undefined
  readonly existingTestExpectations: readonly string[]
  readonly ownerNearRegressionSet: readonly string[]
  readonly primaryRailStep: PrimaryRailStep | undefined
  readonly closureHint: string | undefined
  readonly intakeLlmEvidence: LlmEvidencePacket
  readonly effectiveRepair: RepairConfig | undefined
  readonly repairGateEligible: boolean
  readonly gateDecisionVerify: boolean
  readonly runRepair: boolean
  /** Typed strict-admission LSP grounding proof (LSP-01/LSP-02). Present only
   *  for presets that require live grounding; carried into the per-instance
   *  result so the report/CLI render the SAME receipt the gate decided on. */
  readonly lspGrounding: LspGroundingReceipt | undefined
}

export const cleanUniqueList = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value === "" || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export const stage1FilesOf = (
  files: readonly string[],
): readonly { file: string; score: number }[] =>
  files.map((file, i) => ({
    file,
    score: files.length - i,
  }))

export const readSandboxSource = (sandbox: string, rel: string): string | null => {
  try {
    return readFileSync(join(sandbox, rel), "utf8")
  } catch {
    return null
  }
}
