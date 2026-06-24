/**
 * Single-instance SWE-bench-style runner — top-level orchestration.
 *
 * Prepares an isolated sandbox copy of the instance repo (the corpus is NEVER
 * mutated), runs a real agent (runAgent + defaultTools) against the problem
 * statement, then runs the instance's testCmd (or the Python harness) to
 * decide pass/fail and captures a unified diff of the sandbox as the produced
 * patch.
 *
 * This file is the ONLY place that ties the eval sub-slice together:
 *   sandbox.create → env-prep.run → snapshot.withSnapshot(runAgent) →
 *   verdict.verify → report.emit*. Each step lives in its own sibling module
 *   (sandbox.ts / env-prep.ts / snapshot.ts / verdict.ts / report.ts / exec.ts).
 *
 * Behavior is byte-identical to the pre-decompose `src/apps/bench/runner.ts`;
 * this is a pure structural refactor.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import {
  type AgentConfig,
  type AgentlessLocalizeDeps,
  type AgentlessLocalizeResult,
  agentlessLocalize,
  buildSystemPrompt,
  composeAgentlessHint,
  composeIssueHint,
  executeReproTests,
  extractIssueHint,
  generateReproTests,
  lspBinaryAvailable,
  lspExtensionToLanguage,
  lspNavToolList,
  proveStrictLspReady,
  pytestReportPathFor,
  type ReproExecPort,
  type ReproReadFilePort,
  type ReproTestConfig,
  type ReproTestSelection,
  type ReproWriteFilePort,
  runAgent,
  type StopReason,
  selectReproTest,
  wireOptionalAgentPorts,
} from "@/agent"
import {
  evaluateSuccessPredicate,
  type OwnerSibling,
  type PrimaryRailStep,
  resolveOwnerSiblings,
} from "@/agent/closure"
import { evictLspWorkspaces } from "@/agent/lsp-bridge"
import {
  FIND_REFS_STEER,
  LSP_GROUNDING_STEER,
  SPEC_FIDELITY_STEER,
} from "@/agent/localize-phase-guard"
import { decideEscalation, type EscalationDecision } from "@/agent/repair-escalation"
import type { ReproTestCandidate } from "@/agent/repro-test/types"
import { extractIssueDeclaredExpected, extractIssueRepro } from "@/agent/verification-plan"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { presetRequiresLiveLspGrounding } from "@/runner/knobs"
import type { LocalizeBudgetValue } from "@/runner/knobs/knobs/localize-budget"
import {
  byteCompare,
  errMessage,
  filesFromUnifiedDiff,
  foldGroundingReceipts,
  gateDisabled,
  gateOn,
  isRealGroundingFailure,
  type LspGroundingReceipt,
  normalizePublicIssueText,
  renderLspGroundingStatus,
} from "@/shared"
import { setKnobOverride } from "@/shared/knob-overrides"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Tool } from "@/tool"
import { astGrepTool, buildDefaultTools, findReferencesTool, ToolRegistry } from "@/tool"
import { localizeTool } from "@/tool/localize"
import { testRunnerTool } from "@/tool/test-runner"
import { reproRunArgv } from "../corpus/dataset"
import { type AttemptObservation, BenchObserver, UsageTap } from "../observe"
import type {
  BenchAttemptOutcome,
  BenchReproTestTelemetry,
  Instance,
  InstanceResult,
  OwnerWideningTelemetry,
  ReproOracleCalibration,
} from "../types"
import { ADAPTIVE_ACTIONS, runAdaptiveBenchAttempt } from "./adaptive-escalation"
import { buildAdaptiveRouterModelCall } from "./adaptive-escalation/live-model-call"
import { computeAdaptedTimeout } from "./adaptive-timeout"
import { type CandidateFamily, candidateFamilyCoverageMissing } from "./candidate-families"
import {
  buildMultisiteSteer,
  type ChaRepairTarget,
  findEnclosingPythonMethod,
  findSiblingOverrideSites,
  type SiblingOverrideSite,
} from "./cha-multisite"
import {
  buildClosureSession,
  buildPhasePatchHygiene,
  type ClosureSessionState,
} from "./closure-session"
import { type DoneTimeCaptureClass, isCaptureFailure } from "./capture-correctness"
import { diffTouchedSymbols } from "./diff-touched-symbols"
import { runEnvPrep } from "./env-prep"
import { exec, execArgv } from "./exec"
import { coeditFamilyCoverageCandidate } from "./family-coverage-coedit"
import { traceForwardLocalizeOwners } from "./forward-localize-trace"
import { validateGoldPatch } from "./gold-sanity"
import {
  applyBenchKnobs,
  type BenchIssueHintMode,
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  knobsForReport,
  resolveBenchKnobs,
} from "./knobs-bench"
import {
  assertEvidenceTextBlind,
  buildCandidatePostReviewLlmEvidencePacket,
  buildIntakeLlmEvidencePacket,
  buildSelectionExplanationPacket,
  buildSelectionOwnerEvidence,
  type CandidateEditSurfaceFact,
  candidatePatchHash,
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  type LlmEvidencePacketStage,
  type MissingEvidenceFact,
  ownerTestResultReceipt,
  type ProofReceiptFact,
  recordLlmEvidencePacket,
  type SelectionGenerationPromptInput,
  toPhaseRoutingContract,
  type VerificationTargetFact,
  verificationTargetFromPlan,
} from "./llm-evidence-packet"
import { prepareMweProofSelectionPort } from "./mwe-proof-port"
import { noPatchExhaustedErrorOf, wireNoPatchBreaker } from "./no-patch-breaker-adapter"
import { buildPhasePatchBudget } from "./patch-budget-admission"
import { probePatchStaticSanity } from "./patch-static-sanity"
import { composePromptPrelude, composePromptText } from "./prompt-augment"
import {
  installProjectEnvPythonShim,
  projectEnvPythonShimLocalEnv,
} from "./project-env-python-shim"
import { buildCleanSelectionAuthorityContracts } from "./public-contract-bundle"
import type { SelectionContractBundle } from "./public-contract-types"
import { toRegressionGreen } from "./regression-oracle"
import { makeBenchRegressionOracle } from "./regression-oracle-adapter"
import {
  candidatePatchAppliesCleanly,
  materializeBuildEnv,
  withCandidatePatch,
} from "./rematerialize"
import { runRepairRounds } from "./repair/index"
import { buildRepairRoundSeedMessage } from "./repair/llm-evidence"
import {
  drainReproVoteOutcomes,
  makeReproVoteValidate,
  resetReproVoteOutcomes,
  summarizeReproVoteOutcomes,
} from "./repair/repro-vote"
import {
  makePatchedResolvedConsensus,
  makePatchedResolvedConsensusProof,
} from "./repair/resolved-consensus"
import type {
  BuildRepairContextArgs,
  RunOnceResult,
  ValidateArgs,
  ValidatorResult,
} from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import {
  benchInstallsReproHint,
  benchRunsRepairPhase,
  benchShouldRunRepairPhase,
  primaryRailRedAfterRepair,
} from "./repair-phase-policy"
import {
  makeDiscoveredRepoRegressionPort,
  makeDiscoveredRepoRegressionProofPort,
} from "./repo-regression-discovery-adapter"
import {
  buildWiring,
  emitPatch,
  emitSandbox,
  emitVerify,
  NullStream,
  ObservationError,
  type Wiring,
} from "./report"
import { reproValidationCmd } from "./repro-command"
import { calibrateReproOracle, unavailableReproOracleCalibration } from "./repro-oracle-calibration"
import {
  type AttemptOutcome,
  classifyOutcome,
  DEFAULT_POLICY,
  parseRetryTransientEnv,
  type RetryPolicy,
  runRetryLoop,
} from "./retry-policy"
import { cleanupSandbox, copyRepo, createSandbox, forkSandbox } from "./sandbox"
import { labelForReceipt, type ReceiptEvidence, researchKnobTouched } from "./score-label"
import {
  buildSelectionStructuralPlan,
  composeSelectionAgentHint,
  prepareSelectionEvidenceContext,
  withCandidateFamilyAuthorityContracts,
} from "./selection-assembly"
import {
  type Candidate,
  type DerivedCandidateStructuralRepair,
  filesFromPatch,
  runSelection,
  type SelectionPorts,
  type SelectionTelemetry,
  summarizeSelection,
} from "./selection-executor"
import { selectionGenerationErrorOf } from "./selection-generation-error"
import { buildSelectionRiskGate } from "./selection-risk-gate"
import { prepareIssueSmokeSelectionPort } from "./selection-smoke"
import { createSessionScopedSignal, withSessionScopedSignal } from "./session-signal"
import { normalizeRepoPath } from "./impacted-test-discovery"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"
import { witnessStructuralOwnerCandidates } from "./static-witness"
import {
  buildAstStaticWitnesses,
  type StaticWitnessDiagnostic,
  staticWitnessLanguageDiagnostics,
} from "./static-witness-adapter"
import { BenchStreamTap, relFromSandbox } from "./stream-tap"
import { type PythonSwebenchEvaluate, verify } from "./verdict"
import { extractVerificationOwnerTestExpectations } from "./verification-owner-test-expectations"
import { discoverVerificationOwnerTests } from "./verification-owner-tests"

export {
  buildSelectionCandidateFamilyBundle,
  cleanSelectionPromptEnabled,
  composeSelectionAgentHint,
  selectionGenerationEnvCaveats,
  withCandidateFamilyAuthorityContracts,
} from "./selection-assembly"

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
   * called fresh for each solve / repair round / verify-select candidate so
   * meter state never leaks across independent agent runs.
   *
   * Absent (default) ⇒ no budget meter is wired and the loop stays
   * byte-identical to the pre-budget path.
   */
  budgetMeterFactory?: () => AgentConfig["budgetMeter"]
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
    validate?: (args: ValidateArgs) => Promise<ValidatorResult>
    buildContext?: (args: BuildRepairContextArgs) => string
  }
  /**
   * Measurement-stability slice: knob-aware adaptive timeout + transient-retry
   * loop. ABSENT (default) ⇒ feature OFF (byte-identical single-pass path) —
   * `deps.timeoutMs` is the deadline, retries are not attempted, and the
   * `budget` field is omitted from `InstanceResult`. PRESENT ⇒ the driver:
   *   1. resolves the bench-surface knob state from `process.env`;
   *   2. computes `adaptedTimeoutMs = baseMs * Σ(active costMultipliers)`
   *      clamped to 30 min, and uses that as the per-attempt deadline;
   *   3. runs up to `maxAttempts` attempts, classifying each `InstanceResult`
   *      and retrying ONLY transient outcomes (empty-patch / infra-fail).
   *   4. stamps `result.budget` with the per-attempt history.
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

/** Solve directive for real SWE-bench tasks, grounded in observed 0/5 failure
 *  modes: full-file rewrites → 180KB diffs that break PASS_TO_PASS; agents
 *  editing tests/ (discarded by the source-only grader); plausible-but-wrong
 *  fixes with no verification loop. Appended to the task message only when
 *  `instance.swebench` is set (custom-corpus runs unaffected). */
/** Anti-semantic-over-engineering steer absorbed from OpenHands'
 *  `system_prompt_tech_philosophy.j2` (Linus "good taste" mode) + mini-swe's
 *  minimal posture — the methodology delta that lets those scaffolds solve the
 *  #13417 class on the SAME model where quanta over-engineers. Targets SEMANTIC
 *  over-engineering (a small diff that still reaches for runtime/compiler APIs
 *  or invents a helper), which the existing diff-SIZE rules do not catch. */
const SIMPLICITY_STEER =
  "Prefer the SIMPLEST mechanism that already exists. If a plain attribute or " +
  "field on the object already holds the answer, read it DIRECTLY — do NOT build " +
  "or call a runtime/execution/compiler object (or re-run the operation) and do " +
  "NOT add a new helper method, function, or class when editing the existing " +
  "expression in place would do. Eliminating a special case beats adding a branch " +
  "or a new abstraction; ask 'is there a one-line change to the existing code?' " +
  "before writing new code. Remove any reproduction script or downloaded file you " +
  "created so only the real source fix remains."

// REMOVED (jun-22): benchmark-overfit issue-keyword directive steers
// (MESSAGE_FORMAT / ADAPTER_FAMILY / EXECUTION_ENV_BOUNDARY + their RCA variants).
// They hard-coded specific SWE-bench instances' gold-patch recipes (astropy
// TimeSeries required-columns, django TIME_ZONE backend, django PostgreSQL dbshell)
// into prompt steers triggered by keyword-matching the issue text — answer-key /
// leaderboard-gaming, banned by the no-heuristic-authority rule. The structural
// steers (LSP grounding / find-refs / spec-fidelity / simplicity / sibling-
// completion) remain: they are general method guidance, not instance-tuned.

/** Lever A — SIBLING-COMPLETION / co-change consequence check (2026-06-19,
 *  ceiling RCA). Measured failure mode on the multi-file ceiling subset: quanta
 *  localizes the OWNER file correctly (often gold-identical) but STOPS there and
 *  misses the COUPLED sibling file the fix also requires (matplotlib cm.py edit
 *  needs colors.py `__eq__`; django related.py needs forms/models.py). The
 *  adversarial audit showed the sibling usually IS reachable by symbol (cm.py
 *  uses colors.LinearSegmentedColormap; related.py references forms.Model-
 *  ChoiceField) — the agent simply never follows the link or asks "what does my
 *  change break elsewhere". This steer forces the LSP traversal + ripple check.
 *  Complements the WS2 grep feeder (tool-found siblings) with model-driven LSP
 *  discovery. Knob-gated `QUANTA_BENCH_SIBLING` (default-OFF for clean A/B). */
const SIBLING_COMPLETION_STEER =
  "Many fixes span MORE THAN ONE file. KEEP your primary fix exactly where it is " +
  "— never move it to another file. Then, ADDITIVELY, run a co-change check: for " +
  "every symbol your edit touches or whose behavior it changes (a renamed/added " +
  "attribute, a changed return or raise, an altered comparison, a new kwarg you " +
  "pass), grep the symbol name (and/or use lsp_references) to find every OTHER " +
  "file that DEFINES or CONSUMES it. For each, ask: does my change break or " +
  "contradict what it assumes — its equality/hash, how it renders or consumes the " +
  "value, or its parallel layer (a form field paired with a model field, a " +
  "registry paired with the object it stores)? If yes, ADD an edit to that file " +
  "TOO — on top of, not instead of, your primary edit. Your FINAL diff must " +
  "contain BOTH the primary file AND every coupled file; dropping either one " +
  "fails the hidden tests. Verify both before you stop."

const BASH_VERIFY_MODE_STEER =
  '- Tool mode: when calling bash for any test, reproducer, or verification command, set mode:"write". Reserve bash mode:"read" for passive inspection only (ls/rg/cat/git diff); read mode rejects verification runtimes instead of running them under a read-only sandbox.'

const SWEBENCH_DIRECTIVE = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Reproduce first: from the issue, construct the concrete failing scenario",
  "  (the exact input/call the issue describes) and confirm it currently",
  "  misbehaves before you edit.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- MANDATORY before you stop: after your final edit, run the repository's",
  "  existing test(s) most specific to the changed code AND your reproduction",
  "  of the issue. If anything fails, iterate. Do NOT stop right after an edit",
  "  without running tests — an unverified edit is the #1 cause of failure.",
  BASH_VERIFY_MODE_STEER,
  "- Keep the final diff minimal and isolated to the fix.",
  "- When using apply_patch, produce V4A format: start with '*** Begin Patch',",
  "  then per file '*** Update File: path/to/file.py', then lines prefixed '+' (add),",
  "  '-' (remove), ' ' (context, one space then the line), then '*** End Patch'.",
  "- If tests fail with ModuleNotFoundError, set PYTHONPATH=. before pytest to",
  "  ensure the repo root is on sys.path (e.g. PYTHONPATH=. python -m pytest ...).",
].join("\n")

/**
 * LEAN, low-prescription variant of {@link SWEBENCH_DIRECTIVE} — selected by the
 * `QUANTA_BENCH_LEAN_PROMPT` knob (Sonar absorption, P2, default-OFF).
 *
 * WHY: Sonar measured that LESS-prescriptive prompts score HIGHER for capable
 * models (two-stage 58% → free-workflow 70% → less-prescriptive + extended
 * thinking 75%). Our verbose directive plus the lspSteer / specSteer /
 * simplicitySteer / siblingSteer bolt-ons micromanage the workflow and may CAP
 * gpt-5.4. This arm encodes Sonar's 3 principles ONLY, high-level, and FOLDS the
 * bolt-on steers' intent in (smallest-change / in-place edit / source-only), so
 * when the knob is ON those steers are omitted — see `composeBaseText`. It is a
 * PARALLEL alternative; the verbose path is untouched and OFF is byte-identical.
 */
const SWEBENCH_DIRECTIVE_LEAN_HEAD = [
  "",
  "",
  "You are fixing a real defect in this repository. An automated grader runs",
  "hidden tests against ONLY your source changes.",
  "- Never modify, add, or delete any test file.",
  "- Solve it the way the problem warrants — reproduction, code inspection, or",
  "  test analysis — and make the SMALLEST change that fixes the root cause. Edit",
  "  the existing code in place; do not add helper methods or reach for runtime",
  "  APIs when an in-place edit works.",
  "- Change source code ONLY; never rewrite or reformat whole files. Your final",
  "  unified diff is the submission.",
]

const SWEBENCH_DIRECTIVE_LEAN_FULL = [
  ...SWEBENCH_DIRECTIVE_LEAN_HEAD,
  "- Test-driven: reproduce the issue with a small script, fix it, then verify",
  "  with your reproducer AND by finding and running the repository's own",
  "  relevant regression tests.",
  BASH_VERIFY_MODE_STEER,
].join("\n")

const SWEBENCH_DIRECTIVE_LEAN_REPRO_ONLY = [
  ...SWEBENCH_DIRECTIVE_LEAN_HEAD,
  "- If useful, reproduce the issue with a small script and verify with that",
  "  focused reproducer. Do NOT run the repository test suite, pytest, tox, or",
  "  broad regression sweeps yourself; the grader owns full verification.",
  BASH_VERIFY_MODE_STEER,
].join("\n")

const SWEBENCH_DIRECTIVE_LEAN_NOEXEC = [
  ...SWEBENCH_DIRECTIVE_LEAN_HEAD,
  "- Do NOT run the repository test suite, pytest, tox, or ad-hoc validation",
  "  commands yourself. Make the smallest correct source change and stop; the",
  "  grader decides in the correct environment.",
].join("\n")

/**
 * Edit-and-submit variant of {@link SWEBENCH_DIRECTIVE} — used when the
 * `bench-in-loop-exec` mode resolves to `"off"`.
 *
 * Keeps every source-discipline rule (source-only, smallest change, no test
 * edits, no git-checkout, V4A format) but DELETES the "Reproduce first" and the
 * "MANDATORY ... run the repository's existing test(s) ... iterate" clauses. On
 * instances whose host test-env is incompatible with the pinned deps, that
 * mandate is unsatisfiable (`python -m pytest` → collection error), so the model
 * flails until budget exhaustion and aborts with an empty patch. The grader runs
 * the tests in the correct per-instance docker env at grading time, so in-loop
 * execution is not required to produce a correct patch.
 */
const SWEBENCH_DIRECTIVE_NOEXEC = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- The automated grader runs the repository's tests for you in a correct",
  "  environment. Do NOT run the test suite, pytest, or tox yourself — this repo",
  "  is checked out without its test dependencies, so test commands will fail",
  "  spuriously and only waste turns. Make the smallest correct source change",
  "  and stop; an unverified edit is fine — the grader decides.",
  "- Keep the final diff minimal and isolated to the fix.",
  "- When using apply_patch, produce V4A format: start with '*** Begin Patch',",
  "  then per file '*** Update File: path/to/file.py', then lines prefixed '+' (add),",
  "  '-' (remove), ' ' (context, one space then the line), then '*** End Patch'.",
].join("\n")

/**
 * Focused execution variant between FULL and NOEXEC. It keeps the mini-swe
 * source-discipline rules, still forbids broad repo-test execution, but allows
 * a tiny direct reproducer when the issue can be demonstrated narrowly.
 */
const SWEBENCH_DIRECTIVE_REPRO_ONLY = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- If useful, you MAY run a tiny issue reproducer or a focused script that",
  "  demonstrates the bug directly. Do NOT run the repository test suite,",
  "  pytest, tox, or broad regression sweeps yourself; the grader owns full",
  "  verification in the correct environment.",
  BASH_VERIFY_MODE_STEER,
  "- Keep the final diff minimal and isolated to the fix.",
  "- When using apply_patch, produce V4A format: start with '*** Begin Patch',",
  "  then per file '*** Update File: path/to/file.py', then lines prefixed '+' (add),",
  "  '-' (remove), ' ' (context, one space then the line), then '*** End Patch'.",
].join("\n")

/** Pre-composed steer lines (already include their leading `\n-` separator, or
 *  are `""` when their gate is off). Factored into a record so {@link composeBaseText}
 *  can append them verbatim in the OFF path and drop them all in the LEAN path. */
interface SteerLines {
  readonly lsp: string
  readonly findRefs: string
  readonly spec: string
  readonly simplicity: string
  readonly sibling: string
}

/**
 * Compose the bench user-message base text. Pure (no env reads) so it is
 * unit-testable directly. Two parallel arms, selected by `leanPrompt`:
 *
 *  - OFF (default, byte-identical to the pre-knob composition): the in-loop /
 *    no-exec verbose directive followed by every gated steer line.
 *  - LEAN ON (`QUANTA_BENCH_LEAN_PROMPT`): the SHORT lean-directive family
 *    INSTEAD of the verbose directive, but STILL preserving the caller's
 *    execution authority mode (`full` / `repro-only` / `off`). The bolt-on
 *    steers (lsp / spec / simplicity / sibling) are OMITTED — LEAN folds their
 *    intent in. The tool-availability `findRefs` steer is retained (it only
 *    names an actually-wired tool and is default-OFF itself).
 *
 * Non-swebench instances always return `base` unchanged on both arms.
 */
const composeBaseText = (
  base: string,
  isSwebench: boolean,
  inLoopExecMode: "full" | "repro-only" | "off",
  steers: SteerLines,
  leanPrompt: boolean,
): string => {
  if (!isSwebench) return base
  if (leanPrompt) {
    const leanDirective =
      inLoopExecMode === "full"
        ? SWEBENCH_DIRECTIVE_LEAN_FULL
        : inLoopExecMode === "repro-only"
          ? SWEBENCH_DIRECTIVE_LEAN_REPRO_ONLY
          : SWEBENCH_DIRECTIVE_LEAN_NOEXEC
    return `${base}${leanDirective}${steers.findRefs}`
  }
  const directive =
    inLoopExecMode === "full"
      ? SWEBENCH_DIRECTIVE
      : inLoopExecMode === "repro-only"
        ? SWEBENCH_DIRECTIVE_REPRO_ONLY
        : SWEBENCH_DIRECTIVE_NOEXEC
  return `${base}${directive}${steers.lsp}${steers.findRefs}${steers.spec}${steers.simplicity}${steers.sibling}`
}

/**
 * BENCH-INTENTIONAL OPT-OUTS (Codex absorption Phases 0-8 + Round 3):
 * the SWE-bench grader is byte-sensitive (the official Python harness diffs
 * the agent's patch against the reference), so the bench harness deliberately
 * omits every optional Codex-absorption knob below. The agent runs in the
 * *plainest possible posture* — only the cache lever (ADR-0004), compaction
 * (ADR-0011), and `verifyGuard` (ADR-0013, when explicitly enabled by the
 * caller) are touched. The omissions are NOT oversight; reintroducing them
 * would change measurement integrity:
 *
 *   - `mode`             — bench is plain "default" (no plan/review/audit
 *                          posture forcing); the agent's task is the diff,
 *                          not the report shape.
 *   - `repoRules`        — sandbox repo's own `CONTRIBUTING.md`/etc. is not
 *                          loaded as agent authority; bench measures the
 *                          agent's intrinsic skill, not its rule-reading.
 *   - `hitl`             — bench is unattended (`acceptEdits` permission);
 *                          a HITL gate would deadlock on every confirm.
 *   - `closeoutGuard`    — closeout reminders shape report text, not patch
 *                          contents; bench measures patches.
 *   - `workingState`     — L3 scratchpad rides the reminder and changes the
 *                          turn-context bytes; bench keeps a stable prompt.
 *   - `skills`           — skill discovery + active-skills block likewise
 *                          shifts the per-turn reminder.
 *
 * Opt-in flags added (A/B measurement; default-OFF preserves byte-identity):
 *   - QUANTA_BENCH_LSP=1            wire LSP nav tools (OR with QUANTA_LSP_TOOLS=full)
 *   - QUANTA_BENCH_SUBAGENT=1       wire `subagent` AgentConfig block
 *   - QUANTA_BENCH_SKILLS=1         wire `skills` AgentConfig block (bundled-only)
 *   - QUANTA_BENCH_BRANCH_SEARCH=K  wire `branchSearch` AgentConfig block with
 *                                   `defaultN=K` (Agentless N-best, ADR-0084).
 *                                   K must be an integer >= 2 (1-best ≡ baseline
 *                                   ⇒ ignored; non-integer / NaN / negative /
 *                                   garbage ⇒ ignored). Cost scales ~K× vs
 *                                   baseline — keep OFF unless measuring N-best.
 *                                   NOT auto-enabled for `instance.swebench` —
 *                                   explicit opt-in only (cost discipline).
 *  See {@link benchOptIns} (just below) for the resolver — the BENCH-INTENTIONAL
 *  posture is unchanged when all four are unset. If a future bench mode wants
 *  any of the other listed knobs, add another opt-in flag — do NOT remove this
 *  comment block without an accompanying measurement-integrity ADR.
 */

/** Parse `QUANTA_BENCH_BRANCH_SEARCH` to a positive integer K>=2. Returns
 *  `undefined` for every other shape (absent / `"0"` / `"1"` / negative /
 *  non-integer / NaN / garbage / empty / whitespace) — the gate is *strict*
 *  by design (K=1 is byte-identical to baseline, so wiring it would only add
 *  overhead without measurement effect). Exported for direct unit + hellgate.
 *
 *  No heuristics: K bounds match the slice's own `tool.ts` zod schema
 *  (`.min(2).max(8)`). K>8 is rejected here too so a misconfigured env can't
 *  cause the model to emit a request the tool would reject at runtime. */
export const parseBenchBranchSearchK = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  // Trim whitespace; empty after trim ⇒ unset.
  const s = raw.trim()
  if (s === "") return undefined
  // Reject if the trimmed string contains any internal whitespace (e.g.
  // "1 2"), or anything that isn't a leading optional sign + digits.
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  // K<2 ⇒ 1-best ≡ baseline; K>8 ⇒ matches slice's hard cap (tool.ts zod
  // `.min(2).max(8)`). Out-of-range ⇒ ignored (don't silently clamp).
  if (n < 2 || n > 8) return undefined
  return n
}

/** SWE-bench A/B opt-in resolver. EVERY flag default-OFF; an unset env yields
 *  `{ lspNav:false, subagent:undefined, skills:undefined, branchSearch:undefined }`
 *  and `buildConfig` is byte-identical to the BENCH-INTENTIONAL posture above.
 *  Exported for direct unit testing — four independent env reads, no
 *  cross-coupling.
 *
 *  Slice-isolation choice: the CLI has cousins (`buildSubagentConfig` /
 *  `buildSkillsConfig` in `src/apps/cli/internal.ts`) but they read DIFFERENT
 *  env keys (`QUANTA_SUBAGENT` / `QUANTA_SKILLS_DIR` + a `--skills` argv
 *  check). Bench needs its OWN bench-only gate so a `QUANTA_SUBAGENT=1`
 *  exported in a dev shell does NOT silently leak into measurement runs.
 *  Inline duplication is intentional: ~3 lines per builder, isolated test
 *  surface, no `apps/bench → apps/cli` import dependency. */
/**
 * Issue-hint mode resolved from `QUANTA_BENCH_ISSUE_HINT`:
 *   - `"off"`       — flag unset OR value not in the accept-list. Default-OFF
 *                     posture: byte-identical to the pre-feature path.
 *   - `"regex"`     — `=1` / `=on`. The legacy regex extractor
 *                     (`extractIssueHint` + `composeIssueHint`) runs synchronously
 *                     inside `buildConfig`. Pre-existing behavior — kept stable.
 *   - `"agentless"` — `=agentless`. The new LLM-driven path (Agentless paper
 *                     Stage 1). Async pre-compute via `prepareIssueHint`; on any
 *                     failure the wiring falls back to `regex`.
 *
 * Strict accept-list — anything else (`true`, `yes`, garbage) ⇒ `off`. */
export type IssueHintMode = BenchIssueHintMode

/**
 * SWE-bench A/B posture resolver — now a THIN PROJECTION over the unified
 * preset/knob framework (`resolveBenchKnobs` → `benchPostureFromState`), NOT a
 * pile of raw `process.env` reads. This is the chokepoint both `buildConfig`
 * (config fields) and the apps driver (`issueHintMode` / `reproTestK` /
 * `retryTransient`) consume, so a selected preset (`QUANTA_BENCH_PRESET=...`,
 * or the `QUANTA_BENCH_SOTA=1` alias) ACTUALLY drives the run — and the same
 * resolved state feeds the telemetry report, so report == applied by
 * construction (no more report-lie).
 *
 * Layering (handled inside `resolveBenchKnobs`): explicit `QUANTA_BENCH_*` env
 * var > preset value > knob default. With no preset and no env, every field is
 * OFF/undefined — byte-identical to the historical baseline.
 *
 * The legacy `parseBenchBranchSearchK` / `parseLocalizePhaseEnv` exports below
 * are retained for the unit/hellgate tests that pin the parsers directly; the
 * production parse now happens inside the framework knobs (verbatim-migrated).
 */
export const benchOptIns = (): BenchPosture =>
  benchPostureFromState(resolveBenchKnobs({ envVars: process.env }), process.env)

/** Pure parser for the `QUANTA_BENCH_LOCALIZE_PHASE` env var. Exported for
 *  direct unit testing — keeps the resolver above one-line readable.
 *
 *  Domain (ACTIVE):
 *    - The string parses to a finite integer N in [1, 20] ⇒ `{ phase1Turns: N }`.
 *
 *  Domain (INACTIVE, all return `undefined`):
 *    - absent / empty string
 *    - non-numeric ("garbage", "1.5", "abc")
 *    - 0 / negative / NaN / Infinity
 *    - > 20 (measurement-integrity cap)
 *
 *  Closed parser: explicit `Number.isFinite` + `Number.isInteger` checks (no
 *  `parseInt`-then-coerce that would silently swallow "1abc" as 1). */
export const parseLocalizePhaseEnv = (
  raw: string | undefined,
): AgentConfig["localizePhase"] | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  // Use Number(...) (NOT parseInt) so "1abc" / "1.5" cleanly become NaN /
  // non-integer and fail the validity check — no partial-parse foot-gun.
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 1) return undefined
  if (n > 20) return undefined
  return { phase1Turns: n }
}

/** Source file extensions enumerated for Agentless localization. The set
 *  matches Agentless paper §4 (Python is the SWE-bench corpus; we additionally
 *  include common companion languages for non-SWE-bench harnesses). Tests are
 *  excluded by directory walk (see `isExcludedDir`) — the grader supplies its
 *  own tests, so test-file localization is wasted budget. */
const SOURCE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
])

/** Directories that NEVER contain source code we want the LLM to consider:
 *    - `test`/`tests`              — grader supplies its own; agent edits are
 *                                    discarded (see SWEBENCH_DIRECTIVE)
 *    - `node_modules`/`vendor`/etc — third-party
 *    - `.git`/`.venv`/`__pycache__`— infra noise
 *    - `dist`/`build`/`target`     — build artifacts */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "test",
  "tests",
  "testing",
  "__tests__",
])

/** Hard cap on the file-tree walk — defensive against pathological repos.
 *  Above this we stop walking and return whatever we collected. */
const MAX_WALK_FILES = 5_000

/** Enumerate source-file relative paths under `repoRoot`. Excludes tests,
 *  build artifacts, and version-control infra. Pure-ish (does I/O via
 *  `readdirSync` only — that is the contract of the function, called inside
 *  `prepareIssueHint`'s fileTree dep). Returns an empty array on any thrown
 *  syscall (repo doesn't exist, permission denied, …); the caller falls back
 *  to regex extraction in that case. */
/** Classify one directory entry as either a child-dir-to-descend, a source-
 *  file relative path, or nothing-of-interest. Pure helper — splitting it
 *  out keeps `enumerateRepoSources` under biome's complexity ceiling. */
const classifyDirent = (
  e: Dirent,
  dir: string,
  repoRoot: string,
): { kind: "dir"; path: string } | { kind: "file"; rel: string } | undefined => {
  const name = e.name
  if (typeof name !== "string" || name.length === 0) return undefined
  const full = join(dir, name)
  if (e.isDirectory()) {
    if (EXCLUDED_DIRS.has(name)) return undefined
    // Hidden dirs (starting with ".") are infra (`.git`, `.cache`, …) — never
    // descend; SOURCE_EXTENSIONS doesn't gain anything from them.
    if (name.startsWith(".")) return undefined
    return { kind: "dir", path: full }
  }
  if (!e.isFile()) return undefined
  const dot = name.lastIndexOf(".")
  if (dot === -1) return undefined
  const ext = name.slice(dot)
  if (!SOURCE_EXTENSIONS.has(ext)) return undefined
  // Relative path — normalize separators to forward-slash so paths match what
  // the LLM sees in GitHub-style issue text.
  const rel = relative(repoRoot, full).split(sep).join("/")
  if (rel.length === 0) return undefined
  return { kind: "file", rel }
}

export const enumerateRepoSources = (repoRoot: string): string[] => {
  const out: string[] = []
  const stack: string[] = [repoRoot]
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[]
    try {
      // `withFileTypes: true` + string encoding returns Dirent<string>[];
      // the Node typings ship Dirent<Buffer | string> generics, so we
      // annotate explicitly to keep TS happy on every Node 20+ version.
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      continue
    }
    for (const e of entries) {
      const c = classifyDirent(e, dir, repoRoot)
      if (c === undefined) continue
      if (c.kind === "dir") stack.push(c.path)
      else out.push(c.rel)
    }
  }
  return out
}

const LSP_EXTENSION_TO_LANGUAGE = lspExtensionToLanguage()

interface BenchLspProbeTarget {
  readonly bin: string
  readonly rel: string
  readonly count: number
}

/** Dominant LSP-mapped language across `rels` (highest mapped-file count; ties
 *  broken by bin name so the pick is deterministic). Shared by the whole-repo
 *  probe and the task-relevant (gold-patch) probe. */
const dominantBinOf = (rels: Iterable<string>): BenchLspProbeTarget | undefined => {
  const bins = new Map<string, { rel: string; count: number }>()
  for (const rel of rels) {
    const bin = LSP_EXTENSION_TO_LANGUAGE.get(extname(rel).toLowerCase())
    if (bin === undefined) continue
    const seen = bins.get(bin)
    if (seen === undefined) bins.set(bin, { rel, count: 1 })
    else seen.count += 1
  }
  let best: BenchLspProbeTarget | undefined
  for (const [bin, info] of bins) {
    if (
      best === undefined ||
      info.count > best.count ||
      (info.count === best.count && byteCompare(bin, best.bin) < 0)
    ) {
      best = { bin, rel: info.rel, count: info.count }
    }
  }
  return best
}

const dominantLspProbeTarget = (repoRoot: string): BenchLspProbeTarget | undefined =>
  dominantBinOf(enumerateRepoSources(repoRoot))

export class StrictLspGroundingDegradedError extends Error {
  /** The typed grounding receipt that triggered the degrade (LSP-02), so the
   *  per-instance result can render the SAME status even though the gate threw
   *  before a {@link PreparedAttemptContext} existed. Absent for the pre-probe
   *  failures (missing binary / no mapped language / nav disabled) where no
   *  receipt was produced. */
  readonly receipt?: LspGroundingReceipt
  constructor(message: string, receipt?: LspGroundingReceipt) {
    super(message)
    this.name = "StrictLspGroundingDegradedError"
    if (receipt !== undefined) this.receipt = receipt
  }
}

const verifyStrictPresetLspGrounding = async (
  posture: BenchPosture,
  sandbox: string,
  taskFiles?: readonly string[],
  signal?: AbortSignal,
): Promise<LspGroundingReceipt | undefined> => {
  const preset = posture.preset
  if (preset === undefined || !presetRequiresLiveLspGrounding(preset)) return undefined
  if (!posture.lspNav) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but LSP nav is disabled in the resolved posture.`,
    )
  }
  // Gate on the TASK-RELEVANT language first: the LSP server for the files THIS
  // instance actually edits (its gold-patch targets). A repo's incidental
  // C-extension subdir (astropy/utils/src/*.c) must NOT require clangd for a
  // Python task. The whole-repo fallback probe is a CAPPED (MAX_WALK_FILES),
  // filesystem-order-dependent walk whose "dominant" language flips between
  // identical runs (measured jun-21: astropy-7166 hard-failed turns=0 demanding
  // clangd on 1 of 3 identical runs). The gold-patch file list is small + stable,
  // so it identifies the worked-on language deterministically.
  const probe =
    (taskFiles !== undefined && taskFiles.length > 0 ? dominantBinOf(taskFiles) : undefined) ??
    dominantLspProbeTarget(sandbox)
  if (probe === undefined) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but this repo has no source file mapped to a configured language server.`,
    )
  }
  // Cheap launch preflight first (a missing binary needs no pool spawn).
  if (!(await lspBinaryAvailable(probe.bin))) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but ${probe.bin} is not launchable on PATH ` +
        `(dominant repo-language probe: ${probe.rel}, ${probe.count} file(s)).`,
    )
  }
  // READY proof (LSP-01): launchability is necessary but NOT sufficient. Drive
  // the real warm-backend readiness probe on the task-relevant anchor, in THIS
  // sandbox, so a launchable-but-cold workspace (ready_timeout / fatal transport)
  // fails the strict preset closed instead of silently degrading to no-nav. A
  // language with no warm pool returns a launch-stage `ok` (binary preflight is
  // the only authority there). An expected lifecycle cancel is non-fatal — the
  // attempt is being torn down anyway.
  const receipt = await proveStrictLspReady(join(sandbox, probe.rel), sandbox, probe.bin, signal)
  if (isRealGroundingFailure(receipt.outcome)) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but the task-relevant workspace did not ` +
        `reach verified-ready. ${renderLspGroundingStatus({
          backend: receipt.backend,
          language: receipt.language,
          [receipt.stage]: receipt.outcome,
          ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
          ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
        })} (anchor: ${probe.rel}).`,
      receipt,
    )
  }
  return receipt
}

export interface PrepareIssueHintDeps {
  /** Bench's main LLM port. The Agentless localizer reuses it (no separate
   *  cheaper-model wiring — adds one ~800-token call per instance, which is
   *  negligible against a 30-turn agent budget). */
  readonly llm: LLMPort
  /** Override for `enumerateRepoSources` — tests inject a deterministic
   *  fileTree. Production wiring uses `enumerateRepoSources(sandbox)`. */
  readonly fileTree?: () => Promise<string[]>
  /** Override for the localizer itself — tests inject a mock that returns a
   *  predetermined `AgentlessLocalizeResult`. Production wiring uses the real
   *  `agentlessLocalize`. */
  readonly localize?: (
    problemStatement: string,
    deps: AgentlessLocalizeDeps,
  ) => Promise<AgentlessLocalizeResult>
  /** Soft timeout (ms) for the LLM localization call. On expiry the wiring
   *  falls back to the regex extractor. Default 30_000. */
  readonly timeoutMs?: number
  /** jun-22 config-extraction: agentless localizer breadth dials (topK /
   *  maxTreeChars / maxFiles). Sourced from `posture.localizeBudget`; omitted
   *  fields keep their hardcoded defaults. */
  readonly localizeBudget?: LocalizeBudgetValue
  /** Resolved posture bit from the SAME bench projection that chose `mode`.
   *  Required so issue-hint prep never re-reads ambient env. */
  readonly issueHintExpectedActual: boolean
  /** T-201 observer seam (optional, no-op by default). When the agentless
   *  localizer produces ranked candidate files, they are handed here BEFORE
   *  being collapsed into the hint string — so the caller can build a
   *  FaultEvidencePacket from the SAME localization pass (no second LLM call).
   *  Pure observation: does not affect the returned hint. Fires only in
   *  agentless mode with a non-empty result. */
  readonly onCandidates?: (files: readonly string[]) => void
}

const DEFAULT_PREPARE_TIMEOUT_MS = 30_000
const CHA_MULTISITE_MAX_FILES = 3
const CHA_MULTISITE_LOCALIZE_MAX_RESULTS = 5

const cleanUniqueList = (values: readonly string[]): string[] => {
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

const rerouteLocalizedOwnerSurface = (
  prepared: Pick<PreparedAttemptContext, "localizeCandidates" | "ownerResolved" | "closureSession">,
): readonly string[] =>
  cleanUniqueList([
    ...prepared.localizeCandidates,
    ...(prepared.ownerResolved?.map((owner) => owner.file) ?? []),
    ...(prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ?? []),
  ])

const ownerWideningTelemetryOf = (args: {
  readonly owners: readonly string[]
  readonly sources: readonly ("repair_escalation" | "forward_localize")[]
  readonly path: OwnerWideningTelemetry["path"]
}): OwnerWideningTelemetry | undefined =>
  args.owners.length === 0
    ? undefined
    : { owners: args.owners, sources: args.sources, path: args.path }

const adaptiveRepairEscalationDecision = (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: Pick<Phase, "validated" | "primaryFalseGreen">
}): EscalationDecision | undefined => {
  if (!args.prepared.posture.repairEscalation || args.prepared.closureSession === undefined) {
    return undefined
  }
  return decideEscalation({
    candidates: args.prepared.closureSession.bundle.evidence.candidates.map((c) => ({
      file: c.file,
      score: c.score,
      sources: c.sources,
    })),
    primaryRailRedAfterRepair: primaryRailRedAfterRepair(
      args.prepared.primaryRailStep,
      args.phase.validated,
      args.phase.primaryFalseGreen,
    ),
    siblingFiles: args.prepared.ownerResolved?.map((o) => o.file) ?? [],
  })
}

/** Post-phase adaptive widen seam: when a repair-capable posture leaves the
 *  primary rail red and the escalation decision says the attempt is structurally
 *  incomplete, feed those owner files into the NEXT reroute pass as additional
 *  localized owners. This turns the prior report-only decision into a real
 *  adaptive widening input without giving it submit authority. */
export const adaptiveRepairEscalationOwners = (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: Pick<Phase, "validated" | "primaryFalseGreen">
}): readonly string[] => {
  const decision = adaptiveRepairEscalationDecision(args)
  return decision?.escalate ? cleanUniqueList(decision.owners) : []
}

/** Repair-escalation feeds the NEXT prepare pass, which rebuilds closure/owner
 *  state from scratch. Filter only against the current stage-1 localized files:
 *  owners already present there would be re-derived anyway, but ownerResolved /
 *  closure-session-only siblings still need to be re-seeded explicitly. */
export const repairEscalationFollowupOwners = (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "localizeCandidates" | "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: { readonly validated?: boolean; readonly primaryFalseGreen?: boolean }
}): readonly string[] => {
  const alreadySeeded = new Set(cleanUniqueList(args.prepared.localizeCandidates))
  return adaptiveRepairEscalationOwners(args).filter((owner) => !alreadySeeded.has(owner))
}

export const adaptiveNextPassOwners = async (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "localizeCandidates" | "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: {
    readonly patch: string
    readonly validated?: boolean
    readonly primaryFalseGreen?: boolean
  }
  readonly forwardLocalize: boolean
  readonly sandbox: string
  readonly timeoutMs: number
}): Promise<{
  readonly owners: readonly string[]
  readonly telemetry: OwnerWideningTelemetry | undefined
}> => {
  const escalationOwners = repairEscalationFollowupOwners(args)
  const forwardLocalizeOwners = args.forwardLocalize
    ? await traceForwardLocalizeOwners({
        patch: args.phase.patch,
        sandbox: args.sandbox,
        timeoutMs: args.timeoutMs,
        alreadyLocalized: rerouteLocalizedOwnerSurface(args.prepared),
      })
    : []
  const owners = cleanUniqueList([...escalationOwners, ...forwardLocalizeOwners])
  return {
    owners,
    telemetry: ownerWideningTelemetryOf({
      owners,
      sources: [
        ...(escalationOwners.length > 0 ? (["repair_escalation"] as const) : []),
        ...(forwardLocalizeOwners.length > 0 ? (["forward_localize"] as const) : []),
      ],
      path: "adaptive_reroute",
    }),
  }
}

export const maybeRunRepairEscalationFollowup = async <
  P extends {
    readonly patch: string
    readonly validated?: boolean
    readonly primaryFalseGreen?: boolean
  },
>(args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly prepared: PreparedAttemptContext
  readonly phase: P
  readonly runPhase: (prepared: PreparedAttemptContext) => Promise<P>
  readonly prepare?: typeof prepareAttemptContext
}): Promise<{
  readonly prepared: PreparedAttemptContext
  readonly phase: P
  readonly reran: boolean
  readonly widenedOwners: readonly string[]
  readonly telemetry: OwnerWideningTelemetry | undefined
}> => {
  const widenedOwners = repairEscalationFollowupOwners(args)
  if (widenedOwners.length === 0) {
    return {
      prepared: args.prepared,
      phase: args.phase,
      reran: false,
      widenedOwners,
      telemetry: undefined,
    }
  }
  const prepare = args.prepare ?? prepareAttemptContext
  const nextPrepared = await prepare(
    args.instance,
    args.sandbox,
    args.deps,
    args.signal,
    args.prepared.posture,
    args.prepared.state,
    widenedOwners,
  )
  const nextPhase = await args.runPhase(nextPrepared)
  return {
    prepared: nextPrepared,
    phase: nextPhase,
    reran: true,
    widenedOwners,
    telemetry: ownerWideningTelemetryOf({
      owners: widenedOwners,
      sources: ["repair_escalation"],
      path: "single_pass_followup",
    }),
  }
}

const normalizeIssuePathCandidate = (raw: string): string => {
  let value = raw.trim().replaceAll("\\", "/")
  while (value.startsWith("./")) value = value.slice(2)
  while (value.startsWith("/")) value = value.slice(1)
  return value
}

const uniqueRepoSuffixMatch = (
  extractedPath: string,
  repoFiles: readonly string[],
): string | undefined => {
  const normalized = normalizeIssuePathCandidate(extractedPath)
  if (normalized === "") return undefined
  const repoSet = new Set(repoFiles)
  if (repoSet.has(normalized)) return normalized
  const parts = normalized.split("/").filter((part) => part !== "")
  for (let start = 1; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("/")
    const matches = repoFiles.filter((file) => file === suffix || file.endsWith(`/${suffix}`))
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

const resolveIssueHintRepoCandidates = (
  extractedFiles: readonly string[],
  repoFiles: readonly string[],
): readonly string[] =>
  cleanUniqueList(
    extractedFiles.flatMap((file) => {
      const resolved = uniqueRepoSuffixMatch(file, repoFiles)
      return resolved === undefined ? [] : [resolved]
    }),
  )

/** Compute the hint string to PREPEND onto the user message, deciding
 *  between the new Agentless LLM path and the legacy regex path based on
 *  `mode`.
 *
 *    - mode `"off"`          ⇒ empty string (byte-identical sentinel)
 *    - mode `"regex"`        ⇒ legacy synchronous extractor (byte-identical
 *                              with the pre-feature single-arg buildConfig)
 *    - mode `"agentless"`    ⇒ async LLM localization. On any failure
 *                              (timeout, stream error, zero files in tree,
 *                              empty parse result) falls back to regex —
 *                              i.e. the worst case of agentless mode is
 *                              still a non-degenerate hint.
 *
 *  This function never throws — every failure path lands on a regex
 *  fallback (or `""` when regex also returns empty). */
export const prepareIssueHint = async (
  instance: Instance,
  sandbox: string,
  mode: IssueHintMode,
  deps: PrepareIssueHintDeps,
): Promise<string> => {
  if (mode === "off") return ""
  const problemStatement =
    normalizePublicIssueText(instance.problemStatement) ?? instance.problemStatement
  const extractOpts = { withExpectedActual: deps.issueHintExpectedActual }
  if (mode === "regex") {
    return composeIssueHint(extractIssueHint(problemStatement, extractOpts))
  }
  // mode === "agentless"
  const fileTree = deps.fileTree ?? (async () => enumerateRepoSources(sandbox))
  let repoFilesPromise: Promise<string[]> | undefined
  const readFileTree = async (): Promise<string[]> => {
    repoFilesPromise ??= fileTree()
    return repoFilesPromise
  }
  const regexFallback = async (): Promise<string> => {
    const hint = extractIssueHint(problemStatement, extractOpts)
    if (hint.files.length > 0) {
      const repoFiles = await readFileTree().catch(() => [])
      const resolved = resolveIssueHintRepoCandidates(hint.files, repoFiles)
      if (resolved.length > 0) deps.onCandidates?.(resolved)
    }
    return composeIssueHint(hint)
  }
  // Empty problem statement ⇒ regex also yields "" ⇒ byte-identical.
  if (typeof problemStatement !== "string" || problemStatement.length === 0) {
    return regexFallback()
  }
  const localize = deps.localize ?? agentlessLocalize
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<AgentlessLocalizeResult>((resolve) => {
    timer = setTimeout(() => resolve({ files: [], rationales: [], rawResponse: "" }), timeoutMs)
  })
  let result: AgentlessLocalizeResult
  try {
    result = await Promise.race([
      localize(problemStatement, {
        llm: deps.llm,
        fileTree: readFileTree,
        ...(deps.localizeBudget ?? {}),
      }),
      timeoutP,
    ])
  } catch {
    // localize threw (the function itself catches; this is belt-and-braces)
    return regexFallback()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (result.files.length === 0) {
    // Localize gave up — fall back to regex so the bench still gets SOME
    // hint when an issue body contains explicit paths.
    return regexFallback()
  }
  // T-201: surface the ranked candidates to the observer (no-op when unset) so a
  // FaultEvidencePacket can be built from THIS localization pass — never a second
  // LLM call. Pure observation; the returned hint is unchanged.
  deps.onCandidates?.(result.files)
  return composeAgentlessHint(result)
}

/** Parse ranked `path:line` rows from the localize tool output. Group headers,
 *  malformed rows, and duplicate lines are ignored. */
export const parseLocalizeRankedLines = (output: string): readonly number[] => {
  const seen = new Set<number>()
  const out: number[] = []
  for (const row of output.split("\n")) {
    const m = row.match(/^\s{2}.+?:(\d+)\s{2}/)
    if (!m) continue
    const line = Number(m[1])
    if (!Number.isInteger(line) || line < 1 || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

const runScopedLocalize = async (args: {
  readonly sandbox: string
  readonly targetRelFile: string
  readonly query: string
  readonly timeoutMs?: number
}): Promise<string | undefined> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS)
  let result: { ok: boolean; output: string } | undefined
  try {
    for await (const event of localizeTool.execute(
      {
        query: args.query,
        path: args.targetRelFile,
        max_results: CHA_MULTISITE_LOCALIZE_MAX_RESULTS,
      },
      { cwd: args.sandbox, signal: controller.signal },
    )) {
      if (event.type === "result") result = event.result
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
  return result?.ok === true ? result.output : undefined
}

const resolveLocalizedPythonMethods = async (args: {
  readonly sandbox: string
  readonly targetRelFile: string
  readonly query: string
}): Promise<readonly string[]> => {
  if (!args.targetRelFile.endsWith(".py")) return []
  const output = await runScopedLocalize(args)
  if (output === undefined) return []
  const methods: string[] = []
  const seen = new Set<string>()
  for (const line of parseLocalizeRankedLines(output)) {
    const method = await findEnclosingPythonMethod({
      exec,
      repoRoot: args.sandbox,
      targetRelFile: args.targetRelFile,
      line,
      timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
    })
    if (method === undefined || seen.has(method)) continue
    seen.add(method)
    methods.push(method)
  }
  return methods
}

const betterChaSteerCandidate = (
  left: { method: string; sites: readonly SiblingOverrideSite[] } | undefined,
  right: { method: string; sites: readonly SiblingOverrideSite[] },
): { method: string; sites: readonly SiblingOverrideSite[] } => {
  if (left === undefined) return right
  if (right.sites.length !== left.sites.length) {
    return right.sites.length > left.sites.length ? right : left
  }
  const rightOverrides = right.sites.filter((site) => site.role !== "backend-contract").length
  const leftOverrides = left.sites.filter((site) => site.role !== "backend-contract").length
  if (rightOverrides !== leftOverrides) return rightOverrides > leftOverrides ? right : left
  return left
}

/** jun-25: map the CHA-general posture flag to the analyzer's sibling-mode. OFF
 *  ⇒ legacy django path hardcode (byte-identical); ON ⇒ structural superset. */
const chaSiblingModeOf = (posture: BenchPosture): "path-hardcoded" | "general" =>
  posture.chaMultisiteGeneral ? "general" : "path-hardcoded"

const bestChaSteerCandidateForFile = async (args: {
  readonly sandbox: string
  readonly targetRelFile: string
  readonly query: string
  readonly siblingMode: "path-hardcoded" | "general"
}): Promise<ChaRepairTarget | undefined> => {
  const methods = await resolveLocalizedPythonMethods(args)
  let best: { method: string; sites: readonly SiblingOverrideSite[] } | undefined
  for (const method of methods) {
    const sites = await findSiblingOverrideSites({
      exec,
      repoRoot: args.sandbox,
      targetRelFile: args.targetRelFile,
      method,
      siblingMode: args.siblingMode,
      timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
    })
    if (sites.length === 0) continue
    best = betterChaSteerCandidate(best, { method, sites })
  }
  return best === undefined
    ? undefined
    : {
        file: args.targetRelFile,
        method: best.method,
        sites: best.sites,
      }
}

const resolveChaMultisiteContext = async (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly posture: BenchPosture
  readonly localizeCandidates: readonly string[]
}): Promise<{
  readonly steer: string | undefined
  readonly repairTargets: readonly ChaRepairTarget[]
}> => {
  if (!args.posture.chaMultisiteSteer || args.instance.swebench === undefined) {
    return { steer: undefined, repairTargets: [] }
  }
  const query =
    normalizePublicIssueText(args.instance.problemStatement) ?? args.instance.problemStatement
  if (typeof query !== "string" || query.trim() === "") {
    return { steer: undefined, repairTargets: [] }
  }
  const candidates = cleanUniqueList(args.localizeCandidates)
    .filter((file) => file.endsWith(".py"))
    .filter((_, index) => index < CHA_MULTISITE_MAX_FILES)
  const siblingMode = chaSiblingModeOf(args.posture)
  const repairTargets: ChaRepairTarget[] = []
  let steer: string | undefined
  for (const targetRelFile of candidates) {
    const best = await bestChaSteerCandidateForFile({
      sandbox: args.sandbox,
      targetRelFile,
      query,
      siblingMode,
    })
    if (best !== undefined) {
      repairTargets.push(best)
      if (steer === undefined) steer = buildMultisiteSteer(best.method, best.sites)
    }
  }
  return { steer, repairTargets }
}

/**
 * Parse `QUANTA_BENCH_REPRO_TEST` to a positive integer K in [1, 40] (the
 * paper's upper bound). Returns `undefined` for every other shape (absent /
 * `"0"` / negative / non-integer / NaN / garbage / empty / whitespace) — the
 * gate is *strict* by design (K=0 is byte-identical to baseline, so wiring
 * it would only add overhead without measurement effect).
 *
 * Exported for direct unit + hellgate.
 *
 * Domain choices:
 *   - K>=1 — paper's `1` means greedy-only; we accept it (no temperature
 *     knob in our `LLMPort`, so K=1 is meaningful but the majority-vote
 *     degenerates).
 *   - K<=40 — paper cap; >40 is rejected to bound LLM cost.
 */
export const parseBenchReproTestK = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 40) return undefined
  return n
}

export interface PrepareReproTestDeps {
  /** Bench's main LLM port. Reused (no separate model wiring — adds ~K
   *  small calls per instance, bounded by `parseBenchReproTestK`). */
  readonly llm: LLMPort
  /** Override for the generator. Tests inject a deterministic K-stream;
   *  production uses {@link generateReproTests}. */
  readonly generate?: typeof generateReproTests
  /** Override for the executor. Tests inject a Map-backed mock; production
   *  wraps `execArgv` + a file-write port. */
  readonly execute?: typeof executeReproTests
  /** Override for the selector. Tests can swap to deterministic; production
   *  uses {@link selectReproTest}. */
  readonly select?: typeof selectReproTest
  /** Injected file writer for the candidate scripts. Production wraps
   *  `Bun.write`; tests inject a Map-backed shim. */
  readonly writeFile?: ReproWriteFilePort
  /** Injected exec port. Production: `execArgv` from `./exec.ts`. */
  readonly exec?: ReproExecPort
  /** jun-19 #10999 under-fix lever: when `true`, the repro prompt gets the
   *  ADVERSARIAL-coverage block (boundary / must-reject / don't-copy-suggested-
   *  fix), so a shallow happy-path patch keeps the repro RED. Default-OFF ⇒
   *  byte-identical prompt. Sourced from `benchOptIns().adversarialRepro`. */
  readonly adversarial?: boolean
  /** jun-22 config-extraction: per-repro-script exec timeout (ms). Sourced from
   *  `posture.reproExecTimeoutMs`; undefined ⇒ the 60s `DEFAULT_EXEC_TIMEOUT_MS`. */
  readonly reproExecTimeoutMs?: number
  /** G2 paired-control gate. When `true`, the admission filter
   *  ({@link selectReproTest}) tightens to `reproduced && baseControl ===
   *  "green"`, rejecting env/import-broken false-reds. Sourced from
   *  `posture.pairedControl`; undefined/false ⇒ byte-identical legacy filter. */
  readonly pairedControl?: boolean
}

/** Per-instance reproduction-script filename written into the sandbox. The
 *  agent's user message references this exact path. The leading underscore
 *  is intentional — keeps the script at the top of `ls` so the agent sees
 *  it without scanning. */
export const REPRO_FILE_NAME = "reproduce_issue.py"

/** User-message block appended (before the existing base text) when a repro
 *  test was successfully selected. The command is rendered from the same
 *  project-env repro SSOT as validation; never hand the agent ambiguous
 *  bare-`python` instructions. */
export const reproHintMessage = (command: string): string =>
  [
    "A reproduction script has been placed at `reproduce_issue.py` in the sandbox.",
    `After your fix, run \`${command}\` under the project env.`,
    "It must go green: all assertions pass and the process exits 0.",
    "A failing assertion or non-zero exit means the bug is still present or the repro could not run cleanly.",
    "If it fails with TypeError/AttributeError/wrong argument count, inspect existing source/tests and fix the reproducer call shape before treating it as bug proof.",
  ].join("\n")

/** Compatibility/default hint for non-SWE fixtures. SWE-bench call sites use
 *  `reproHintForInstance` so the hint includes `uv run --with-editable`. */
export const REPRO_HINT_MESSAGE = reproHintMessage("python3 -s reproduce_issue.py")

const reproHintForInstance = (instance: Instance): string =>
  reproHintMessage(
    reproValidationCmd({
      repo: instance.swebench?.repo,
      version: instance.swebench?.version,
      scriptPath: REPRO_FILE_NAME,
    }),
  )

export interface PrepareReproTestDetailedResult {
  readonly selection: ReproTestSelection | null
  readonly telemetry: BenchReproTestTelemetry
}

const countReproduced = (samples: readonly { outcome: string }[]): number =>
  samples.filter((s) => s.outcome === "reproduced").length

const selectionTelemetry = (selection: ReproTestSelection): BenchReproTestTelemetry => {
  const samples = selection.samples.length
  const reproducedCount = selection.reproducedCount
  if (selection.selected !== null) {
    return { installed: false, reason: "not_installed", samples, reproducedCount }
  }
  // jun-18 DIAGNOSTIC (observe-only): surface WHY 0% base-red reproduction.
  const diag = {
    sampleOutcomes: selection.samples.map((s) => s.outcome),
    sampleStdoutTail: (selection.samples[0]?.stdout ?? "").slice(-400),
    sampleStderrTail: (selection.samples[0]?.stderr ?? "").slice(-500),
  }
  if (samples > 0 && selection.samples.every((sample) => sample.outcome === "exec_failed")) {
    return { installed: false, reason: "execution_failed", samples, reproducedCount, ...diag }
  }
  return { installed: false, reason: "no_reproduced_candidate", samples, reproducedCount, ...diag }
}

type ReproSamples = Awaited<ReturnType<typeof executeReproTests>>

const disabledReproResult = (
  reason: "disabled" | "empty_problem",
): PrepareReproTestDetailedResult => ({
  selection: null,
  telemetry: { installed: false, reason },
})

const failedReproResult = (
  reason: "generation_failed" | "generation_empty" | "execution_failed",
): PrepareReproTestDetailedResult => ({
  selection: null,
  telemetry: { installed: false, reason, samples: 0, reproducedCount: 0 },
})

const buildReproExecPort = (instance: Instance, deps: PrepareReproTestDeps) =>
  deps.exec ??
  ((argv, cwd, timeoutMs) =>
    execArgv(argv, cwd, timeoutMs, {
      ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
    }))

/** jun-23 canonical/hardening split. The CANONICAL set is the submit-gate
 *  oracle (plain core-symptom contract); the optional HARDENING set is advisory
 *  (adversarial coverage for tie-break / repair seeding, NEVER the submit gate).
 *  Each returned candidate is tagged with its {@link ReproTestKind}. */
const generateReproCandidateTests = async (
  instance: Instance,
  deps: PrepareReproTestDeps,
  config: ReproTestConfig,
): Promise<readonly ReproTestCandidate[] | null> => {
  try {
    const mwe = extractIssueRepro(instance.problemStatement)?.code
    const gen = deps.generate ?? generateReproTests
    const base = {
      issue: instance.problemStatement,
      llm: deps.llm,
      config,
      ...(mwe !== undefined ? { mwe } : {}),
    }
    const canonical = (await gen({ ...base, kind: "canonical" })).map(
      (source): ReproTestCandidate => ({ kind: "canonical", source }),
    )
    if (deps.adversarial !== true) return canonical
    // Advisory hardening set: a SEPARATE generation pass with the over-strict
    // adversarial prompt. Kept distinct so it can never reach the submit gate.
    const hardening = (await gen({ ...base, kind: "hardening" })).map(
      (source): ReproTestCandidate => ({ kind: "hardening", source }),
    )
    return [...canonical, ...hardening]
  } catch {
    return null
  }
}

const executeReproCandidateTests = async (
  candidates: readonly ReproTestCandidate[],
  instance: Instance,
  sandbox: string,
  deps: PrepareReproTestDeps,
  config: ReproTestConfig,
): Promise<ReproSamples | null> => {
  const reproRepo = instance.swebench?.repo
  const reproVersion = instance.swebench?.version
  const buildArgv =
    reproRepo !== undefined
      ? (scriptPath: string) => reproRunArgv(reproRepo, reproVersion, scriptPath)
      : undefined
  try {
    const samples = await (deps.execute ?? executeReproTests)({
      tests: candidates.map((c) => c.source),
      repoRoot: sandbox,
      exec: buildReproExecPort(instance, deps),
      writeFile:
        deps.writeFile ??
        (async (path: string, content: string): Promise<void> => {
          await Bun.write(path, content)
        }),
      readFile: async (path: string): Promise<string> => Bun.file(path).text(),
      config,
      ...(buildArgv !== undefined ? { buildArgv } : {}),
    })
    // jun-23 split: carry each candidate's KIND onto its sample by positional
    // alignment (executeReproTests returns one sample per input, in order). This
    // is what lets the driver route ONLY canonical reproducing sources into the
    // submit-gate oracle (calibration + proof gate) and keep hardening advisory.
    return samples.map((s, i) => ({ ...s, kind: candidates[i]?.kind ?? "canonical" }))
  } catch {
    return null
  }
}

export const prepareReproTestDetailed = async (
  instance: Instance,
  sandbox: string,
  k: number | undefined,
  deps: PrepareReproTestDeps,
): Promise<PrepareReproTestDetailedResult> => {
  if (k === undefined || k < 1) {
    return disabledReproResult("disabled")
  }
  if (typeof instance.problemStatement !== "string" || instance.problemStatement.length === 0) {
    return disabledReproResult("empty_problem")
  }
  const config: ReproTestConfig = {
    samples: k,
    ...(deps.reproExecTimeoutMs !== undefined ? { execTimeoutMs: deps.reproExecTimeoutMs } : {}),
  }
  const select = deps.select ?? selectReproTest
  // jun-18 closure repro-install lever: when the issue body embeds a confidently
  // EXECUTABLE Minimal Working Example (the author's own reproduction), seed the
  // generation with it so the model wraps that KNOWN-reproducing code in the
  // sentinel scaffold instead of guessing a reproduction from prose. Fail-closed:
  // `extractIssueRepro` returns undefined for anything ambiguous, in which case
  // `mwe` is omitted and the generate prompt is byte-identical to the prior path.
  const tests = await generateReproCandidateTests(instance, deps, config)
  if (tests === null) return failedReproResult("generation_failed")
  if (tests.length === 0) return failedReproResult("generation_empty")
  // Run each repro under the SAME project env the testCmd uses. A bare
  // `python3 <script>` on the box host cannot import the target project (it is
  // not pip-installed there), so without this every Agentless repro hit
  // ModuleNotFoundError and the primary rail never fired. For SWE-bench
  // instances, build a `uv run --with-editable . python <script>` argv keyed on the
  // repo's python version; non-SWE-bench fixtures keep the bare python3 default.
  const samples = await executeReproCandidateTests(tests, instance, sandbox, deps, config)
  if (samples === null) return failedReproResult("execution_failed")
  // G2 paired-control: thread the gate into the admission filter. When on, the
  // selector rejects reproducing samples whose paired controls did not pass on
  // base (env/import-broken false-reds). Default-OFF ⇒ legacy filter.
  const selection = select(samples, { pairedControl: deps.pairedControl === true })
  const telemetry: BenchReproTestTelemetry =
    samples.length > 0
      ? selectionTelemetry(selection)
      : {
          installed: false,
          reason: "no_reproduced_candidate",
          samples: 0,
          reproducedCount: countReproduced(samples),
        }
  return { selection, telemetry }
}

/**
 * Pre-agent reproduction-test generation + selection + sandbox install.
 *
 * Returns the selected test source (to be saved as `reproduce_issue.py`)
 * and the full selection record. Returns `null` when:
 *   - K is absent / invalid (env-gate)
 *   - the instance has no problem statement
 *   - every sample's outcome was non-"reproduced" (LLM couldn't synthesise
 *     a working reproducer)
 *
 * The function NEVER throws; on internal failure (LLM stream error, exec
 * exception) the worst outcome is `null` and the agent runs without the
 * hint — byte-identical to the K=undefined path.
 */
export const prepareReproTest = async (
  instance: Instance,
  sandbox: string,
  k: number | undefined,
  deps: PrepareReproTestDeps,
): Promise<ReproTestSelection | null> => {
  const detailed = await prepareReproTestDetailed(instance, sandbox, k, deps)
  return detailed.selection
}

/**
 * Wire `prepareReproTest` + `Bun.write` into a single `runInstance` helper.
 * Default-OFF: when `QUANTA_BENCH_REPRO_TEST` is unset/invalid OR no candidate
 * reproduces, returns `undefined` — the agent runs without the hint
 * (byte-identical to the pre-feature path).
 *
 * Extracted from `runInstance` to keep its cognitive complexity under the
 * biome ceiling. The wiring is exactly:
 *   K = parseBenchReproTestK(env)
 *   if K invalid ⇒ undefined
 *   selection = prepareReproTest(K)
 *   if no selection ⇒ undefined
 *   write `<sandbox>/reproduce_issue.py` ⇒ on success return the project-env repro hint
 *   on disk write failure ⇒ undefined (byte-identical to K-unset)
 */
interface InstallReproTestResult {
  readonly hint: string | undefined
  readonly telemetry: BenchReproTestTelemetry | undefined
  /** #2 repro-vote: the CANONICAL scripts that REPRODUCED the bug on the
   *  un-patched tree (outcome === "reproduced", kind canonical). Re-run on the
   *  patched tree + majority-voted by the K-of-N RESOLVED gate when the
   *  `repro-vote` knob is on. Empty/absent ⇒ no vote (byte-identical legacy gate).
   *  jun-23 split: canonical-only — the submit-gate set. */
  readonly reproSources?: readonly string[]
  /** Advisory HARDENING reproducing scripts (jun-23 split). Tie-break / repair
   *  seeding only — NEVER the submit gate. */
  readonly hardeningReproSources?: readonly string[]
}

const writeFailedTelemetry = (base: BenchReproTestTelemetry): BenchReproTestTelemetry => ({
  installed: false,
  reason: "write_failed",
  ...(base.samples !== undefined ? { samples: base.samples } : {}),
  ...(base.reproducedCount !== undefined ? { reproducedCount: base.reproducedCount } : {}),
})

/** The CANONICAL reproducing sources — the SUBMIT-GATE oracle set (jun-23
 *  split). A sample with no `kind` is treated as canonical (legacy single-set
 *  path ⇒ byte-identical to the pre-split behavior). Hardening reproes are
 *  EXCLUDED here so they can never reach the proof gate / calibration. */
const reproducingReproSources = (
  selection: ReproTestSelection | null | undefined,
): readonly string[] =>
  selection?.samples
    .filter((s) => s.outcome === "reproduced" && (s.kind ?? "canonical") === "canonical")
    .map((s) => s.source) ?? []

/** The advisory HARDENING reproducing sources (jun-23 split). Advisory only —
 *  tie-break / repair seeding — NEVER the submit gate. */
const reproducingHardeningSources = (
  selection: ReproTestSelection | null | undefined,
): readonly string[] =>
  selection?.samples
    .filter((s) => s.outcome === "reproduced" && s.kind === "hardening")
    .map((s) => s.source) ?? []

const VALIDATED_REPRO_CONTRACT_SCRIPT_LIMIT = 2
const VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT = 1_200
const boundValidatedReproSource = (source: string): string => {
  const trimmed = source.trim()
  if (trimmed.length <= VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT) return trimmed
  const suffix = "\n# ...[truncated]"
  const head = trimmed.slice(0, Math.max(0, VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT - suffix.length))
  // Cut on a LINE boundary, not mid-token: a mid-line slice yields syntactically
  // broken Python that we'd then present to the model as an executable "contract".
  // Keep only whole lines when the retained head contains a newline (>=0 so a
  // newline anywhere is preferred over a mid-token cut). A single >limit line with
  // NO newline is inherently lossy — keep the bounded head (clearly marked
  // truncated) rather than dropping the evidence entirely.
  const lastNewline = head.lastIndexOf("\n")
  const safe = lastNewline >= 0 ? head.slice(0, lastNewline) : head
  return `${safe}${suffix}`
}

export const validatedReproContractSeed = (
  sources: readonly string[],
  stage: LlmEvidencePacketStage = "candidate_generation",
): string | undefined => {
  assertEvidenceTextBlind(stage, sources)
  const nonEmptySources = sources.map(boundValidatedReproSource).filter((source) => source !== "")
  const boundedSources = nonEmptySources.slice(0, VALIDATED_REPRO_CONTRACT_SCRIPT_LIMIT)
  if (boundedSources.length === 0) return undefined
  const scripts = boundedSources
    .map((source, i) =>
      [`Validated reproduction script ${i + 1}:`, "```python", source, "```"].join("\n"),
    )
    .join("\n\n")
  const omitted = nonEmptySources.length - boundedSources.length
  return [
    "The following reproduction script(s) were generated from the public issue and executed on the base tree; each failed there and therefore reproduced the bug.",
    // Evidence-toned, NOT an absolute "must pass" mandate: these are LLM-generated
    // SYMPTOM reproducers, not the hidden grading tests. Over-stating their
    // authority invites reward-hacking the self-generated oracle. Fix the ROOT
    // CAUSE described in the issue; a correct fix should also make them PASS /
    // exit 0, but do not contort the patch merely to satisfy a script.
    "Treat them as strong public evidence of the bug's observable behavior. Prioritize fixing the root cause from the issue; a correct fix should make them pass cleanly (all assertions green / exit 0), but do not add unrelated design surface just to pass a single script.",
    ...(omitted > 0
      ? [
          `Omitted ${omitted} additional validated reproduction script(s) to keep the prompt compact.`,
        ]
      : []),
    scripts,
  ].join("\n\n")
}

export const validatedReproRepairSeed = (sources: readonly string[]): string | undefined => {
  const contract = validatedReproContractSeed(sources, "repair_seed")
  if (contract === undefined) return undefined
  return [
    contract,
    "Use this as repair guidance only after candidate selection has already shown every candidate unresolved.",
  ].join("\n\n")
}

export const selectionReproPrepK = (
  posture: Pick<BenchPosture, "verifySelectN" | "verifySelectRepro" | "reproTestK">,
): number | undefined => {
  if (posture.verifySelectN === undefined) return undefined
  if (posture.verifySelectRepro === undefined || posture.verifySelectRepro === "off")
    return undefined
  return posture.reproTestK ?? posture.verifySelectN
}

export const prepareSelectionReproSources = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
  posture: Pick<
    BenchPosture,
    | "verifySelectN"
    | "verifySelectRepro"
    | "reproTestK"
    | "adversarialRepro"
    | "reproExecTimeoutMs"
    | "pairedControl"
  >,
  deps: Omit<PrepareReproTestDeps, "llm" | "adversarial"> = {},
): Promise<{
  readonly telemetry: BenchReproTestTelemetry | undefined
  readonly hint: string | undefined
  /** CANONICAL reproducing sources — the submit-gate oracle set. */
  readonly reproSources: readonly string[]
  /** Advisory HARDENING reproducing sources — tie-break / repair seeding only. */
  readonly hardeningReproSources: readonly string[]
}> => {
  const reproK = selectionReproPrepK(posture)
  if (reproK === undefined)
    return { telemetry: undefined, hint: undefined, reproSources: [], hardeningReproSources: [] }
  const detail = await prepareReproTestDetailed(instance, sandbox, reproK, {
    ...deps,
    llm,
    ...(posture.adversarialRepro === true ? { adversarial: true } : {}),
    ...(posture.reproExecTimeoutMs !== undefined
      ? { reproExecTimeoutMs: posture.reproExecTimeoutMs }
      : {}),
    ...(posture.pairedControl === true ? { pairedControl: true } : {}),
  })
  const reproSources = reproducingReproSources(detail.selection)
  const hardeningReproSources = reproducingHardeningSources(detail.selection)
  if (detail.selection?.selected === null || detail.selection?.selected === undefined) {
    return {
      telemetry: detail.telemetry,
      hint: undefined,
      reproSources,
      hardeningReproSources,
    }
  }
  const path = `${sandbox}/${REPRO_FILE_NAME}`
  try {
    const writeFile =
      deps.writeFile ??
      (async (p: string, c: string): Promise<void> => {
        await Bun.write(p, c)
      })
    await writeFile(path, detail.selection.selected)
    return {
      telemetry: {
        installed: true,
        path,
        samples: detail.selection.samples.length,
        reproducedCount: detail.selection.reproducedCount,
      },
      hint: reproHintForInstance(instance),
      reproSources,
      hardeningReproSources,
    }
  } catch {
    return {
      telemetry: writeFailedTelemetry(detail.telemetry),
      hint: undefined,
      reproSources,
      hardeningReproSources,
    }
  }
}

export const installReproTestHint = async (
  instance: Instance,
  sandbox: string,
  posture: Pick<BenchPosture, "reproTestK" | "adversarialRepro" | "pairedControl">,
  llm: LLMPort,
): Promise<InstallReproTestResult> => {
  const reproK = posture.reproTestK
  if (reproK === undefined) return { hint: undefined, telemetry: undefined }
  const preparation = await prepareReproTestDetailed(instance, sandbox, reproK, {
    llm,
    ...(posture.adversarialRepro === true ? { adversarial: true } : {}),
    ...(posture.pairedControl === true ? { pairedControl: true } : {}),
  })
  const { selection, telemetry } = preparation
  if (selection === null || selection.selected === null) return { hint: undefined, telemetry }
  // #2 repro-vote: keep EVERY CANONICAL reproducing script (not just the selected
  // winner) so the validation-time K-of-N RESOLVED vote can re-run the whole
  // submit-gate set. jun-23 split: hardening reproes are kept SEPARATE (advisory).
  const reproSources = reproducingReproSources(selection)
  const hardeningReproSources = reproducingHardeningSources(selection)
  const path = `${sandbox}/${REPRO_FILE_NAME}`
  try {
    await Bun.write(path, selection.selected)
    return {
      hint: reproHintForInstance(instance),
      reproSources,
      hardeningReproSources,
      telemetry: {
        installed: true,
        path,
        samples: selection.samples.length,
        reproducedCount: selection.reproducedCount,
      },
    }
  } catch {
    return {
      hint: undefined,
      reproSources,
      hardeningReproSources,
      telemetry: writeFailedTelemetry(telemetry),
    }
  }
}

/**
 * Pure composer for the repro-hint block placement.
 *
 * Agent prompt order (top → bottom):
 *   <issue-hint>             (optional, default-OFF)
 *   <REPRO_HINT_MESSAGE>     (optional, default-OFF — this slice)
 *   <base task>
 *   <SWEBENCH_DIRECTIVE>     (already inside baseText for swebench instances)
 *   <seedMsg>                (only on repair rounds ≥1, appended by caller)
 *
 * Inputs:
 *   - `hint`        — issue-hint block (`""` when default-OFF)
 *   - `hintedBase`  — `hint + "\n\n" + baseText` when hint non-empty; else
 *                     `baseText`. Caller pre-computes (this preserves the
 *                     byte-identical pre-feature path when reproHint is "").
 *   - `baseText`    — the raw base task text (with SWEBENCH_DIRECTIVE).
 *   - `reproHint`   — the repro directive line, or `undefined` / `""` to skip.
 *
 * Returns:
 *   - `hintedBase` (byte-identical to pre-feature) when reproHint is empty.
 *   - `${hint}\n\n${reproHint}\n\n${baseText}` when hint present + repro
 *     present.
 *   - `${reproHint}\n\n${baseText}` when only repro present.
 *
 * Extracted to keep `buildConfig`'s cognitive complexity under the biome
 * ceiling. Pure — exported for direct unit testing.
 */
export const composeWithReproHint = (
  hint: string,
  hintedBase: string,
  baseText: string,
  reproHint: string | undefined,
): string =>
  reproHint === undefined || reproHint === ""
    ? hintedBase
    : composePromptPrelude({ issueHint: hint, reproHint, baseText })

const repoLocalVerifierHint = (instance: Instance): string => {
  const testCmd = agentVisibleBenchVerifierCommand(instance)
  if (instance.swebench === undefined || testCmd === undefined) return ""
  return [
    `Repository-local verifier for this task: ${testCmd}`,
    "When running repo tests, prefer this command (or a narrower variant of it) over bare host-global pytest/python.",
  ].join("\n")
}

type BenchTestRunnerInput = Parameters<typeof testRunnerTool.execute>[0]

const DATASET_VERIFIER_EXPOSE_ENV = "QUANTA_BENCH_EXPOSE_DATASET_VERIFIER"

const isSynthesizedDatasetVerifierCommand = (cmd: string): boolean =>
  cmd.startsWith("PYTEST_ADDOPTS=") ||
  cmd.includes(" pytest -x --no-header") ||
  cmd.includes(" python tests/runtests.py --settings=test_sqlite --parallel=1")

const agentVisibleBenchVerifierCommand = (instance: Instance): string | undefined => {
  const cmd = instance.testCmd.trim()
  if (cmd === "") return undefined
  if (
    instance.swebench !== undefined &&
    isSynthesizedDatasetVerifierCommand(cmd) &&
    !gateOn(process.env, DATASET_VERIFIER_EXPOSE_ENV)
  ) {
    return undefined
  }
  return cmd
}

const hasExplicitBenchTestRunnerCommand = (
  input: BenchTestRunnerInput,
): input is BenchTestRunnerInput & { command: string } =>
  typeof input.command === "string" && input.command.trim() !== ""

const hasBenchTestRunnerPath = (input: BenchTestRunnerInput): boolean =>
  typeof input.path === "string" && input.path.trim() !== ""

/** Bench-authoritative `test_runner`. In bench, the verifier source of truth is
 *  `instance.testCmd`, not repo-marker autodetect. So a no-arg `test_runner`
 *  must execute THAT command exactly; otherwise the model can silently drift to
 *  host-global `pytest`/`python` and the repair validator later replays the
 *  wrong rail. Bench therefore treats `test_runner` as a SINGLE authoritative
 *  rail: only `{}` / `{timeout_ms}` are accepted here. Any narrower or ad-hoc
 *  repo-local verify must go through explicit `bash`, whose exact command is
 *  already captured separately by the bench stream tap. */
const benchBoundTestRunner = (instance: Instance): Tool<BenchTestRunnerInput> | undefined => {
  const authoritative = agentVisibleBenchVerifierCommand(instance)
  if (authoritative === undefined) return undefined
  return {
    ...testRunnerTool,
    extractShellCommand: (input: BenchTestRunnerInput): string =>
      hasExplicitBenchTestRunnerCommand(input)
        ? input.command
        : hasBenchTestRunnerPath(input)
          ? (testRunnerTool.extractShellCommand?.(input) ?? "")
          : authoritative,
    async *execute(input: BenchTestRunnerInput, ctx) {
      if (hasExplicitBenchTestRunnerCommand(input) || hasBenchTestRunnerPath(input)) {
        yield {
          type: "result",
          result: {
            ok: false,
            output:
              "bench-bound test_runner accepts only `{}` or `{timeout_ms}` and always " +
              "runs the authoritative bench verifier exactly; for any narrower or " +
              "custom repo-local verification, use explicit `bash` instead.",
          },
        }
        return
      }
      const delegated =
        input.timeout_ms !== undefined
          ? { command: authoritative, timeout_ms: input.timeout_ms }
          : { command: authoritative }
      for await (const event of testRunnerTool.execute(delegated, ctx)) yield event
    },
  }
}

const localEnvSlotOf = (instance: Instance, sandbox: string): Pick<AgentConfig, "localEnv"> => {
  const shim = projectEnvPythonShimLocalEnv(instance, sandbox)
  const declared = instance.localEnv
  if (shim === undefined && declared === undefined) return {}
  return {
    localEnv: {
      vars: { ...(declared?.vars ?? {}), ...(shim?.vars ?? {}) },
      pathPrepend: [...(shim?.pathPrepend ?? []), ...(declared?.pathPrepend ?? [])],
    },
  }
}

export const benchVerifyAuthorityCommandsOf = (
  instance: Instance,
): readonly string[] | undefined => {
  const cmd = agentVisibleBenchVerifierCommand(instance)
  return cmd === undefined ? undefined : [cmd]
}

const applyLiveOverrides = (envKeys: readonly string[]): void => {
  for (const envKey of envKeys) {
    setKnobOverride(envKey, "1")
  }
}

const buildBenchRegistry = (instance: Instance, opt: BenchPosture, cwd: string): ToolRegistry => {
  const lspNavTools = opt.lspNav ? lspNavToolList(() => cwd) : []
  const astGrepTools = gateOn(process.env, "QUANTA_AST_GREP") ? [astGrepTool as Tool] : []
  const findRefsTools = gateOn(process.env, "QUANTA_BENCH_FIND_REFS")
    ? [findReferencesTool as Tool]
    : []
  const benchVerifierTool = benchBoundTestRunner(instance)
  return new ToolRegistry([
    ...buildDefaultTools(),
    ...lspNavTools,
    ...astGrepTools,
    ...findRefsTools,
    ...(benchVerifierTool !== undefined ? [benchVerifierTool] : []),
  ])
}

const buildBaseProblemText = (instance: Instance, sandbox: string): string => {
  const verifierHint = repoLocalVerifierHint(instance)
  const problemStatement =
    normalizePublicIssueText(instance.problemStatement) ?? instance.problemStatement
  return verifierHint === ""
    ? `${problemStatement}\n\nWork inside ${sandbox}. When done, stop.`
    : `${problemStatement}\n\nWork inside ${sandbox}.\n${verifierHint}\nWhen done, stop.`
}

const buildDirectiveSteers = (
  instance: Instance,
  opt: BenchPosture,
): {
  lsp: string
  findRefs: string
  spec: string
  simplicity: string
  sibling: string
} => {
  const isSwebench = instance.swebench !== undefined
  return {
    lsp: steerLine(
      isSwebench && opt.localizePhase?.lspGroundingSteer === true,
      LSP_GROUNDING_STEER,
    ),
    findRefs: steerLine(
      isSwebench && gateOn(process.env, "QUANTA_BENCH_FIND_REFS"),
      FIND_REFS_STEER,
    ),
    spec: buildSpecSteer(instance, opt, isSwebench),
    simplicity: steerLine(
      isSwebench && !gateDisabled(process.env, "QUANTA_BENCH_SIMPLICITY"),
      SIMPLICITY_STEER,
    ),
    sibling: steerLine(
      isSwebench && gateOn(process.env, "QUANTA_BENCH_SIBLING"),
      SIBLING_COMPLETION_STEER,
    ),
  }
}

const steerLine = (enabled: boolean, text: string): string => (enabled ? `\n-${text}` : "")

const buildSpecSteer = (instance: Instance, opt: BenchPosture, isSwebench: boolean): string =>
  steerLine(
    isSwebench &&
      opt.specFidelitySteer === true &&
      extractIssueDeclaredExpected(instance.problemStatement) !== undefined,
    SPEC_FIDELITY_STEER,
  )

const resolveIssueHintText = (
  instance: Instance,
  opt: BenchPosture,
  precomputedHint: string | undefined,
): string => {
  if (precomputedHint !== undefined) return precomputedHint
  if (opt.issueHintMode !== "regex") return ""
  return composeIssueHint(
    extractIssueHint(instance.problemStatement, {
      withExpectedActual: opt.issueHintExpectedActual,
    }),
  )
}

const joinPromptBlocks = (...blocks: readonly (string | undefined)[]): string =>
  blocks.filter((block): block is string => block !== undefined && block !== "").join("\n\n")

const buildPromptText = (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly opt: BenchPosture
  readonly seedMsg?: string
  readonly precomputedHint?: string
  readonly reproHint?: string
  readonly closureHint?: string
  readonly chaMultisiteSteer?: string
}): string => {
  const leanPrompt = gateOn(process.env, "QUANTA_BENCH_LEAN_PROMPT")
  const baseText = composeBaseText(
    buildBaseProblemText(args.instance, args.sandbox),
    Boolean(args.instance.swebench),
    args.opt.inLoopExecMode,
    buildDirectiveSteers(args.instance, args.opt),
    leanPrompt,
  )
  const effectiveReproHint = args.reproHint
  return composePromptText({
    issueHint: joinPromptBlocks(
      resolveIssueHintText(args.instance, args.opt, args.precomputedHint),
      args.chaMultisiteSteer,
    ),
    baseText,
    ...(args.closureHint !== undefined ? { closureHint: args.closureHint } : {}),
    ...(effectiveReproHint !== undefined ? { reproHint: effectiveReproHint } : {}),
    ...(args.seedMsg !== undefined ? { seedMsg: args.seedMsg } : {}),
  })
}

const buildConfigGuards = (
  instance: Instance,
  opt: BenchPosture,
  signal: AbortSignal,
): Partial<AgentConfig> => {
  const exactCommands = benchVerifyAuthorityCommandsOf(instance)
  const verifyGuard =
    instance.swebench && opt.inLoopExecMode === "full"
      ? exactCommands !== undefined
        ? { mustPass: true, maxTrips: 2, exactCommands }
        : { mustPass: true, maxTrips: 2 }
      : undefined
  return {
    ...(opt.lspNav ? { evictLspPoolOnEnd: true } : {}),
    ...(opt.lspNav && !gateDisabled(process.env, "QUANTA_LSP_PREWARM")
      ? { lspPrewarm: { enabled: true, warmSignal: signal } }
      : {}),
    ...(verifyGuard !== undefined ? { verifyGuard } : {}),
    ...(instance.swebench && !gateDisabled(process.env, "QUANTA_BENCH_PROTECT_TESTS")
      ? { protectTestPaths: true }
      : {}),
  }
}

const userPromptMessages = (text: string): Message[] => [
  {
    role: "user",
    content: [{ type: "text", text }],
  },
]

const localizePhaseConfigOf = (
  opt: BenchPosture,
  chaMultisiteSteer: string | undefined,
): AgentConfig["localizePhase"] | undefined => {
  if (opt.localizePhase === undefined) return undefined
  if (chaMultisiteSteer === undefined || chaMultisiteSteer === "") return opt.localizePhase
  return { ...opt.localizePhase, chaMultisiteSteer }
}

const wirePostureAgentPorts = (args: {
  readonly config: AgentConfig
  readonly opt: BenchPosture
  readonly localizePhase: AgentConfig["localizePhase"] | undefined
}): AgentConfig => ({
  ...args.config,
  ...(args.opt.subagent !== undefined ? { subagent: args.opt.subagent } : {}),
  ...(args.opt.skills !== undefined ? { skills: args.opt.skills } : {}),
  ...(args.localizePhase !== undefined ? { localizePhase: args.localizePhase } : {}),
  ...(args.opt.branchSearch !== undefined ? { branchSearch: args.opt.branchSearch } : {}),
})

export const buildConfig = (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  stream: StreamPort,
  seedMsg?: string,
  /**
   * Pre-computed issue-hint text (Agentless async path). When provided AND
   * non-empty, replaces the synchronous regex path entirely — buildConfig
   * does not re-run extraction. `""` (empty string) is treated the same as
   * undefined (no hint section emitted) so the byte-identical contract for
   * "extraction yielded nothing" is preserved across both code paths.
   *
   * Production wiring: `prepareIssueHint` computes this BEFORE the agent
   * runs (async LLM call) and threads it through `runAgentOnce`/Phase. Tests
   * that exercise buildConfig directly without async setup pass undefined.
   */
  precomputedHint?: string,
  /**
   * Pre-computed reproduction-script hint line (Agentless §3.3.1 absorption).
   * When provided AND non-empty, the line is prepended to the user message
   * BELOW any `precomputedHint` block but ABOVE the base task description.
   * Absent / `""` ⇒ no hint injection (byte-identical to the pre-feature
   * path).
   *
   * Production wiring: `prepareReproTest` selects a candidate before the
   * agent runs, writes it to `<sandbox>/reproduce_issue.py`, and threads the
   * verbatim {@link REPRO_HINT_MESSAGE} through here.
   */
  reproHint?: string,
  /** Optional one-line owner hint rendered from the ClosureBundle. */
  closureHint?: string,
  /** Optional injected per-phase posture (v5 adaptive wiring). */
  postureOverride?: BenchPosture,
  /** Optional injected per-phase knob state (must match `postureOverride`). */
  stateOverride?: BenchKnobState,
  /** Optional dynamic concrete multi-site steer naming sibling override sites. */
  chaMultisiteSteer?: string,
  /** G1 cross-vendor diversity — OPTIONAL provider-distinct LLM port for THIS
   *  candidate's lane. When provided it OVERRIDES `deps.llm` as the agent's
   *  generator (resolved by {@link resolveLaneLlm} from the candidate index +
   *  the `model-lane-diversity` posture). Absent ⇒ `deps.llm` (byte-identical). */
  laneLlm?: LLMPort,
) => {
  // ADR-0015 LSP-nav: opt-in via `QUANTA_LSP_TOOLS=full` (same gate as CLI) OR
  // the bench-only `QUANTA_BENCH_LSP=1`. When the language-server binary
  // (`pyright-langserver` / `typescript-language-server`) is absent the
  // per-call probe in `lsp-bridge` makes the tools emit a clean `ok:false` —
  // registration is harmless without a server. Default-OFF preserves
  // byte-identical bench behavior.
  const state = stateOverride ?? resolveBenchKnobs({ envVars: process.env })
  const opt = postureOverride ?? benchPostureFromState(state, process.env)
  // Runtime-config-bridged knobs (read-outline / test-runner / repo-map): these
  // are NOT AgentConfig fields — they are read at wire time via `runtimeConfig()`
  // inside `wireOptionalAgentPorts`. The unified posture resolves them from the
  // preset/env into `opt.liveOverrides` (envKeys to enable); we push each into
  // the live-override store so the subsequent wire-time read picks it up.
  // setKnobOverride invalidates the runtimeConfig cache and is idempotent (set
  // to the same value on every buildConfig call). Empty list ⇒ no-op ⇒
  // byte-identical to the pre-preset path.
  applyLiveOverrides(opt.liveOverrides)
  // DIP factory: bench driver runs against the default port surface; the
  // per-instance sandbox is enforced by cwd, not by injected fs ports.
  const registry = buildBenchRegistry(instance, opt, sandbox)
  const permission: PermissionContext = { mode: "acceptEdits" }
  // Default behavior (no seedMsg) is byte-identical to the pre-b2 prompt: the
  // user message is `base` (+ SWEBENCH_DIRECTIVE for swebench instances). A
  // seedMsg ⇒ appended after a blank line ONLY for repair rounds ≥1.
  // `bench-in-loop-exec` knob (default-FULL ⇒ byte-identical): FULL uses the
  // test-running directive; REPRO-ONLY permits only a narrow reproducer; OFF
  // swaps to edit-and-submit with no in-loop execution.
  // LSP-nav GROUNDING steer (agentless-v2 / `lsp-steer`). The localize-phase
  // guard ALSO carries this steer, but ONLY fires it when the model attempts an
  // early edit during Phase 1 — a localize-first agent explores with read/grep
  // for the whole phase and NEVER sees it (measured: 0 occurrences, 0 lsp_*
  // calls in a real run). So we surface it as an ALWAYS-PRESENT directive line
  // too, gated on the SAME `lspGroundingSteer` flag (not `lspNav`, so the
  // frozen agentless-v1 prompt stays byte-identical and the v1↔v2 A/B is clean).
  // ABSORBED METHODOLOGY (jun-19, #13417 class) — anti-SEMANTIC-over-engineering.
  // quanta's directive already enforces DIFF-SIZE minimality ("smallest change",
  // "no whole-file rewrite"), but the 13417 failure is SEMANTIC: a 1-2 line diff
  // that reaches for a runtime/compiler API (`get_compiler()`) or invents a
  // helper method (`has_results_ordering()`) — both pass the diff-size rule.
  // mini/OpenHands solve it minimally because their system prompt carries an
  // explicit "seek the simplest mechanism / reject over-engineering" philosophy
  // (OpenHands `system_prompt_tech_philosophy.j2`, Linus mode). This line ports
  // that philosophy verbatim-in-spirit. DEFAULT-ON (validated 2026-06-19):
  // 2 proven causal flips (django-13417, sympy-24562: ❌→✅ with the steer), a
  // fresh untried tier-E batch 8/9 across 7 repos, 7166's earlier fail confirmed
  // RUN-NOISE (passed on re-run), 0 clear regression across ~18 graded. Off-
  // switch `QUANTA_BENCH_SIMPLICITY=0` restores the pre-absorption baseline.
  // Lever A — sibling-completion / co-change check (ceiling multi-file class).
  // Knob-gated `QUANTA_BENCH_SIBLING`, DEFAULT-OFF for a clean A/B against the
  // 0/6 ceiling baseline; OFF ⇒ "" ⇒ byte-identical prompt.
  // Hint injection (default-OFF; opt-in via `QUANTA_BENCH_ISSUE_HINT`).
  //   - mode `"regex"` (legacy)     ⇒ synchronous regex extractor here
  //   - mode `"agentless"` (new)    ⇒ pre-computed by `prepareIssueHint`,
  //                                    threaded in via `precomputedHint`
  //   - mode `"off"`                ⇒ empty hint (byte-identical)
  // When `precomputedHint` is provided (any non-undefined value, including
  // `""`), the Agentless pre-compute already ran; we honor it verbatim and do
  // NOT re-extract. Empty pre-computed hint ⇒ "" ⇒ byte-identical.
  const text = buildPromptText({
    instance,
    sandbox,
    opt,
    ...(seedMsg !== undefined ? { seedMsg } : {}),
    ...(precomputedHint !== undefined ? { precomputedHint } : {}),
    ...(reproHint !== undefined ? { reproHint } : {}),
    ...(closureHint !== undefined ? { closureHint } : {}),
    ...(chaMultisiteSteer !== undefined ? { chaMultisiteSteer } : {}),
  })
  const messages = userPromptMessages(text)
  const budgetMeter = deps.budgetMeterFactory?.()
  const baseConfig = {
    // G1 cross-vendor diversity: the per-candidate lane port (when the driver
    // resolved one via resolveLaneLlm) OVERRIDES the single shared port here, so
    // the model-lane-diversity knob is a REAL provider swap at the wire site —
    // not a tag. Absent ⇒ deps.llm (byte-identical single-vendor path).
    llm: laneLlm ?? deps.llm,
    registry,
    stream,
    permission,
    messages,
    system: buildSystemPrompt(sandbox),
    cwd: sandbox,
    // RFC jun-17 — pooled LSP workspace lifecycle for bench. When nav is on,
    // ALWAYS hard-evict at session end: a per-instance sandbox cwd must not
    // leak a `pyright-langserver` child for the 30-min idle-TTL window (the
    // idle-TTL is an interactive-reuse affordance, useless to a one-shot
    // bench instance). Prewarm is DEFAULT-ON with nav (warm the localize-phase
    // workspace); the cold arm of the A/B is `QUANTA_LSP_PREWARM=0`
    // (`gateDisabled` off-switch). The run `signal` is the warm abort so
    // session end cancels an in-flight warm instead of riding the budget.
    ...localEnvSlotOf(instance, sandbox),
    maxTurns: deps.maxTurns,
    signal,
    ...(budgetMeter !== undefined ? { budgetMeter } : {}),
    // Fork-experiment seam: present only when an experiment is wired ⇒
    // byte-identical default-OFF (RFC jun-23 §3).
    ...(deps.turnContextMutator !== undefined
      ? { turnContextMutator: deps.turnContextMutator }
      : {}),
    onConfirm: async () => false,
    // Real SWE-bench repos blow the context window over a long trajectory.
    // Enable proactive + reactive compaction (RFC §8 / ADR-0004 robustness):
    // without this, large-repo instances PTL-die instead of compacting.
    compaction: {},
    // Verify-guard (ADR-0013): observed bench failure — agent edits a
    // source file then declares "done" with 0 verification → wrong fix ships.
    // Gated exactly like SWEBENCH_DIRECTIVE (real SWE-bench only; custom-corpus
    // byte-identical). Absent ⇒ guard OFF, loop unchanged.
    //
    // mustPass (outcome-gate) extension — sanity runs with skills/subagent ON
    // showed the model can call `test_runner`, receive `ok:false`, and STILL
    // declare "done"; the presence-only guard accepts the call as "verified"
    // because it ran. mustPass = ALSO require the verify to PASS. maxTrips=2
    // gives one budget slot per branch (presence + must-pass) so a single run
    // can hit both before the cap; SWE-bench prioritizes measurement integrity
    // over the over-correction risk that motivated DEFAULT_MAX_TRIPS=1.
    // Gated additionally on `"full"` execution: the noexec / repro-only
    // postures deliberately avoid broad repo-test execution, so a must-verify
    // guard would reintroduce the same host-env flail they are designed to
    // avoid.
    // Test-scope guard (RCA 2026-06-19, django-13417). DEFAULT-ON for ALL real
    // swebench modes, not just full execution: source-only is a benchmark
    // invariant, so the dispatch layer must enforce it even in submit-only or
    // repro-only runs. Off-switch `QUANTA_BENCH_PROTECT_TESTS=0` yields the
    // advisory-only baseline.
    ...buildConfigGuards(instance, opt, signal),
    // Bench A/B opt-ins (default-OFF; all unset ⇒ keys omitted entirely,
    // exactOptionalPropertyTypes-friendly, AgentConfig byte-identical).
  }
  const knobApplied = applyBenchKnobs(baseConfig, state, { instance, sandbox })
  const noPatchApplied = opt.noPatchBreaker
    ? wireNoPatchBreaker(knobApplied, opt.noPatchForceFraction)
    : knobApplied
  const localizePhase = localizePhaseConfigOf(opt, chaMultisiteSteer)
  return wireOptionalAgentPorts(
    wirePostureAgentPorts({ config: noPatchApplied, opt, localizePhase }),
    process.env,
  )
}

interface Phase {
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
}

/**
 * Capture the agent's LAST verification command by wrapping a downstream
 * `StreamPort` and intercepting verify-shaped events. Pure tap: every event is
 * forwarded unchanged; the bench can read `lastVerifyCmd` after `runAgent`
 * returns. `bash` exposes the shell string at `tool_call`; `test_runner`
 * resolves the command inside the tool and surfaces it later on
 * `tool_result.executedCommand`.
 */
// Bench stream tap (`BenchStreamTap` + `editTargetOf` + `relFromSandbox`) is
// the SSOT in `./stream-tap` — both this runner core and the prod SDK wrapper
// (`apps/bench/eval/driver.ts`) import it (see the import block above).

/**
 * Emit ONE `knobs_applied` event onto the given stream, carrying the
 * bench-surface knob posture resolved from `process.env`. Fail-soft: any
 * resolution error (a malformed env value that throws in `parse`) is caught
 * locally so a measurement run can never be aborted by a telemetry call. With
 * an empty registry the event still fires with `knobs:{}` and
 * `costMultiplier:0` (matrix budget contract: Σ(active) = 0 when none active).
 *
 * Cost computation: Σ of each ACTIVE knob's `costMultiplier` field (default 1
 * when the knob does not declare one). Matches the contract documented in
 * `tools/swebench-matrix.ts#estimateAxesCost` per-condition product is summed
 * across a sweep; here we project ONE condition (this run) so the sum is just
 * Σ over active knobs. A zero-cost return ⇒ no knob active.
 *
 * Default-OFF byte-identical: the only on-wire side effect is one `emit` call;
 * `NullStream.emit` is a no-op so a run without observation produces zero new
 * bytes (and the existing recorder maps the event onto the `recovery`
 * trajectory family, no new TrajectoryKind required).
 */
export const emitKnobsApplied = (
  stream: StreamPort,
  envVars: NodeJS.ProcessEnv,
  stateOverride?: BenchKnobState,
): void => {
  try {
    const state = stateOverride ?? resolveBenchKnobs({ envVars })
    const knobs = knobsForReport(state)
    let cost = 0
    for (const id of Object.keys(knobs)) {
      const knob = state.knobs.get(id)
      const m = knob?.costMultiplier
      cost += typeof m === "number" && m > 0 ? m : 1
    }
    const event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs,
      preset: state.preset !== undefined ? state.preset : null,
      costMultiplier: cost,
    }
    stream.emit(event)
  } catch {
    // Telemetry must NEVER abort a bench run — a malformed env value that
    // throws in a knob's `parse` is a measurement-data concern, not a
    // run-correctness one. The error already surfaces via the next
    // `resolveBenchKnobs` call (e.g. `buildConfig` → `applyBenchKnobs`), so
    // we deliberately swallow here. The recorder receives no event in this
    // case (degenerate but safe — the report's `knobs` section still
    // captures the same posture at write time).
  }
}

/**
 * Run the agent ONCE in the sandbox (no git wrap — caller controls snapshot
 * boundaries). Returns the cumulative diff + turns + lastVerifyCmd captured
 * from the stream. Used both by the single-pass path and by the per-round
 * `runOnce` closure of the repair orchestrator (continue-from-patched-tree).
 *
 * The optional `precomputedHint` threads the Agentless pre-computed hint
 * through to `buildConfig`. When undefined, `buildConfig` falls back to the
 * legacy synchronous regex path (gated on `issueHintMode === "regex"`).
 */
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
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaMultisiteSteer?: string,
): Promise<RunOnceResult> => {
  const tap = new BenchStreamTap(w.stream, undefined, benchVerifyAuthorityCommandsOf(instance))
  // Knob telemetry (2026-05-26): emit ONE `knobs_applied` event per
  // runAgent invocation. In the repair orchestrator each round calls this
  // helper, so each round produces its own trajectory line (the env doesn't
  // change between rounds, so the lines are identical — useful as a
  // boundary marker).
  emitKnobsApplied(tap, process.env, stateOverride)
  const sessionSignal = createSessionScopedSignal(signal)
  try {
    const outcome = await runAgent(
      withSessionScopedSignal(
        buildConfig(
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
          chaMultisiteSteer,
        ),
        sessionSignal.signal,
      ),
    )
    // Capture the cumulative diff CURRENTLY in the worktree (without resetting
    // the index): mirrors `withGitSnapshot`'s final diff step. `git` is
    // opportunistic — absence ⇒ "". T2: cache/build paths pruned at source.
    const patch = await gitStageAndDiffCached(sandbox, timeoutMs)
    const result: RunOnceResult = {
      patch,
      turns: outcome.turns,
      ...(tap.lastVerifyCmd !== undefined ? { lastVerifyCmd: tap.lastVerifyCmd } : {}),
    }
    return result
  } finally {
    sessionSignal.abort()
  }
}

/** Sandbox snapshot → agent (inside the git pre/post-image) → captured diff. */
const runAgentPhase = async (
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
  chaMultisiteSteer?: string,
  laneLlm?: LLMPort,
): Promise<Phase> => {
  let turns = 0
  let stopReason: StopReason | undefined
  let agentError: string | undefined
  let firstEditFile: string | undefined
  let editCount: number | undefined
  let turnsToFirstEdit: number | undefined
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      // INTENTIONAL DIVERGENCE from the prod apps-driver runAgentPhase: this
      // runner-core twin passes `undefined` for `onVerifyPass` (no tentative-
      // patch retention). That P0 safety-net lives ONLY in the apps driver
      // (src/apps/bench/eval/driver.ts) because this runner `runInstance` shell
      // has no production caller — apps/bench/eval re-exports runInstance from
      // the apps driver, and tests pin THIS twin's plain emit. Porting tentative
      // here would change the test-pinned behavior of a dead path for no prod
      // gain. The shared phase logic stays in this module; only the orchestration
      // shell diverges on the tentative axis. Keep in sync if this shell is ever
      // made live.
      const tap = new BenchStreamTap(w.stream, undefined, benchVerifyAuthorityCommandsOf(instance))
      // Knob telemetry: emit once per phase entry (matches the contract
      // documented on `emitKnobsApplied`). The single-pass path bypasses
      // `runAgentOnce`, so the emit lives here directly.
      emitKnobsApplied(tap, process.env, stateOverride)
      await installProjectEnvPythonShim(instance, sandbox)
      const sessionSignal = createSessionScopedSignal(signal)
      try {
        const outcome = await runAgent(
          withSessionScopedSignal(
            buildConfig(
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
              chaMultisiteSteer,
              laneLlm,
            ),
            sessionSignal.signal,
          ),
        )
        turns = outcome.turns
        stopReason = outcome.reason
        agentError = tap.lastErrorMessage
        firstEditFile = relFromSandbox(sandbox, tap.firstEditFile)
        editCount = tap.editCount
        turnsToFirstEdit = tap.turnsToFirstEdit
      } finally {
        sessionSignal.abort()
      }
    },
    instance.swebench?.repo,
  )
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
const reproExecBundle = (
  instance: Instance,
): {
  exec: ReproExecPort
  writeFile: ReproWriteFilePort
  readFile: ReproReadFilePort
  buildArgv?: (s: string) => readonly string[]
} => {
  const repo = instance.swebench?.repo
  const version = instance.swebench?.version
  return {
    exec: (argv, cwd, timeoutMs) =>
      execArgv(argv, cwd, timeoutMs, {
        ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
      }),
    writeFile: async (p: string, c: string): Promise<void> => {
      await Bun.write(p, c)
    },
    readFile: async (p: string): Promise<string> => Bun.file(p).text(),
    ...(repo !== undefined
      ? { buildArgv: (scriptPath: string) => reproRunArgv(repo, version, scriptPath) }
      : {}),
  }
}

export const buildReproVoteValidate = (
  instance: Instance,
  reproSources: readonly string[],
  fallback: (args: ValidateArgs) => Promise<ValidatorResult>,
): ((args: ValidateArgs) => Promise<ValidatorResult>) => {
  if (benchOptIns().reproVote !== true) return fallback
  return makeReproVoteValidate({ sources: reproSources, ...reproExecBundle(instance), fallback })
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

/**
 * Repair-path phase: ONE `withGitSnapshot` wraps ALL rounds (so the prior
 * round's edits persist into round N+1 — no `git reset/clean` between rounds).
 * The official `verify()` is NEVER invoked here — it runs ONCE outside, on the
 * cumulative final patch (no-leak invariant). The validator/buildContext are
 * injectable; production defaults are G1's `validate`/`buildRepairContext`.
 */
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
  verificationTarget: VerificationTargetFact | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaMultisiteSteer?: string,
): Promise<Phase> => {
  // B1/B3: thread the slice-resolving inputs into the classic-repair packet so
  // its owner evidence carries exact slices (paired with issue symbols) and it
  // names the active proof target — parity with the selector-repair sibling.
  const repairIssueSymbols = extractIssueHint(instance.problemStatement).symbols
  let turns = 0
  let finalPatch = ""
  let repairValidated = false
  let repairFalseGreen = false
  let repairFalseRed = false
  let repairRounds = 0
  const repairLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  // #2 repro-vote: when the knob is on AND we have a reproducing set, the
  // validator becomes the K-of-N RESOLVED majority vote (re-run the set on the
  // patched tree). Empty sources, execution failure, and inconclusive votes are
  // fail-closed inside that validator. Default-OFF returns `baseValidate`
  // unchanged. The exec wiring lives in the SHARED `buildReproVoteValidate` so
  // both drivers agree.
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
            postureOverride,
            stateOverride,
            chaMultisiteSteer,
          ),
        validate,
        buildContext: (ctxArgs) => {
          const repairArgs = {
            ...ctxArgs,
            siblingOwners,
            issueSymbols: repairIssueSymbols,
            readSource: (rel: string) => readSandboxSource(sandbox, rel),
            ...(verificationTarget !== undefined ? { verificationTarget } : {}),
          }
          const repairSeed = buildRepairRoundSeedMessage(
            repairArgs,
            repair.buildContext?.(repairArgs),
          )
          recordLlmEvidencePacket(repairLlmEvidence, repairSeed.packet)
          return repairSeed.seedMsg
        },
        sandbox,
        exec,
        readFile: async (path: string): Promise<string> => Bun.file(path).text(),
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
    instance.swebench?.repo,
  )
  // `patch` (from withGitSnapshot's final diff) is the canonical capture; if
  // available we prefer it (it reflects the worktree at end of all rounds).
  // `finalPatch` is the orchestrator's view of the last round's diff — they
  // agree by construction (continue-from-patched-tree, single sandbox).
  return {
    patch: patch !== "" ? patch : finalPatch,
    turns,
    validated: repairValidated,
    primaryFalseGreen: repairFalseGreen,
    primaryFalseRed: repairFalseRed,
    ...(repairRounds > 0 ? { verifyRounds: repairRounds } : {}),
    ...(Object.keys(repairLlmEvidence).length > 0 ? { llmEvidence: repairLlmEvidence } : {}),
  }
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
 * P4 (jun-23): GOLD-calibrate the PROOF-REQUIRED gate's CANONICAL oracle.
 *
 * Defect 2 root cause: `makeCalibratedReproConsensusPort` fail-opens the SOFT
 * `resolvedKofN` selection port when the oracle is a confirmed gold false-negative,
 * but the HARD proof gate (`makeReproConsensusProofSelectionPort` →
 * `applyProofRequiredHardGate`) had NO calibration — a proven-broken (gold-FN)
 * oracle still held hard submit authority and WITHHELD the correct candidate. And
 * in `verify-select-repro: positive` (soft) mode the gold calibration NEVER RAN,
 * so the proof gate ran fully blind.
 *
 * This runs the SAME canonical consensus probe used by the proof gate against the
 * GOLD patch (EVAL-ONLY) so the driver can LIFT proofRequired for this instance
 * when the canonical oracle is a confirmed gold-FN — a proven-broken oracle must
 * never hold hard submit authority. Mirrors the soft-port calibration step in
 * {@link makeCalibratedReproConsensusPort}, but for the proof path. Returns an
 * UNAVAILABLE (no-claim) calibration when there is no reproducing canonical set
 * (the gate is inert) or no gold (off-bench). */
const calibrateProofOracle = async (
  instance: Instance,
  canonicalReproSources: readonly string[],
  sandbox: string,
  timeoutMs: number,
): Promise<ReproOracleCalibration> => {
  if (canonicalReproSources.length === 0) return unavailableReproOracleCalibration()
  const probe = makePatchedResolvedConsensus({
    sources: canonicalReproSources,
    ...reproExecBundle(instance),
  })
  return calibrateReproOracle({
    resolvedProbe: probe,
    goldPatch: instance.goldPatch,
    sandbox,
    baseCommit: instance.swebench?.baseCommit,
    ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
    timeoutMs,
  })
}

/**
 * P4 PROOF-GATE FAIL-OPEN decision (THE structural fix for Defect 2) — pure +
 * exported for direct mutation-grade testing of the EXACT decision the selection
 * phase makes.
 *
 * A proof-required submit gate built on a CONFIRMED gold false-negative canonical
 * oracle would WITHHOLD the canonical-correct fix forever: the broken oracle can
 * never report a resolved sidecar, so `applyProofRequiredHardGate` rejects every
 * candidate. A proven-broken oracle must NOT hold hard submit authority ⇒ LIFT
 * proofRequired for this instance (mirror of the soft-port fail-open in
 * {@link makeCalibratedReproConsensusPort}). When the oracle is trustworthy
 * (not gold-FN) OR proof was never required, the gate is unchanged.
 *
 * `proofCalibration.falseNegative` is gold-derived telemetry (EVAL-ONLY) — it
 * flips a HARNESS submit gate only; it never reaches the agent or any prompt.
 */
export const computeEffectiveProofRequired = (
  verifySelectProofRequired: boolean,
  proofCalibration: ReproOracleCalibration,
): { effectiveProofRequired: boolean; proofGateFailOpen: boolean } => {
  // A proven-broken canonical oracle must NOT hold hard submit authority. Two
  // gold-calibrated failure modes both fail the gate OPEN (lift proofRequired):
  //   - `falseNegative` (P4): the oracle stays RED on the canonical-correct GOLD
  //     fix ⇒ it would withhold every correct candidate (too strict).
  //   - `vacuous` (P3): the oracle reports GREEN on the un-patched BASE tree ⇒ its
  //     "green" is meaningless and would false-GREEN a wrong candidate (too loose);
  //     a meaningless proof can't be trusted to gate, so don't require it.
  const proofGateFailOpen =
    verifySelectProofRequired &&
    (proofCalibration.falseNegative || (proofCalibration.vacuous ?? false))
  return {
    effectiveProofRequired: verifySelectProofRequired && !proofGateFailOpen,
    proofGateFailOpen,
  }
}

export const familyCoverageCoeditEnabled = (env: NodeJS.ProcessEnv): boolean =>
  gateOn(env, "QUANTA_BENCH_FAMILY_COVERAGE_COEDIT")

const resolveSelectionReproConsensus = async (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
  reproSources: readonly string[],
  mode: BenchPosture["verifySelectRepro"],
  proofRequired: boolean,
) => {
  const reproPolicy = selectionReproPolicy(mode)
  const calibrationUnavailable = unavailableReproOracleCalibration()
  if (!reproPolicy.enabled) {
    return {
      reproPolicy,
      resolvedKofNSelectionPort: undefined,
      reproConsensusProofSelectionPort: undefined,
      calibration: calibrationUnavailable,
      proofCalibration: calibrationUnavailable,
    }
  }
  // P4: when the proof gate is active, ALWAYS gold-calibrate its canonical oracle
  // — independent of `goldCalibrate` (soft `positive` mode also has a proof gate).
  // `reproSources` here is the CANONICAL submit-gate set (hardening is excluded
  // upstream by `reproducingReproSources`), so calibration is on the right set.
  const proofCalibration = proofRequired
    ? await calibrateProofOracle(instance, reproSources, sandbox, timeoutMs)
    : calibrationUnavailable
  if (reproPolicy.goldCalibrate) {
    const { port, calibration } = await makeCalibratedReproConsensusPort(
      instance,
      reproSources,
      sandbox,
      timeoutMs,
    )
    return {
      reproPolicy,
      resolvedKofNSelectionPort: port,
      reproConsensusProofSelectionPort: makeReproConsensusProofSelectionPort(
        instance,
        reproSources,
        sandbox,
        timeoutMs,
      ),
      // The hard-mode soft-port calibration already probed gold on the same
      // canonical set; prefer it (it carries goldVotes/goldK). The dedicated
      // proof calibration is the fallback for the soft `positive` path.
      calibration,
      proofCalibration: calibration.available ? calibration : proofCalibration,
    }
  }
  return {
    reproPolicy,
    resolvedKofNSelectionPort: makeReproConsensusSelectionPort(
      instance,
      reproSources,
      sandbox,
      timeoutMs,
    ),
    reproConsensusProofSelectionPort: makeReproConsensusProofSelectionPort(
      instance,
      reproSources,
      sandbox,
      timeoutMs,
    ),
    calibration: calibrationUnavailable,
    proofCalibration,
  }
}

/**
 * G1 cross-vendor diversity — resolve the LLM port that should GENERATE
 * verify-select candidate `index`. Pure (no I/O), so the lane→provider routing
 * is unit-testable in isolation.
 *
 * Routing rule: `lanes[index mod lanes.length]` — index-modulo only, NO issue /
 * gold / answer-key inspection. Diversity comes from the structural fan-out, not
 * from peeking at the task. The mapping is the SAME stable round-robin every run.
 *
 * Returns `deps.llm` UNCHANGED (the single-vendor path) whenever:
 *   - the `model-lane-diversity` posture is OFF, OR
 *   - `deps.llmLanes` is absent / has fewer than 2 distinct lanes
 * so an unconfigured environment is byte-identical to the pre-feature driver.
 */
export const resolveLaneLlm = (
  deps: Pick<RunInstanceDeps, "llm" | "llmLanes">,
  modelLaneDiversity: boolean,
  index: number,
): LLMPort => {
  if (!modelLaneDiversity) return deps.llm
  const lanes = deps.llmLanes
  if (lanes === undefined || lanes.length < 2) return deps.llm
  const lane = lanes[((index % lanes.length) + lanes.length) % lanes.length]
  return lane ?? deps.llm
}

const generateSelectionCandidate = async (args: {
  readonly index: number
  readonly seed: string | undefined
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly precomputedHint: string | undefined
  readonly reproHint: string | undefined
  readonly mergeHint: (seed: string | undefined) => string | undefined
  readonly postureOverride: BenchPosture | undefined
  readonly stateOverride: BenchKnobState | undefined
  readonly chaMultisiteSteer: string | undefined
  readonly concurrency: number | undefined
  readonly baseValidatedRed: boolean | null
  readonly generationErrors: Map<number, string>
  readonly addTurns: (turns: number) => void
}): Promise<Candidate> => {
  const isolated = args.concurrency !== undefined && args.concurrency > 1
  const candidateSandbox = isolated
    ? await forkSandbox(args.instance.id, args.sandbox)
    : args.sandbox
  // G1 cross-vendor diversity: resolve the per-candidate generator lane from the
  // SAME posture buildConfig reads, so candidate `index` is served by vendor lane
  // (index mod V) when the model-lane-diversity knob is on AND ≥2 lanes were
  // injected. Resolves to deps.llm otherwise (byte-identical single-vendor path).
  const lanePosture =
    args.postureOverride ??
    benchPostureFromState(args.stateOverride ?? resolveBenchKnobs({ envVars: process.env }), process.env)
  const laneLlm = resolveLaneLlm(args.deps, lanePosture.modelLaneDiversity, args.index)
  try {
    const phase = await runAgentPhase(
      args.instance,
      args.deps,
      candidateSandbox,
      args.signal,
      args.wiring,
      args.precomputedHint,
      args.reproHint,
      args.mergeHint(args.seed),
      args.postureOverride,
      args.stateOverride,
      args.chaMultisiteSteer,
      laneLlm,
    )
    args.addTurns(phase.turns)
    const generationError = selectionGenerationErrorOf({
      stopReason: phase.stopReason,
      patch: phase.patch,
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
    })
    if (generationError !== undefined) {
      args.generationErrors.set(args.index, generationError)
      throw new Error(generationError)
    }
    return {
      id: `cand-${args.index}`,
      patch: phase.patch,
      turns: phase.turns,
      files: filesFromPatch(phase.patch),
      baseValidatedRed: args.baseValidatedRed,
      sandboxPath: candidateSandbox,
      ...(phase.stopReason !== undefined ? { stopReason: phase.stopReason } : {}),
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
      ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
    }
  } finally {
    if (isolated) await cleanupSelectionCandidateSandbox(candidateSandbox)
  }
}

export const cleanupSelectionCandidateSandbox = async (
  sandbox: string,
  deps: {
    readonly evictLspWorkspaces?: (cwd: string) => Promise<void>
    readonly cleanupSandbox?: (sandbox: string) => Promise<void>
  } = {},
): Promise<void> => {
  const evict = deps.evictLspWorkspaces ?? evictLspWorkspaces
  const cleanup = deps.cleanupSandbox ?? cleanupSandbox
  await evict(sandbox).catch(() => undefined)
  await cleanup(sandbox)
}

const resolveSelectionPhasePorts = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly selectorMode: BenchPosture["selectorMode"]
  readonly riskGate: boolean
  readonly llmRiskGateMode: BenchPosture["verifySelectLlmRiskGate"]
  /** G1 cross-vendor diversity: when ON (and ≥2 lanes injected) the LLM
   *  risk-gate JUDGE is routed to vendor lane 1 — a DIFFERENT vendor than the
   *  cand0 generator (lane 0) — so the judge is decorrelated from the generator
   *  it scores. OFF ⇒ judge stays on `deps.llm` (byte-identical). */
  readonly modelLaneDiversity: boolean
  readonly verifySelectRegression: BenchPosture["verifySelectRegression"]
  readonly verifySelectRepro: BenchPosture["verifySelectRepro"]
  readonly verifySelectProofRequired: boolean
  readonly regressionMaxTests: number | undefined
  readonly reproSources: readonly string[]
  readonly baseValidatedRed: boolean
  readonly selectionOwnerCandidates: readonly string[]
  readonly selectionOwnerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
}) => {
  const {
    reproPolicy,
    resolvedKofNSelectionPort,
    reproConsensusProofSelectionPort,
    calibration,
    proofCalibration,
  } = await resolveSelectionReproConsensus(
    args.instance,
    args.sandbox,
    args.deps.timeoutMs,
    args.reproSources,
    args.verifySelectRepro,
    args.verifySelectProofRequired,
  )
  const regressionMaxTests =
    args.regressionMaxTests !== undefined ? { maxTests: args.regressionMaxTests } : {}
  const discoveredRegressionPort =
    args.verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionPort({
          instance: args.instance,
          sandbox: args.sandbox,
          timeoutMs: args.deps.timeoutMs,
          ...regressionMaxTests,
        })
      : undefined
  const publicRegressionProofSelectionPort =
    args.verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionProofPort({
          instance: args.instance,
          sandbox: args.sandbox,
          timeoutMs: args.deps.timeoutMs,
          ...regressionMaxTests,
        })
      : undefined
  const regressionSelectionPort = makeSelectionRegressionPort({
    verifySelectRegression: args.verifySelectRegression,
    discoveredRegressionPort,
    instance: args.instance,
    sandbox: args.sandbox,
    timeoutMs: args.deps.timeoutMs,
  })
  const staticSanitySelectionPort = makeSelectionStaticSanityPort({
    sandbox: args.sandbox,
    baseCommit: args.instance.swebench?.baseCommit,
    timeoutMs: args.deps.timeoutMs,
  })
  const smokeSelectionPort = await prepareIssueSmokeSelectionPort(
    args.instance,
    args.sandbox,
    args.deps.timeoutMs,
  )
  const mweProofSelectionPort =
    args.selectorMode === "clean"
      ? await prepareMweProofSelectionPort(args.instance, args.sandbox, args.deps.timeoutMs)
      : undefined
  const selectionRiskGate = buildSelectionRiskGate({
    structural: args.riskGate,
    llmMode: args.llmRiskGateMode,
    // G1: route the JUDGE to vendor lane 1 (distinct from the cand0 generator on
    // lane 0) when diversity is ON, so generation and judging are cross-vendor.
    llm: resolveLaneLlm(args.deps, args.modelLaneDiversity, 1),
    problemStatement: args.instance.problemStatement,
    ownerFiles: args.selectionOwnerCandidates,
    ownerEvidence: args.selectionOwnerEvidence,
    ...(args.instance.swebench?.repo !== undefined ? { repo: args.instance.swebench.repo } : {}),
    signal: args.signal,
  })
  return {
    reproPolicy,
    resolvedKofNSelectionPort,
    calibration,
    proofCalibration,
    regressionSelectionPort,
    publicRegressionProofSelectionPort,
    reproConsensusProofSelectionPort,
    staticSanitySelectionPort,
    smokeSelectionPort,
    mweProofSelectionPort,
    selectionBaseValidatedRed:
      args.verifySelectRegression === "discovered" ? null : args.baseValidatedRed,
    selectionRiskGate,
  }
}

type SelectionExecutorPortsArgs = {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly selectorMode: BenchPosture["selectorMode"]
  readonly verifySelectProofRequired: boolean
  readonly wiring: Wiring
  readonly precomputedHint: string | undefined
  readonly reproHint: string | undefined
  readonly closureHint: string | undefined
  readonly postureOverride: BenchPosture | undefined
  readonly stateOverride: BenchKnobState | undefined
  readonly chaMultisiteSteer: string | undefined
  readonly chaRepairTargets: readonly ChaRepairTarget[]
  /** jun-25: CHA contract-fallback sibling mode for the selection-time structural
   *  repair port. "general" only when `cha-multisite-general` is on. */
  readonly chaSiblingMode: "path-hardcoded" | "general"
  readonly selectionOwnerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
  readonly envCaveats: readonly string[]
  readonly validatedReproScripts: readonly string[]
  readonly existingTestExpectations: readonly string[]
  readonly staticWitnessDiagnostics: readonly StaticWitnessDiagnostic[]
  readonly promptContracts: SelectionContractBundle | undefined
  readonly verificationTarget: VerificationTargetFact | undefined
  readonly recordLlmEvidencePacket: ((packet: LlmEvidencePacket) => void) | undefined
  readonly concurrency: number | undefined
  readonly generationErrors: Map<number, string>
  readonly addTurns: (turns: number) => void
  readonly baseValidatedRed: boolean | null
  readonly staticSanitySelectionPort: NonNullable<SelectionPorts["staticSanity"]>
  readonly regressionSelectionPort: NonNullable<SelectionPorts["regression"]>
  readonly publicRegressionProofSelectionPort: SelectionPorts["publicRegressionProof"]
  readonly smokeSelectionPort: SelectionPorts["smoke"]
  readonly mweProofSelectionPort: SelectionPorts["mweProof"]
  readonly resolvedKofNSelectionPort: SelectionPorts["resolvedKofN"]
  readonly reproConsensusProofSelectionPort: SelectionPorts["reproConsensusProof"]
}

const generateSelectionPort =
  (args: SelectionExecutorPortsArgs) => (index: number, seed?: string) =>
    generateSelectionCandidate({
      index,
      seed,
      instance: args.instance,
      deps: args.deps,
      sandbox: args.sandbox,
      signal: args.signal,
      wiring: args.wiring,
      precomputedHint: args.precomputedHint,
      reproHint: args.reproHint,
      postureOverride: args.postureOverride,
      stateOverride: args.stateOverride,
      chaMultisiteSteer: args.chaMultisiteSteer,
      mergeHint: (seedHint) =>
        composeSelectionAgentHint(
          {
            verifySelectProofRequired: args.verifySelectProofRequired,
            selectorMode: args.selectorMode,
            problemStatement: args.instance.problemStatement,
            ownerEvidence: args.selectionOwnerEvidence,
            promptContracts: args.promptContracts,
            baseValidatedRed: args.baseValidatedRed,
            ...(args.verificationTarget !== undefined
              ? { verificationTarget: args.verificationTarget }
              : {}),
            ...(args.reproHint !== undefined ? { reproHint: args.reproHint } : {}),
            validatedReproScripts: args.validatedReproScripts,
            existingTestExpectations: args.existingTestExpectations,
            ...(args.closureHint !== undefined ? { closureHint: args.closureHint } : {}),
            envCaveats: args.envCaveats,
            staticWitnessDiagnostics: args.staticWitnessDiagnostics,
            ...(args.recordLlmEvidencePacket !== undefined
              ? { recordLlmEvidencePacket: args.recordLlmEvidencePacket }
              : {}),
          },
          seedHint,
        ),
      concurrency: args.concurrency,
      baseValidatedRed: args.baseValidatedRed,
      generationErrors: args.generationErrors,
      addTurns: args.addTurns,
    })

const buildSelectionExecutorPorts = (args: SelectionExecutorPortsArgs): SelectionPorts => {
  const ports: SelectionPorts = {
    generate: generateSelectionPort(args),
    applyClean: (candidate) =>
      candidatePatchAppliesCleanly({
        sandbox: args.sandbox,
        patch: candidate.patch,
        baseCommit: args.instance.swebench?.baseCommit,
        timeoutMs: args.deps.timeoutMs,
      }),
    staticSanity: args.staticSanitySelectionPort,
    regression: args.regressionSelectionPort,
  }
  if (args.smokeSelectionPort !== undefined) ports.smoke = args.smokeSelectionPort
  if (args.mweProofSelectionPort !== undefined) ports.mweProof = args.mweProofSelectionPort
  if (args.publicRegressionProofSelectionPort !== undefined)
    ports.publicRegressionProof = args.publicRegressionProofSelectionPort
  if (args.resolvedKofNSelectionPort !== undefined)
    ports.resolvedKofN = args.resolvedKofNSelectionPort
  if (args.reproConsensusProofSelectionPort !== undefined)
    ports.reproConsensusProof = args.reproConsensusProofSelectionPort
  if (args.selectorMode === "clean") {
    ports.deriveCandidateStructuralRepair = (candidate) =>
      deriveCandidateStructuralRepair({
        instance: args.instance,
        candidate,
        sandbox: args.sandbox,
        signal: args.signal,
        preferredTargets: args.chaRepairTargets,
        siblingMode: args.chaSiblingMode,
      })
    if (familyCoverageCoeditEnabled(process.env)) {
      ports.repairFamilyCoverage = ({ candidate, family, missingFiles }) =>
        coeditFamilyCoverageCandidate({
          sandbox: args.sandbox,
          candidate,
          family,
          missingFiles,
          timeoutMs: args.deps.timeoutMs,
          baseCommit: args.instance.swebench?.baseCommit,
          repo: args.instance.swebench?.repo,
          preferredTargets: args.chaRepairTargets,
        })
    }
  }
  return ports
}

const selectionGenerationFailurePhase = (args: {
  readonly result: Awaited<ReturnType<typeof runSelection>>
  readonly generationErrors: Map<number, string>
  readonly totalTurns: number
  readonly n: number
  readonly calibration: ReproOracleCalibration | undefined
}): Phase | undefined => {
  if (args.result.successfulGenerations > 0 || args.result.generationFailures === 0)
    return undefined
  const orderedErrors = [...args.generationErrors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, error]) => error)
  const sample = orderedErrors.slice(0, 2).join("; ")
  return {
    patch: "",
    turns: args.totalTurns,
    stopReason: "error",
    agentError:
      "agent stopped with error before verification: " +
      `verify-select candidate generation failed for all ${args.n} candidates` +
      (sample === "" ? "" : ` (${sample})`),
    selectionTelemetry:
      orderedErrors.length === 0
        ? summarizeSelection(args.result)
        : {
            ...summarizeSelection(args.result),
            generationFailureSamples: orderedErrors.slice(0, 2),
          },
    ...(args.calibration !== undefined ? { reproOracleCalibration: args.calibration } : {}),
  }
}

const selectionPhaseResultOf = (args: {
  readonly result: Awaited<ReturnType<typeof runSelection>>
  readonly generationErrors: Map<number, string>
  readonly totalTurns: number
  readonly calibration: ReproOracleCalibration | undefined
}): Phase => {
  const orderedErrors = [...args.generationErrors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, error]) => error)
  const phase: Phase = {
    patch: args.result.winner?.patch ?? "",
    turns: args.totalTurns,
    selectionTelemetry:
      orderedErrors.length === 0
        ? summarizeSelection(args.result)
        : {
            ...summarizeSelection(args.result),
            generationFailureSamples: orderedErrors.slice(0, 2),
          },
    ...(args.calibration !== undefined ? { reproOracleCalibration: args.calibration } : {}),
  }
  if (args.result.terminalCandidate?.stopReason !== undefined)
    phase.stopReason = args.result.terminalCandidate.stopReason
  if (args.result.terminalCandidate?.agentError !== undefined)
    phase.agentError = args.result.terminalCandidate.agentError
  if (args.result.terminalCandidate?.editCount !== undefined)
    phase.editCount = args.result.terminalCandidate.editCount
  return phase
}

// P4 RECORD assembly: build the terminal {@link Phase} from a completed
// {@link runSelection}. Prefers the dedicated `proofCalibration` (soft `positive`
// path only ran that one) over the hard-mode `calibration`; this is EVAL-ONLY
// telemetry, never an inference-time gate. Returns the generation-failure phase
// when every candidate failed to generate, else the winner phase (with any
// accumulated LLM evidence attached). Extracted verbatim from runSelectionPhase.
const finalizeSelectionPhase = (args: {
  readonly result: Awaited<ReturnType<typeof runSelection>>
  readonly generationErrors: Map<number, string>
  readonly totalTurns: number
  readonly n: number
  readonly proofCalibration: ReproOracleCalibration
  readonly calibration: ReproOracleCalibration
  readonly selectionLlmEvidence: Partial<LlmEvidenceArtifacts>
}): Phase => {
  const reportCalibration = args.proofCalibration.available
    ? args.proofCalibration
    : args.calibration
  const generationFailure = selectionGenerationFailurePhase({
    result: args.result,
    generationErrors: args.generationErrors,
    totalTurns: args.totalTurns,
    n: args.n,
    calibration: reportCalibration,
  })
  if (generationFailure !== undefined) return generationFailure
  const phase = selectionPhaseResultOf({
    result: args.result,
    generationErrors: args.generationErrors,
    totalTurns: args.totalTurns,
    calibration: reportCalibration,
  })
  if (Object.keys(args.selectionLlmEvidence).length > 0)
    phase.llmEvidence = args.selectionLlmEvidence
  return phase
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
  earlyAccept: boolean,
  riskGate: boolean,
  llmRiskGateMode: BenchPosture["verifySelectLlmRiskGate"],
  counterfactual: boolean,
  selectorMode: BenchPosture["selectorMode"],
  verifySelectProofRequired: boolean,
  publicContracts: SelectionContractBundle | undefined,
  verifySelectRegression: BenchPosture["verifySelectRegression"],
  regressionMaxTests: number | undefined,
  verifySelectRepro: BenchPosture["verifySelectRepro"],
  selectionOwnerCandidates: readonly string[],
  ownerResolved: readonly OwnerSibling[] | undefined,
  baseValidatedRed: boolean,
  verificationPlan: ClosureSessionState["bundle"]["plan"] | undefined,
  existingTestExpectations: readonly string[],
  reproTest: BenchReproTestTelemetry | undefined,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  reproSources: readonly string[],
  hardeningReproSources: readonly string[],
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaMultisiteSteer?: string,
  chaRepairTargets?: readonly ChaRepairTarget[],
): Promise<Phase> => {
  // jun-23 split: ADVISORY repair seed = canonical (submit-gate) scripts FIRST,
  // then any hardening scripts as extra coverage guidance. Hardening NEVER gates
  // submit; it only seeds repair / breaks ties. Canonical-only ⇒ byte-identical.
  const oracleFailureRepairSeed = validatedReproRepairSeed([
    ...reproSources,
    ...hardeningReproSources,
  ])
  const generationErrors = new Map<number, string>()
  const selectionLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  const selectionContext = prepareSelectionEvidenceContext({
    problemStatement: instance.problemStatement,
    sandbox,
    n,
    ownerCandidates: selectionOwnerCandidates,
    ownerResolved,
    publicContracts,
    verifySelectRegression,
    baseValidatedRed,
    reproHint,
    reproTest,
    verificationTarget: verificationTargetFromPlan(verificationPlan),
    oracleFailureRepairSeed,
    existingTestExpectations,
    readSource: (rel) => readSandboxSource(sandbox, rel),
  })
  const {
    advisoryPromptContracts,
    selectionAuthorityContracts,
    selectionInputs,
    selectionOwnerEvidence,
    verificationTarget,
    existingTestExpectations: selectionExistingTestExpectations,
    staticWitnessDiagnostics,
    generationEnvCaveats,
  } = selectionContext
  let totalTurns = 0
  const selectionState = await resolveSelectionPhasePorts({
    instance,
    deps,
    sandbox,
    signal,
    selectorMode,
    riskGate,
    llmRiskGateMode,
    modelLaneDiversity: postureOverride?.modelLaneDiversity ?? false,
    verifySelectRegression,
    regressionMaxTests,
    verifySelectRepro,
    verifySelectProofRequired,
    reproSources,
    baseValidatedRed,
    selectionOwnerCandidates,
    selectionOwnerEvidence,
  })
  // P4 PROOF-GATE FAIL-OPEN (THE structural fix for Defect 2): when the CANONICAL
  // repro oracle is a CONFIRMED gold false-negative, a proof-required gate built on
  // it would WITHHOLD the canonical-correct fix (the proven-broken oracle can never
  // report a resolved sidecar, so `applyProofRequiredHardGate` rejects every candidate).
  // A proven-broken oracle must NOT hold hard submit authority ⇒ LIFT proofRequired
  // for this instance. This is the EXACT decision point (mirror of the soft-port
  // fail-open in makeCalibratedReproConsensusPort). Gold is EVAL-ONLY telemetry — it
  // never reaches the agent or any prompt; this only flips a harness submit gate.
  const { effectiveProofRequired } = computeEffectiveProofRequired(
    verifySelectProofRequired,
    selectionState.proofCalibration,
  )
  const result = await runSelection({
    n,
    problemStatement: instance.problemStatement,
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    // jun-23 W2-2 (B1): thread the slice reader + public issue symbols so the
    // SELECTOR repair packet carries the real owner source slice (engage), not a
    // path-only stub — mirrors the generation/classic-repair owner evidence.
    repairReadSource: (rel) => readSandboxSource(sandbox, rel),
    repairIssueSymbols: extractIssueHint(instance.problemStatement).symbols,
    repairOwnerEvidence: selectionOwnerEvidence,
    owners: selectionInputs.owners,
    seeds: selectionInputs.seeds,
    candidateFamilies: selectionInputs.candidateFamilies,
    resolvedKofNMode: selectionState.reproPolicy.resolvedKofNMode,
    earlyAccept,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(selectionState.selectionRiskGate !== undefined
      ? { riskGate: selectionState.selectionRiskGate }
      : {}),
    ...(counterfactual ? { counterfactual: true } : {}),
    mode: selectorMode,
    ...(effectiveProofRequired ? { proofRequired: true } : {}),
    ...(selectionAuthorityContracts !== undefined
      ? { publicContracts: selectionAuthorityContracts }
      : {}),
    ...(oracleFailureRepairSeed !== undefined ? { oracleFailureRepairSeed } : {}),
    recordLlmEvidencePacket: (packet) => {
      recordLlmEvidencePacket(selectionLlmEvidence, packet)
    },
    ports: buildSelectionExecutorPorts({
      instance,
      deps,
      sandbox,
      signal,
      selectorMode,
      wiring: w,
      precomputedHint,
      reproHint,
      closureHint,
      postureOverride,
      stateOverride,
      chaMultisiteSteer,
      chaRepairTargets: chaRepairTargets ?? [],
      chaSiblingMode: postureOverride?.chaMultisiteGeneral ? "general" : "path-hardcoded",
      concurrency,
      generationErrors,
      addTurns: (turns) => {
        totalTurns += turns
      },
      baseValidatedRed: selectionState.selectionBaseValidatedRed,
      staticSanitySelectionPort: selectionState.staticSanitySelectionPort,
      regressionSelectionPort: selectionState.regressionSelectionPort,
      publicRegressionProofSelectionPort: selectionState.publicRegressionProofSelectionPort,
      smokeSelectionPort: selectionState.smokeSelectionPort,
      mweProofSelectionPort: selectionState.mweProofSelectionPort,
      resolvedKofNSelectionPort: selectionState.resolvedKofNSelectionPort,
      reproConsensusProofSelectionPort: selectionState.reproConsensusProofSelectionPort,
      verifySelectProofRequired,
      selectionOwnerEvidence,
      envCaveats: generationEnvCaveats,
      validatedReproScripts: reproSources,
      existingTestExpectations: selectionExistingTestExpectations,
      staticWitnessDiagnostics,
      promptContracts: advisoryPromptContracts,
      verificationTarget,
      recordLlmEvidencePacket: (packet) => {
        recordLlmEvidencePacket(selectionLlmEvidence, packet)
      },
    }),
  })
  return finalizeSelectionPhase({
    result,
    generationErrors,
    totalTurns,
    n,
    proofCalibration: selectionState.proofCalibration,
    calibration: selectionState.calibration,
    selectionLlmEvidence,
  })
}

const okResult = (
  instance: Instance,
  phase: Phase,
  v: { passed: boolean; error?: string },
  extra: Partial<InstanceResult>,
): InstanceResult => {
  const keepTerminalAuthority = phase.stopReason !== "error" && phase.stopReason !== "refusal"
  return {
    id: instance.id,
    passed: v.passed,
    patch: phase.patch,
    turns: phase.turns,
    ...(keepTerminalAuthority && phase.stopReason !== undefined
      ? { stopReason: phase.stopReason }
      : {}),
    ...(v.error !== undefined ? { error: v.error } : {}),
    ...extra,
  }
}

const reproResultExtra = (
  reproTest: BenchReproTestTelemetry | undefined,
): Partial<InstanceResult> => (reproTest === undefined ? {} : { reproTest })

const shouldValidateGold = (deps: RunInstanceDeps, agentPassed: boolean): boolean =>
  deps.goldSanity !== undefined && (deps.goldSanity.mode === "always" || agentPassed === false)

const agentPhaseError = (phase: Phase): string | undefined => {
  // T5 — a capture-desync (successful source edits observed but an empty done-time
  // diff) is an INFRA fault, not a model miss. On the SINGLE-PASS path the agent can
  // stop `completed` with an empty patch, so the generic stopReason branches below
  // would mislabel it real-fail/completed_unresolved (never retried). Surface the
  // `capture_lost_edits` marker here so classifyOutcome's CAPTURE_DESYNC_RE routes it
  // to infra-fail/retry — symmetric with the selection path's isCaptureFailure throw.
  // Gated on a lost-edits captureClass ⇒ byte-identical for every other run.
  if (
    phase.captureClass !== undefined &&
    isCaptureFailure(phase.captureClass) &&
    phase.patch.trim() === ""
  ) {
    return phase.agentError ?? "capture_lost_edits: source edits observed but done-time diff empty"
  }
  const patchCaptureMiss = patchCaptureMissErrorOf(phase)
  if (patchCaptureMiss !== undefined) return patchCaptureMiss
  const noPatchExhausted = noPatchExhaustedErrorOf({
    enabled: benchOptIns().noPatchBreaker,
    stopReason: phase.stopReason,
    patch: phase.patch,
    ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
  })
  if (noPatchExhausted !== undefined) return noPatchExhausted
  if (phase.stopReason === "max_turns" && phase.patch.trim() === "") {
    return "agent reached max turns before verification"
  }
  if (phase.stopReason === "error" && phase.patch.trim() === "") {
    return phase.agentError ?? "agent stopped with error before verification"
  }
  if (phase.stopReason === "refusal" && phase.patch.trim() === "") {
    return "agent stopped with refusal before verification"
  }
  if (phase.stopReason === "aborted" && phase.patch.trim() === "") {
    return "agent aborted before verification"
  }
  if (phase.stopReason === "budget_exhausted" && phase.patch.trim() === "") {
    return "agent exhausted token budget before verification"
  }
  return undefined
}

const patchCaptureMissErrorOf = (phase: Phase): string | undefined =>
  phase.patch.trim() === "" && phase.stopReason === "aborted" && (phase.editCount ?? 0) > 0
    ? "patch capture miss: agent edited files before abort, but final git diff was empty"
    : undefined

const noWinnerTerminalReasonOf = (phase: Phase): string => {
  if (phase.selectionTelemetry?.noWinnerReason === "proof_required_missing") {
    return "verify-select proof-required mode produced no submittable candidate (no candidate achieved positive executed public proof)"
  }
  if (phase.selectionTelemetry?.noWinnerReason === "proof_infra_blocked") {
    return "verify-select proof-required mode produced no submittable candidate (public proof execution was infra-blocked)"
  }
  return "verify-select produced no submittable candidate (every candidate was either hard-rejected, empty, or did not apply)"
}

const selectionNoWinnerErrorOf = (phase: Phase): string | undefined => {
  if (phase.selectionTelemetry?.winnerId !== null) return undefined
  return agentPhaseError(phase) ?? noWinnerTerminalReasonOf(phase)
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
  const extra: Partial<InstanceResult> = {
    ...reproResultExtra(args.reproTest),
    ...(args.phase.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: args.phase.reproOracleCalibration }
      : {}),
    ...(args.phase.selectionTelemetry !== undefined
      ? { selectionTelemetry: args.phase.selectionTelemetry }
      : {}),
  }
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
  }
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...(args.phase.stopReason !== undefined ? { stopReason: args.phase.stopReason } : {}),
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
  const extra: Partial<InstanceResult> = {
    ...reproResultExtra(args.reproTest),
    ...(args.phase.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: args.phase.reproOracleCalibration }
      : {}),
    ...(args.phase.selectionTelemetry !== undefined
      ? { selectionTelemetry: args.phase.selectionTelemetry }
      : {}),
  }
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
  }
  const noWinnerError = patchCaptureMissErrorOf(args.phase) ?? selectionNoWinnerErrorOf(args.phase)
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...(args.phase.stopReason !== undefined ? { stopReason: args.phase.stopReason } : {}),
    ...(noWinnerError !== undefined ? { error: noWinnerError } : {}),
    ...extra,
  }
}

export const terminalAgentResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult | undefined => {
  if (
    args.phase.patch.trim() === "" &&
    args.phase.selectionTelemetry?.winnerId === null &&
    args.phase.stopReason !== "error" &&
    args.phase.stopReason !== "refusal"
  ) {
    return noPatchResult(args)
  }
  const generationError = agentPhaseError(args.phase)
  if (generationError !== undefined) {
    return generationFailureResult({ ...args, generationError })
  }
  if (args.phase.patch.trim() === "") return noPatchResult(args)
  return undefined
}

type RepairConfig = NonNullable<RunInstanceDeps["repair"]>

interface HintReproContext {
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

export const envPrepFailedResult = (
  instance: Instance,
  prep: { readonly code: number; readonly stderr: string },
): InstanceResult => ({
  id: instance.id,
  passed: false,
  patch: "",
  turns: 0,
  verdict: "env_prep_failed",
  error: `env prep (setupCmd) failed (code ${prep.code}): ${prep.stderr.slice(0, 500)}`,
})

const stage1FilesOf = (files: readonly string[]): readonly { file: string; score: number }[] =>
  files.map((file, i) => ({
    file,
    score: files.length - i,
  }))

const readSandboxSource = (sandbox: string, rel: string): string | null => {
  try {
    return readFileSync(join(sandbox, rel), "utf8")
  } catch {
    return null
  }
}

const betterRepairFamily = (
  candidateFiles: readonly string[],
  left: CandidateFamily | undefined,
  right: CandidateFamily,
): CandidateFamily => {
  if (left === undefined) return right
  const leftMissing = candidateFamilyCoverageMissing(left, candidateFiles).length
  const rightMissing = candidateFamilyCoverageMissing(right, candidateFiles).length
  if (rightMissing !== leftMissing) return rightMissing > leftMissing ? right : left
  if (right.ownerFiles.length !== left.ownerFiles.length)
    return right.ownerFiles.length > left.ownerFiles.length ? right : left
  return left
}

const familyFromChaRepairTarget = (target: ChaRepairTarget): CandidateFamily => ({
  familyId: "override-family",
  ownerFiles: cleanUniqueList([target.file, ...target.sites.map((site) => site.file)]),
  reason: `override-family (CHA sibling override): \`${target.method}\` overridden by sibling classes sharing a base`,
  seed: buildMultisiteSteer(target.method, target.sites),
  sourceEvidence: ["cha-multisite:python-ast"],
})

const preferredChaFamily = (
  candidateFiles: readonly string[],
  preferredTargets: readonly ChaRepairTarget[],
): CandidateFamily | undefined => {
  let best: CandidateFamily | undefined
  const matchingTargets = preferredTargets.filter((target) =>
    cleanUniqueList([target.file, ...target.sites.map((site) => site.file)]).some((file) =>
      candidateFiles.includes(file),
    ),
  )
  for (const target of matchingTargets) {
    const family = familyFromChaRepairTarget(target)
    if (candidateFamilyCoverageMissing(family, candidateFiles).length === 0) continue
    best = betterRepairFamily(candidateFiles, best, family)
  }
  return best
}

const deriveChaOverrideFamily = async (args: {
  readonly instance: Instance
  readonly candidate: Candidate
  readonly sandbox: string
  readonly preferredTargets?: readonly ChaRepairTarget[]
  readonly siblingMode: "path-hardcoded" | "general"
}): Promise<CandidateFamily | undefined> => {
  if (args.candidate.patch.trim() === "" || args.candidate.files.length === 0) return undefined
  let best = preferredChaFamily(args.candidate.files, args.preferredTargets ?? [])
  const touchedSymbols = diffTouchedSymbols(args.candidate.patch)
  if (touchedSymbols.length === 0) return best
  const chaExec = (cmd: string, cwd: string, timeoutMs: number) =>
    exec(
      cmd,
      cwd,
      timeoutMs,
      args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : undefined,
    )
  for (const targetFile of args.candidate.files) {
    for (const symbol of touchedSymbols) {
      const sites = await findSiblingOverrideSites({
        exec: chaExec,
        repoRoot: args.sandbox,
        targetRelFile: targetFile,
        method: symbol,
        siblingMode: args.siblingMode,
      })
      if (sites.length === 0) continue
      const family = familyFromChaRepairTarget({ file: targetFile, method: symbol, sites })
      if (candidateFamilyCoverageMissing(family, args.candidate.files).length === 0) continue
      best = betterRepairFamily(args.candidate.files, best, family)
    }
  }
  return best
}

export const deriveCandidateStructuralRepair = async (args: {
  readonly instance: Instance
  readonly candidate: Candidate
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly preferredTargets?: readonly ChaRepairTarget[]
  readonly siblingMode?: "path-hardcoded" | "general"
}): Promise<DerivedCandidateStructuralRepair | undefined> => {
  if (args.candidate.files.length === 0) return undefined
  const ownerResolved = await resolveOwnerSiblings()({
    stage1Files: stage1FilesOf(args.candidate.files),
    issueText: args.instance.problemStatement,
    cwd: args.sandbox,
    readSource: (rel) => readSandboxSource(args.sandbox, rel),
    signal: args.signal,
  })
  const selectionOwnerCandidates = cleanUniqueList([
    ...args.candidate.files,
    ...ownerResolved.map((owner) => owner.file),
  ])
  const structural = buildSelectionStructuralPlan({
    problemStatement: args.instance.problemStatement,
    sandbox: args.sandbox,
    selectionOwnerCandidates,
    ownerResolved,
    publicContracts: undefined,
    n: 2,
    readSource: (rel) => readSandboxSource(args.sandbox, rel),
  })
  const chaFamily = await deriveChaOverrideFamily({
    ...args,
    siblingMode: args.siblingMode ?? "path-hardcoded",
  })
  const family =
    chaFamily === undefined
      ? structural.selectionInputs.candidateFamilies[1]
      : betterRepairFamily(
          args.candidate.files,
          structural.selectionInputs.candidateFamilies[1],
          chaFamily,
        )
  if (family === undefined && structural.advisoryPromptContracts === undefined) return undefined
  return {
    ...(family !== undefined ? { family } : {}),
    ...(structural.advisoryPromptContracts !== undefined
      ? { advisoryContracts: structural.advisoryPromptContracts }
      : {}),
  }
}

export const withCandidateFamilyPublicContracts = withCandidateFamilyAuthorityContracts

export const makeSelectionRegressionPort = (args: {
  readonly verifySelectRegression: BenchPosture["verifySelectRegression"]
  readonly discoveredRegressionPort: SelectionPorts["regression"] | undefined
  readonly instance: Instance
  readonly sandbox: string
  readonly timeoutMs: number
}): NonNullable<SelectionPorts["regression"]> => {
  return (candidate) => {
    // FAIL-CLOSED (jun-22): unset ⇒ `off`. The hidden PASS_TO_PASS branch below
    // reads the grader's answer-key regression set, so it must require an EXPLICIT
    // opt-in (the `gold`/`pass-to-pass` mode). Previously `undefined` fell through
    // to it AND escaped the contamination tagger — a one-forgotten-preset-line
    // answer-key leak. Now only an explicit non-off/non-discovered mode reaches it.
    if (args.verifySelectRegression === "off" || args.verifySelectRegression === undefined)
      return Promise.resolve(null)
    if (args.verifySelectRegression === "discovered") {
      return args.discoveredRegressionPort?.(candidate) ?? Promise.resolve(null)
    }
    const tests = args.instance.swebench?.passToPass ?? []
    if (tests.length === 0) return Promise.resolve(null)
    return withCandidatePatch({
      sandbox: args.sandbox,
      patch: candidate.patch,
      baseCommit: args.instance.swebench?.baseCommit,
      ...(args.instance.swebench?.repo !== undefined ? { repo: args.instance.swebench.repo } : {}),
      timeoutMs: args.timeoutMs,
      probe: async (sb) => {
        const r = await makeBenchRegressionOracle(
          undefined,
          args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : {},
        )
          .run({ tests, sandbox: sb })
          .catch(() => null)
        return toRegressionGreen(tests, r)
      },
    })
  }
}

export const makeSelectionStaticSanityPort = (args: {
  readonly sandbox: string
  readonly baseCommit: string | undefined
  readonly timeoutMs: number
}): NonNullable<SelectionPorts["staticSanity"]> => {
  return (candidate) =>
    withCandidatePatch({
      sandbox: args.sandbox,
      patch: candidate.patch,
      baseCommit: args.baseCommit,
      timeoutMs: args.timeoutMs,
      probe: (sb) =>
        probePatchStaticSanity({
          cwd: sb,
          files: candidate.files,
          timeoutMs: args.timeoutMs,
          patch: candidate.patch,
        }),
    }).catch(() => null)
}

const prepareHintAndReproContext = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
  posture: BenchPosture,
): Promise<HintReproContext> => {
  let localizeCandidates: readonly string[] = []
  const precomputedHint = await prepareIssueHint(instance, sandbox, posture.issueHintMode, {
    llm,
    issueHintExpectedActual: posture.issueHintExpectedActual,
    ...(posture.localizeBudget !== undefined ? { localizeBudget: posture.localizeBudget } : {}),
    onCandidates: (files) => {
      localizeCandidates = files
    },
  })
  const chaMultisite = await resolveChaMultisiteContext({
    instance,
    sandbox,
    posture,
    localizeCandidates,
  })
  const reproInstall = benchInstallsReproHint(posture.inLoopExecMode)
    ? await installReproTestHint(instance, sandbox, posture, llm)
    : { hint: undefined, telemetry: undefined }
  const selectionRepro =
    reproInstall.telemetry !== undefined
      ? {
          telemetry: reproInstall.telemetry,
          hint: reproInstall.hint,
          reproSources: reproInstall.reproSources ?? [],
          hardeningReproSources: reproInstall.hardeningReproSources ?? [],
        }
      : await prepareSelectionReproSources(instance, sandbox, llm, posture)
  return {
    posture,
    precomputedHint,
    chaMultisiteSteer: chaMultisite.steer,
    chaRepairTargets: chaMultisite.repairTargets,
    localizeCandidates,
    reproHint: reproInstall.hint ?? selectionRepro.hint,
    reproTest: selectionRepro.telemetry,
    reproSources: selectionRepro.reproSources,
    hardeningReproSources: selectionRepro.hardeningReproSources,
  }
}

const resolveOwnerResolved = async (args: {
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly stage1Files: readonly { file: string; score: number }[]
  readonly sandbox: string
  readonly signal: AbortSignal
}): Promise<readonly OwnerSibling[] | undefined> => {
  if (
    !(args.instance.swebench !== undefined && args.posture.faultEvidence && args.posture.lspNav)
  ) {
    return undefined
  }
  return resolveOwnerSiblings()({
    stage1Files: args.stage1Files,
    issueText: args.instance.problemStatement,
    cwd: args.sandbox,
    readSource: (rel) => readSandboxSource(args.sandbox, rel),
    signal: args.signal,
  })
}

const verificationOwnerCandidatesOf = (args: {
  readonly witnessOwners?: readonly { file: string; forSymbol?: string }[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly stage1Files: readonly { file: string; score: number }[]
}): readonly string[] =>
  cleanUniqueList([
    ...(args.witnessOwners?.map((owner) => owner.file) ?? []),
    ...(args.ownerResolved?.map((owner) => owner.file) ?? []),
    ...args.stage1Files.map((file) => file.file),
  ])

const buildClosureAttemptState = (args: {
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly stage1Files: readonly { file: string; score: number }[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly witnessOwners?: readonly { file: string; forSymbol?: string }[]
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly ownerNearTests?: readonly string[]
}): ClosureSessionState | undefined =>
  args.instance.swebench === undefined
    ? undefined
    : buildClosureSession({
        problemStatement: args.instance.problemStatement,
        stage1Files: args.stage1Files,
        ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
        ...(args.witnessOwners && args.witnessOwners.length > 0
          ? { witnessOwners: args.witnessOwners }
          : {}),
        ...(args.reproTest?.installed === true && args.reproTest.reproducedCount > 0
          ? {
              reproScript: {
                cmd: reproValidationCmd({
                  repo: args.instance.swebench.repo,
                  version: args.instance.swebench.version,
                  scriptPath: args.reproTest.path,
                }),
                pytestReportPath: pytestReportPathFor(args.reproTest.path),
                baseValidatedRed: true,
              },
            }
          : {}),
        ...(args.ownerNearTests !== undefined && args.ownerNearTests.length > 0
          ? { ownerNearTests: args.ownerNearTests }
          : {}),
        posture: {
          lspNav: args.posture.lspNav,
          primaryRail: args.posture.primaryRail,
          faultEvidence: args.posture.faultEvidence,
        },
        // T-OWN-12 activation: clean presets use rule-based AUTHORITATIVE owner
        // admission (public issue-named owners only), bypassing the additive
        // heuristic score/lead-gap. Structural static-witness evidence stays
        // advisory. Research mode passes false ⇒ legacy admission is byte-identical
        // (closure-session applies the clean rule only on `true`).
        ownerClean: args.posture.selectorMode === "clean",
      })

const resolveRepairState = (args: {
  readonly deps: RunInstanceDeps
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly closureSession: ClosureSessionState | undefined
}): Pick<
  PreparedAttemptContext,
  "effectiveRepair" | "repairGateEligible" | "gateDecisionVerify" | "runRepair"
> => {
  const effectiveRepair =
    args.deps.repair ??
    (args.posture.repairRounds !== undefined ? { maxRounds: args.posture.repairRounds } : undefined)
  const repairGateEligible = benchRunsRepairPhase(
    effectiveRepair !== undefined,
    args.instance.swebench !== undefined,
    args.posture.inLoopExecMode,
  )
  const gateDecisionVerify =
    repairGateEligible && args.closureSession?.bundle.gate.action === "verify"
  const runRepair =
    effectiveRepair !== undefined &&
    benchShouldRunRepairPhase({
      eligible: repairGateEligible,
      primaryRailEnabled: args.posture.primaryRail,
      gateAction: args.closureSession?.bundle.gate.action,
      primaryRailStep: args.closureSession?.primaryRailStep,
      verificationPlan: args.closureSession?.bundle.plan,
    })
  return { effectiveRepair, repairGateEligible, gateDecisionVerify, runRepair }
}

export const prepareAttemptContext = async (
  instance: Instance,
  sandbox: string,
  deps: RunInstanceDeps,
  signal: AbortSignal,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  /** T3 — forward-localize consumer files traced from the PRIOR adaptive
   *  candidate (deeper_localize route). Merged into the localized owner set as
   *  ADDITIONAL candidates for this pass. Absent ⇒ byte-identical (first pass /
   *  knob off). Never hard `requiredFiles` — only T1 static-edge validation can
   *  promote a site to a coverage requirement. */
  forwardLocalizeOwners?: readonly string[],
): Promise<PreparedAttemptContext> => {
  const state = stateOverride ?? resolveBenchKnobs({ envVars: process.env })
  const posture = postureOverride ?? benchPostureFromState(state, process.env)
  // The gold patch's targets are the files the task actually concerns ⇒ the
  // language to require grounding for. Absent (non-swebench) ⇒ undefined, and the
  // gate falls back to the whole-repo probe (historical behavior).
  const taskFiles = instance.goldPatch ? filesFromPatch(instance.goldPatch) : undefined
  const lspGrounding = await verifyStrictPresetLspGrounding(posture, sandbox, taskFiles, signal)
  const hintRepro = await prepareHintAndReproContext(instance, sandbox, deps.llm, posture)
  // T3 — forward-localize consumers enter as low-score ADDITIONAL owner candidates
  // (they widen the set; ranking still prefers backward-localized owners). score 0
  // keeps them below any positively-ranked stage-1 file. DEDUP against the stage-1
  // set so a consumer already backward-localized is not double-listed (which would
  // skew owner-coverage counts and waste a candidate-family slot).
  const stage1Localized = stage1FilesOf(hintRepro.localizeCandidates)
  // DEDUP by NORMALIZED path: stage1FilesOf keeps the raw localize-candidate paths
  // while forwardLocalizeOwners are already `normalizeRepoPath`'d, so a raw-vs-raw
  // Set compare silently never matches (audit R2). Normalize BOTH sides of the
  // membership test so a consumer already backward-localized is truly dropped.
  const stage1Seen = new Set(stage1Localized.map((entry) => normalizeRepoPath(entry.file)))
  const stage1Files = [
    ...stage1Localized,
    ...(forwardLocalizeOwners ?? [])
      .filter((file) => !stage1Seen.has(normalizeRepoPath(file)))
      .map((file) => ({ file, score: 0 })),
  ]
  const ownerResolved = await resolveOwnerResolved({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    sandbox,
    signal,
  })
  // SCAFF-03: digest typed-relation static witnesses into structural owner
  // candidate files. These stay advisory in clean owner admission; they seed
  // localization / repair evidence and owner-near test discovery, but they do
  // NOT by themselves admit a clean owner or mint required contracts.
  const witnessOwners =
    instance.swebench === undefined
      ? []
      : witnessStructuralOwnerCandidates(
          buildAstStaticWitnesses({
            problemStatement: instance.problemStatement,
            ownerCandidates: stage1Files.map((f) => f.file),
            ...(ownerResolved !== undefined ? { ownerResolved } : {}),
            readSource: (rel) => readSandboxSource(sandbox, rel),
          }),
        )
  // Structural fallback: even when no synthesized repro validated red, the
  // closure plan should still be able to name PUBLIC repo tests near the best
  // owner candidates. These commands guide verification / repair planning only;
  // final clean submit authority still comes from executed proof ports.
  const ownerCandidates = verificationOwnerCandidatesOf({
    witnessOwners,
    ownerResolved,
    stage1Files,
  })
  const ownerNearTests =
    instance.swebench === undefined ||
    !(hintRepro.posture.verificationPlan || hintRepro.posture.primaryRail)
      ? []
      : await discoverVerificationOwnerTests({
          instance,
          sandbox,
          timeoutMs: deps.timeoutMs,
          ownerCandidates,
        })
  // T2 — command-derived test paths take precedence; when empty, the extractor
  // falls back to a bounded convention-based source search over the localized
  // owner modules (only files that exist are read). Gated to the SAME condition
  // as `ownerNearTests` (swebench + verification-plan/primary-rail), so the
  // fallback never injects expectations into instances that have no closure plan.
  const existingTestExpectations =
    instance.swebench === undefined ||
    !(hintRepro.posture.verificationPlan || hintRepro.posture.primaryRail)
      ? []
      : await extractVerificationOwnerTestExpectations({
          sandbox,
          ownerNearTests,
          localizedOwnerFiles: ownerCandidates,
          issueSymbols: extractIssueHint(instance.problemStatement).symbols,
        })
  const closureSession = buildClosureAttemptState({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    ownerResolved,
    witnessOwners,
    reproTest: hintRepro.reproTest,
    ownerNearTests,
  })
  const intakeLlmEvidence = buildIntakeLlmEvidencePacket({
    problemStatement: instance.problemStatement,
    localizeCandidates: hintRepro.localizeCandidates,
    ...(closureSession?.bundle.evidence !== undefined
      ? { faultEvidence: closureSession.bundle.evidence }
      : {}),
    ...(closureSession?.bundle.plan !== undefined
      ? { verificationPlan: closureSession.bundle.plan }
      : {}),
    ...(hintRepro.reproTest !== undefined ? { reproTest: hintRepro.reproTest } : {}),
  })
  return {
    ...hintRepro,
    state,
    ownerResolved,
    closureSession,
    verificationPlan: closureSession?.bundle.plan,
    existingTestExpectations,
    primaryRailStep: closureSession?.primaryRailStep,
    closureHint: closureSession?.closureHint,
    intakeLlmEvidence,
    lspGrounding,
    ...resolveRepairState({
      deps,
      instance,
      posture: hintRepro.posture,
      closureSession,
    }),
  }
}

const runMainPhase = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly prepared: PreparedAttemptContext
}): Promise<Phase> => {
  if (args.prepared.posture.verifySelectN !== undefined && args.instance.swebench !== undefined) {
    const publicContracts = buildCleanSelectionAuthorityContracts({
      declaredExpected: args.prepared.closureSession?.issueDeclaredExpected,
      candidates: args.prepared.closureSession?.bundle.evidence.candidates,
      apiSymbols: args.prepared.closureSession?.bundle.evidence.issueSymbols,
    })
    return runSelectionPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.posture.verifySelectN,
      args.prepared.posture.verifySelectConcurrency,
      args.prepared.posture.verifySelectEarlyAccept,
      args.prepared.posture.verifySelectRiskGate,
      args.prepared.posture.verifySelectLlmRiskGate,
      args.prepared.posture.verifySelectCounterfactual,
      args.prepared.posture.selectorMode,
      args.prepared.posture.verifySelectProofRequired,
      publicContracts,
      args.prepared.posture.verifySelectRegression,
      args.prepared.posture.regressionMaxTests,
      args.prepared.posture.verifySelectRepro,
      args.prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ??
        args.prepared.localizeCandidates,
      args.prepared.ownerResolved,
      args.prepared.verificationPlan?.baseValidatedRed ?? false,
      args.prepared.verificationPlan,
      args.prepared.existingTestExpectations,
      args.prepared.reproTest,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.reproSources,
      args.prepared.hardeningReproSources,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaMultisiteSteer,
      args.prepared.chaRepairTargets,
    )
  }
  if (args.prepared.runRepair && args.prepared.effectiveRepair !== undefined) {
    return runRepairPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.effectiveRepair,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.primaryRailStep,
      args.prepared.ownerResolved?.map((o) => o.file) ?? [],
      args.prepared.reproSources,
      verificationTargetFromPlan(args.prepared.verificationPlan),
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaMultisiteSteer,
    )
  }
  return runAgentPhase(
    args.instance,
    args.deps,
    args.sandbox,
    args.signal,
    args.wiring,
    args.prepared.precomputedHint,
    args.prepared.reproHint,
    args.prepared.closureHint,
    args.prepared.posture,
    args.prepared.state,
    args.prepared.chaMultisiteSteer,
  )
}

export const maybeValidateTerminalResult = async (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
  readonly signal: AbortSignal
  readonly prepared: PreparedAttemptContext
  readonly sandbox: string
}): Promise<InstanceResult | undefined> => {
  const terminal = terminalAgentResult(args)
  if (terminal === undefined) return undefined
  let result = terminal
  if (shouldValidateGold(args.deps, false)) {
    const gold = await validateGoldPatch(args.instance, { ...args.deps, signal: args.signal })
    if (!gold.ok) {
      const { error: _prevError, ...rest } = result
      result = { ...rest, passed: false, verdict: "grader_invalid", error: gold.error }
    }
  }
  const extra: Partial<InstanceResult> = {}
  attachLateFailureArtifacts({
    extra,
    instance: args.instance,
    sandbox: args.sandbox,
    phase: args.phase,
    prepared: args.prepared,
  })
  return { ...result, ...extra }
}

const V5_ADAPTIVE_PRESET = "agentless-v5-thin-and-expanded"

const v5AdaptiveEnabledForState = (state: BenchKnobState, envVars: NodeJS.ProcessEnv): boolean =>
  state.preset === V5_ADAPTIVE_PRESET && gateOn(envVars, "QUANTA_BENCH_V5_ADAPTIVE")

const dedupeProofReceipts = (
  receipts: readonly ProofReceiptFact[],
): readonly ProofReceiptFact[] => [
  ...new Map(
    receipts.map((receipt) => [
      `${receipt.source}:${receipt.state}:${receipt.command ?? ""}`,
      receipt,
    ]),
  ).values(),
]

const candidateEditSurfaceFromPatch = (patch: string): CandidateEditSurfaceFact | undefined => {
  if (patch.trim() === "") return undefined
  const touchedFiles = filesFromUnifiedDiff(patch)
  const touchedSymbols = diffTouchedSymbols(patch)
  if (touchedFiles.length === 0 && touchedSymbols.length === 0) return undefined
  return { touchedFiles, touchedSymbols }
}

const adaptiveStaticWitnessEvidence = (args: {
  readonly problemStatement: string
  readonly ownerFiles: readonly string[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly sandbox: string
}) => {
  const input = {
    problemStatement: args.problemStatement,
    ownerCandidates: args.ownerFiles,
    ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
    readSource: (rel: string) => readSandboxSource(args.sandbox, rel),
  }
  return {
    staticWitnesses: buildAstStaticWitnesses(input),
    staticWitnessDiagnostics: staticWitnessLanguageDiagnostics(input),
  }
}

const adaptiveBaseReproReceipts = (
  reproTest: BenchReproTestTelemetry | undefined,
): readonly ProofReceiptFact[] => {
  if (reproTest === undefined) return []
  if (reproTest.installed) {
    return [
      {
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: reproTest.reproducedCount > 0 ? "base_red" : "base_green",
        command: reproTest.path,
        baseValidatedRed: reproTest.reproducedCount > 0,
      },
    ]
  }
  const infraReason =
    reproTest.reason === "not_installed" || reproTest.reason === "write_failed"
      ? "env_prep_failed"
      : "execution_failed"
  return [{ source: "public_mwe", sourcePolicy: "public_repro", state: infraReason }]
}

const adaptiveSelectionProofReceipts = (
  proofSummary: Phase["selectionTelemetry"] extends infer T
    ? T extends { proofSummary?: infer S }
      ? S | undefined
      : never
    : never,
): readonly ProofReceiptFact[] => {
  if (proofSummary === undefined) return []
  const receipts: ProofReceiptFact[] = []
  switch (proofSummary.publicMweState) {
    case "base_red":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "base_red",
        baseValidatedRed: true,
      })
      break
    case "base_not_red":
      receipts.push({ source: "public_mwe", sourcePolicy: "public_repro", state: "base_green" })
      break
    case "patched_green":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "candidate_green",
        baseValidatedRed: true,
      })
      break
    case "candidate_red":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "candidate_red",
        baseValidatedRed: true,
      })
      break
    case "execution_failed":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "execution_failed",
      })
      break
  }
  switch (proofSummary.publicRegressionState) {
    case "safety_green":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "candidate_green",
      })
      break
    case "candidate_red":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "candidate_red",
      })
      break
    case "execution_failed":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "execution_failed",
      })
      break
    case "coverage_capped":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "static_only",
      })
      break
  }
  switch (proofSummary.reproConsensusState) {
    case "base_red_candidate_green":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "candidate_green",
        baseValidatedRed: true,
      })
      break
    case "base_red_candidate_red":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "candidate_red",
        baseValidatedRed: true,
      })
      break
    case "execution_failed":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "execution_failed",
      })
      break
    case "false_negative_suspected":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "static_only",
        baseValidatedRed: true,
      })
      break
  }
  // B5 — surface the executed module-smoke (public issue-smoke) HARD-gate RESULT
  // as a proof receipt the model/router sees. RESULT ONLY: `ownerTestResultReceipt`
  // builds it with `cmdWithheld:true` and never carries the command/selector
  // (C3 anti-gaming fence). Absent ⇒ the smoke gate did not run (FAIL-OPEN).
  if (proofSummary.moduleSmokeState !== undefined) {
    receipts.push(
      ownerTestResultReceipt({
        kind: "module_smoke",
        result: proofSummary.moduleSmokeState,
      }),
    )
  }
  return receipts
}

/**
 * A10 — the closed ROUTING action menu the router prompt enumerates. Passed into
 * {@link toPhaseRoutingContract} so the router-input packet's `allowedActions`
 * MATCH the router instruction's `ADAPTIVE_ACTIONS` (one coherent action menu),
 * instead of the source packet's stale "explain_*" / post-review actions.
 */
const ROUTING_ACTION_MENU: readonly string[] = [...ADAPTIVE_ACTIONS]

/**
 * Build the evidence packet the adaptive PHASE ROUTER sees for this phase. The
 * evidence BODY is the selection-explanation packet (when selection telemetry
 * exists) or a post-exec review packet (thin path); EITHER way the consumer is
 * the router asking "choose the next phase", so the packet is re-contracted via
 * {@link toPhaseRoutingContract} (A10): the model sees `stage:"phase_routing"`,
 * a phase-decision question, and the closed routing action menu — never the
 * stale "explain_*" / post-review contract. Only the stage/question/action menu
 * change; all evidence is preserved and re-blindness-checked. The report keeps
 * using the honest `selection_explanation`/`candidate_post_review` packet built
 * separately in `attachLlmEvidenceArtifacts`.
 */
export const buildAdaptivePhasePacket = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
  readonly sandbox: string
}): LlmEvidencePacket =>
  toPhaseRoutingContract(buildAdaptivePhaseEvidence(args), ROUTING_ACTION_MENU)

type AdaptivePhaseEvidenceArgs = {
  readonly instance: Instance
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
  readonly sandbox: string
}

const adaptiveOwnerFilesOf = (args: AdaptivePhaseEvidenceArgs): readonly string[] =>
  args.phase.selectionTelemetry?.ownerFiles ??
  cleanUniqueList([
    ...(args.prepared.closureSession?.bundle.evidence.candidates.map(
      (candidate) => candidate.file,
    ) ?? []),
    ...(args.prepared.ownerResolved?.map((owner) => owner.file) ?? []),
    ...args.prepared.localizeCandidates,
  ])

const buildAdaptiveSelectionEvidence = (args: {
  readonly problemStatement: string
  readonly telemetry: SelectionTelemetry
  readonly ownerFiles: readonly string[]
  readonly proofSummary: Parameters<typeof adaptiveSelectionProofReceipts>[0]
  readonly staticWitnessDiagnostics: readonly StaticWitnessDiagnostic[]
}): LlmEvidencePacket =>
  buildSelectionExplanationPacket({
    problemStatement: args.problemStatement,
    ownerFiles: args.ownerFiles,
    winnerId: args.telemetry.winnerId,
    ...(args.telemetry.noWinnerReason !== undefined
      ? { noWinnerReason: args.telemetry.noWinnerReason }
      : {}),
    ...(args.telemetry.proofRequired === true ? { proofRequired: true } : {}),
    ...(args.proofSummary !== undefined ? { proofSummary: args.proofSummary } : {}),
    candidates: args.telemetry.candidates,
    ...(args.staticWitnessDiagnostics.length > 0
      ? { staticWitnessDiagnostics: args.staticWitnessDiagnostics }
      : {}),
  })

const adaptiveMissingEvidenceOf = (args: {
  readonly phase: Phase
  readonly proofSummary: Parameters<typeof adaptiveSelectionProofReceipts>[0]
  readonly receipts: readonly ProofReceiptFact[]
}): readonly MissingEvidenceFact[] => {
  const missingEvidence: MissingEvidenceFact[] = []
  if (!args.receipts.some((receipt) => receipt.state === "candidate_green")) {
    missingEvidence.push({
      kind: "executed_public_proof",
      reason:
        args.proofSummary?.proofState === "infra_blocked"
          ? "public_proof_infra_blocked"
          : "no_positive_executed_public_proof",
    })
  }
  if (args.phase.stopReason === "error" && args.phase.agentError !== undefined) {
    missingEvidence.push({
      kind: "phase_error",
      reason: args.phase.agentError.slice(0, 240),
    })
  }
  return missingEvidence
}

const buildAdaptiveCandidatePostReviewEvidence = (args: {
  readonly phaseArgs: AdaptivePhaseEvidenceArgs
  readonly ownerFiles: readonly string[]
  readonly staticWitnesses: ReturnType<typeof adaptiveStaticWitnessEvidence>["staticWitnesses"]
  readonly staticWitnessDiagnostics: readonly StaticWitnessDiagnostic[]
  readonly proofSummary: Parameters<typeof adaptiveSelectionProofReceipts>[0]
}): LlmEvidencePacket => {
  const ownerEvidence = buildSelectionOwnerEvidence({
    ownerFiles: args.ownerFiles,
    issueSymbols: extractIssueHint(args.phaseArgs.instance.problemStatement).symbols,
    staticWitnesses: args.staticWitnesses,
    readSource: (rel) => readSandboxSource(args.phaseArgs.sandbox, rel),
  })
  const verificationTarget = verificationTargetFromPlan(args.phaseArgs.prepared.verificationPlan)
  const receipts = dedupeProofReceipts([
    ...adaptiveBaseReproReceipts(args.phaseArgs.prepared.reproTest),
    ...adaptiveSelectionProofReceipts(args.proofSummary),
  ])
  const missingEvidence = adaptiveMissingEvidenceOf({
    phase: args.phaseArgs.phase,
    proofSummary: args.proofSummary,
    receipts,
  })
  const candidateEditSurface = candidateEditSurfaceFromPatch(args.phaseArgs.phase.patch)
  return buildCandidatePostReviewLlmEvidencePacket({
    problemStatement: args.phaseArgs.instance.problemStatement,
    candidatePatchHash: candidatePatchHash(args.phaseArgs.phase.patch),
    ownerEvidence,
    proofReceipts: receipts,
    contracts: [],
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    ...(candidateEditSurface !== undefined ? { candidateEditSurface } : {}),
    ...(args.staticWitnessDiagnostics.length > 0
      ? { staticWitnessDiagnostics: args.staticWitnessDiagnostics }
      : {}),
    ...(missingEvidence.length > 0 ? { missingEvidence } : {}),
  })
}

/** The evidence BODY for the router packet, before the A10 routing re-contract
 *  ({@link buildAdaptivePhasePacket} applies the contract). Kept separate so the
 *  evidence assembly is unit-testable independent of the stage rewrite. */
const buildAdaptivePhaseEvidence = (args: AdaptivePhaseEvidenceArgs): LlmEvidencePacket => {
  const proofSummary = args.phase.selectionTelemetry?.proofSummary
  const ownerFiles = adaptiveOwnerFilesOf(args)
  const { staticWitnesses, staticWitnessDiagnostics } = adaptiveStaticWitnessEvidence({
    problemStatement: args.instance.problemStatement,
    ownerFiles,
    ownerResolved: args.prepared.ownerResolved,
    sandbox: args.sandbox,
  })
  if (args.phase.selectionTelemetry !== undefined) {
    return buildAdaptiveSelectionEvidence({
      problemStatement: args.instance.problemStatement,
      telemetry: args.phase.selectionTelemetry,
      ownerFiles,
      proofSummary,
      staticWitnessDiagnostics,
    })
  }
  return buildAdaptiveCandidatePostReviewEvidence({
    phaseArgs: args,
    ownerFiles,
    staticWitnesses,
    staticWitnessDiagnostics,
    proofSummary,
  })
}

const adaptiveRouteTelemetryOf = (
  run: Awaited<ReturnType<typeof runAdaptiveBenchAttempt>>,
  evidenceRevisions: readonly string[],
): NonNullable<InstanceResult["adaptiveRoute"]> => ({
  outcome: run.outcome,
  steps: run.steps,
  evidenceRevisions,
  ...(run.reason !== undefined ? { reason: String(run.reason) } : {}),
  ...(run.finalDecision !== undefined
    ? {
        finalAction: run.finalDecision.action,
        finalWhy: run.finalDecision.why,
        citedEvidenceIds: run.finalDecision.citedEvidenceIds,
      }
    : {}),
})

// jun-21 — REMOVED `maybeStrictBudgetBlockedResult` (the strict patch-budget
// TERMINAL-DISCARD). It violated the patch-budget contract: an over-budget
// verdict is SOFT — the module header (@/agent/patch-budget) says "never a hard
// reject", `verdict.escalate` marks it for the late critic/verify path, and
// `runtimeExpandingCalls` is explicitly OBSERVE-ONLY. Discarding the agent's
// real patch and returning an empty one (a) KILLED legitimate fixes that need a
// new helper/method — measured: pytest-dev__pytest-5787 went over-budget on
// new-def across ALL THREE selector arms and was zeroed every time — and (b)
// turned a potential win / real miss into a "gate-block" black hole that
// corrupts the failure taxonomy (a model can't be judged on a patch we threw
// away). The over-budget verdict is STILL recorded as telemetry on the graded
// result (`extra.patchBudget`, see the buildPhasePatchBudget block downstream);
// the patch now flows to grading — escalate, do not discard.

const validateVerifiedOutcome = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly signal: AbortSignal
  readonly verified: Awaited<ReturnType<typeof verify>>
}): Promise<{
  readonly verified: Awaited<ReturnType<typeof verify>>
  readonly graderInvalid: boolean
}> => {
  if (!shouldValidateGold(args.deps, args.verified.passed)) {
    return { verified: args.verified, graderInvalid: false }
  }
  const gold = await validateGoldPatch(args.instance, { ...args.deps, signal: args.signal })
  if (gold.ok) return { verified: args.verified, graderInvalid: false }
  const { error: _prevError, ...rest } = args.verified
  return {
    verified: { ...rest, passed: false, error: gold.error },
    graderInvalid: true,
  }
}

const attachObservedSuccessBasics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly deps: RunInstanceDeps
  readonly instance: Instance
  readonly wiring: Wiring
  readonly phase: Phase
  readonly verified: Awaited<ReturnType<typeof verify>>
  readonly startedAt: number
}): void => {
  if (!(args.deps.observe && args.wiring.observer)) return
  args.extra.verdict ??= "ok"
  args.extra.durationMs = Date.now() - args.startedAt
  args.extra.patchPath = emitPatch(
    args.deps.observe,
    args.instance,
    args.wiring.observer,
    args.phase.patch,
  )
  emitVerify(args.wiring.observer, args.verified)
  const usage = args.wiring.usage?.total()
  if (usage) args.extra.usage = usage
  if (args.phase.firstEditFile !== undefined) args.extra.firstEditFile = args.phase.firstEditFile
  if (args.phase.editCount !== undefined) args.extra.editCount = args.phase.editCount
  if (args.phase.turnsToFirstEdit !== undefined)
    args.extra.turnsToFirstEdit = args.phase.turnsToFirstEdit
}

const attachLspClosureMetric = (
  extra: Partial<InstanceResult>,
  lspGrounding: LspGroundingReceipt | undefined,
): void => {
  if (lspGrounding === undefined) return
  const status = foldGroundingReceipts([lspGrounding])
  if (status !== undefined) extra.lspGrounding = status
}

const attachPrimaryRailMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  if (!(args.prepared.posture.verificationPlan || args.prepared.posture.primaryRail)) return
  args.extra.primaryRailPresent = args.prepared.primaryRailStep !== undefined
  args.extra.requiredVerificationCovered =
    args.prepared.verificationPlan?.required.some((s) => s.successPredicate !== undefined) ?? false
  if (args.prepared.verificationPlan !== undefined)
    args.extra.synthReproBaseRed = args.prepared.verificationPlan.baseValidatedRed
  if (args.prepared.primaryRailStep !== undefined && args.phase.primaryFalseGreen !== undefined) {
    args.extra.primaryFalseGreen = args.phase.primaryFalseGreen
  }
  if (args.prepared.primaryRailStep !== undefined && args.phase.primaryFalseRed !== undefined) {
    args.extra.primaryFalseRed = args.phase.primaryFalseRed
  }
}

const attachRepairGateMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  if (!args.prepared.repairGateEligible) return
  args.extra.gateEntered = args.prepared.gateDecisionVerify
  args.extra.gateBypassed = !args.prepared.gateDecisionVerify
  if (args.phase.verifyRounds !== undefined) args.extra.verifyRounds = args.phase.verifyRounds
}

const attachClosureMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  // LSP-02: carry the strict gate's typed grounding receipt into the report as a
  // folded status so the report/CLI render the SAME outcome the gate proved.
  attachLspClosureMetric(args.extra, args.prepared.lspGrounding)
  attachPrimaryRailMetrics(args)
  attachRepairGateMetrics(args)
}

const attachLlmEvidenceArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  const selectionExplanation =
    args.phase.selectionTelemetry === undefined
      ? undefined
      : buildSelectionExplanationPacket({
          problemStatement: args.instance.problemStatement,
          ownerFiles: args.phase.selectionTelemetry.ownerFiles,
          winnerId: args.phase.selectionTelemetry.winnerId,
          ...(args.phase.selectionTelemetry.noWinnerReason !== undefined
            ? { noWinnerReason: args.phase.selectionTelemetry.noWinnerReason }
            : {}),
          ...(args.phase.selectionTelemetry.proofRequired === true ? { proofRequired: true } : {}),
          ...(args.phase.selectionTelemetry.proofSummary !== undefined
            ? { proofSummary: args.phase.selectionTelemetry.proofSummary }
            : {}),
          candidates: args.phase.selectionTelemetry.candidates,
        })
  const llmEvidence: LlmEvidenceArtifacts = {
    intake: args.prepared.intakeLlmEvidence,
    ...(args.phase.llmEvidence ?? {}),
    ...(selectionExplanation !== undefined ? { selectionExplanation } : {}),
  }
  if (Object.keys(llmEvidence).length > 0) args.extra.llmEvidence = llmEvidence
}

const attachSelectionAndClosureArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  const { posture, verificationPlan, closureSession, primaryRailStep, ownerResolved } =
    args.prepared
  if (args.phase.reproOracleCalibration !== undefined) {
    args.extra.reproOracleCalibration = args.phase.reproOracleCalibration
  }
  if (args.phase.selectionTelemetry !== undefined) {
    args.extra.selectionTelemetry = args.phase.selectionTelemetry
  }
  if (args.phase.ownerWidening !== undefined) {
    args.extra.ownerWidening = args.phase.ownerWidening
  }
  attachLlmEvidenceArtifacts(args)
  const ownerHint = relFromSandbox(args.sandbox, args.phase.firstEditFile)
  const hygiene =
    args.instance.swebench !== undefined
      ? buildPhasePatchHygiene(args.phase.patch, ownerHint)
      : undefined
  if (posture.patchHygiene && hygiene !== undefined) {
    args.extra.patchHygiene = hygiene
    args.extra.outOfScopeFiles = hygiene.filesOutsideOwner.length > 0
  }
  if ((posture.patchBudget || posture.patchBudgetStrict) && args.instance.swebench !== undefined) {
    args.extra.patchBudget = buildPhasePatchBudget({
      patch: args.phase.patch,
      repo: args.instance.swebench.repo,
      closureSession,
      strict: posture.patchBudgetStrict,
    })
  }
  if (posture.verificationPlan && verificationPlan !== undefined) {
    args.extra.verificationPlan = verificationPlan
  }
  if (posture.faultEvidence && closureSession !== undefined) {
    args.extra.faultEvidence = closureSession.bundle.evidence
    args.extra.ownerAdmission = closureSession.bundle.owner
  }
  if (posture.repairEscalation && closureSession !== undefined) {
    // Telemetry attachment only AT THIS LATE SITE: the same decision helper now
    // also feeds the adaptive reroute seam (`adaptiveRepairEscalationOwners`)
    // before the next `prepareAttemptContext`, but assigning it to `args.extra`
    // here remains report-only because the phase has already finished.
    const repairEscalation = adaptiveRepairEscalationDecision({
      prepared: {
        posture,
        closureSession,
        ownerResolved,
        primaryRailStep,
      },
      phase: args.phase,
    })
    if (repairEscalation !== undefined) args.extra.repairEscalation = repairEscalation
  }
}

const attachLateFailureArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  attachClosureMetrics({ extra: args.extra, phase: args.phase, prepared: args.prepared })
  attachSelectionAndClosureArtifacts({
    extra: args.extra,
    instance: args.instance,
    sandbox: args.sandbox,
    phase: args.phase,
    prepared: args.prepared,
  })
}

export const latePhaseFailureResultOf = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly error: string
  readonly verdict?: InstanceResult["verdict"]
  readonly prepared?: PreparedAttemptContext
  readonly sandbox?: string
}): InstanceResult => {
  const extra: Partial<InstanceResult> = {
    ...reproResultExtra(args.reproTest),
    ...(args.phase.stopReason !== undefined ? { stopReason: args.phase.stopReason } : {}),
    ...(args.phase.firstEditFile !== undefined ? { firstEditFile: args.phase.firstEditFile } : {}),
    ...(args.phase.editCount !== undefined ? { editCount: args.phase.editCount } : {}),
    ...(args.phase.turnsToFirstEdit !== undefined
      ? { turnsToFirstEdit: args.phase.turnsToFirstEdit }
      : {}),
    ...(args.phase.primaryFalseGreen !== undefined
      ? { primaryFalseGreen: args.phase.primaryFalseGreen }
      : {}),
    ...(args.phase.primaryFalseRed !== undefined
      ? { primaryFalseRed: args.phase.primaryFalseRed }
      : {}),
    ...(args.phase.verifyRounds !== undefined ? { verifyRounds: args.phase.verifyRounds } : {}),
    ...(args.phase.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: args.phase.reproOracleCalibration }
      : {}),
    ...(args.phase.selectionTelemetry !== undefined
      ? { selectionTelemetry: args.phase.selectionTelemetry }
      : {}),
  }
  if (args.prepared !== undefined && args.sandbox !== undefined) {
    attachLateFailureArtifacts({
      extra,
      instance: args.instance,
      sandbox: args.sandbox,
      phase: args.phase,
      prepared: args.prepared,
    })
  }
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...extra,
    ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
    error: args.error,
  }
}

const latePhaseFailureResultFromError = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly error: unknown
  readonly prepared: PreparedAttemptContext | undefined
  readonly sandbox: string
}): InstanceResult => {
  if (args.error instanceof ObservationError) {
    return latePhaseFailureResultOf({
      instance: args.instance,
      phase: args.phase,
      reproTest: args.reproTest,
      verdict: "degraded",
      error: `observation failed (strict): ${args.error.message}`,
      ...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {}),
    })
  }
  if (args.error instanceof StrictLspGroundingDegradedError) {
    const result = latePhaseFailureResultOf({
      instance: args.instance,
      phase: args.phase,
      reproTest: args.reproTest,
      verdict: "degraded",
      error: args.error.message,
      ...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {}),
    })
    // The gate threw before a PreparedAttemptContext existed, so attach the typed
    // status directly from the receipt (LSP-02) — the degraded report row still
    // carries the launch/ready outcome enum, not just the error string.
    const status =
      args.error.receipt !== undefined ? foldGroundingReceipts([args.error.receipt]) : undefined
    return status !== undefined ? { ...result, lspGrounding: status } : result
  }
  return latePhaseFailureResultOf({
    instance: args.instance,
    phase: args.phase,
    reproTest: args.reproTest,
    error: errMessage(args.error),
    ...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {}),
  })
}

const buildSuccessfulResultExtra = (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly verified: Awaited<ReturnType<typeof verify>>
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
  readonly prepared: PreparedAttemptContext
  readonly graderInvalid: boolean
}): Partial<InstanceResult> => {
  const extra: Partial<InstanceResult> = reproResultExtra(args.reproTest)
  if (args.graderInvalid) extra.verdict = "grader_invalid"
  attachObservedSuccessBasics({ ...args, extra })
  attachClosureMetrics({ extra, phase: args.phase, prepared: args.prepared })
  attachSelectionAndClosureArtifacts({
    extra,
    instance: args.instance,
    sandbox: args.sandbox,
    phase: args.phase,
    prepared: args.prepared,
  })
  if (args.verified.breakdown !== undefined) extra.gradeBreakdown = args.verified.breakdown
  if (args.verified.passed) {
    const scoreEvidence: ReceiptEvidence = {
      officialHarnessResolved:
        args.instance.swebench !== undefined &&
        args.deps.pythonSwebench?.evaluate !== undefined &&
        args.graderInvalid === false,
      localExecutedGreen: true,
      researchKnobTouched: researchKnobTouched(args.prepared.posture),
    }
    extra.scoreEvidence = scoreEvidence
    extra.scoreLabel = labelForReceipt(scoreEvidence)
  }
  return extra
}

export const verifyAndFinalizeResult = async (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly wiring: Wiring
  readonly startedAt: number
  readonly prepared: PreparedAttemptContext
}): Promise<InstanceResult> => {
  const verified = await verify(args.instance, args.phase.patch, args.sandbox, {
    ...args.deps,
    signal: args.signal,
  })
  const validated = await validateVerifiedOutcome({
    instance: args.instance,
    deps: args.deps,
    signal: args.signal,
    verified,
  })
  const extra = buildSuccessfulResultExtra({
    ...args,
    verified: validated.verified,
    graderInvalid: validated.graderInvalid,
  })
  return okResult(args.instance, args.phase, validated.verified, extra)
}

/**
 * Run one instance once: sandbox → (setup) → agent → verify → diff. Always
 * cleans up the temp dir. Never throws for an instance-level failure — it is
 * reported via `InstanceResult.error` with passed=false.
 *
 * Observability (RFC §8) is a pure add-on gated on `deps.observe`: absent ⇒
 * `NullStream`, byte-identical to before (no files written). Present ⇒ the
 * agent stream is Tee'd into a strict `JsonlRecorder` plus bench `sandbox`/
 * `patch_generated`/`verify` lines; a strict observation failure yields
 * `verdict:"degraded"` (excluded from `resolved/total`).
 *
 * Internal — `runInstance` (below) wraps this with the measurement-stability
 * retry loop. Exported as `runInstanceOnce` so tests can pin the single-pass
 * path independently of the retry wrapper.
 */
// A1: the adaptive-router model call is constructed from the attempt's LLM port
// + the live env/abort signal. Hoisted to a module-level helper so
// `runInstanceOnce` stays under the god-FUNCTION ceiling — behavior identical.
const buildRouterModelCall = (deps: RunInstanceDeps, signal: AbortSignal) =>
  buildAdaptiveRouterModelCall({
    basePort: deps.llm,
    env: process.env,
    signal,
  })

/**
 * v5 adaptive attempt branch, hoisted out of `runInstanceOnce` so the
 * orchestrator body stays under the god-FUNCTION ceiling. Behavior is identical
 * to the inline branch: ONE thin main phase, then a router-driven decompose
 * loop that re-prepares + re-runs the main phase per posture, then terminal /
 * verify finalization — every exit stamps `adaptiveRoute`. The caller's
 * `phase`/`prepared` closure vars were only assigned here for parity with the
 * non-adaptive path's `finally`-time cleanup reads; the downstream helpers take
 * explicit args, so capturing the finals locally is equivalent.
 */
const runV5AdaptiveAttempt = async (args: {
  instance: Instance
  deps: RunInstanceDeps
  sandbox: string
  signal: AbortSignal
  wiring: Wiring
  prepared: PreparedAttemptContext
  reproTest: BenchReproTestTelemetry | undefined
  startedAt: number
  // Mirrors the inline branch's `phase = finalPhase; prepared = finalPrepared`
  // BEFORE terminal/verify, so the caller's catch/finally observe the finals if
  // those steps throw — byte-identical to the pre-extraction control flow.
  onFinals: (phase: Phase, prepared: PreparedAttemptContext) => void
}): Promise<InstanceResult> => {
  const { instance, deps, sandbox, signal, wiring: w, reproTest, startedAt } = args
  const preparedContext = args.prepared
  const thinPhase = await runMainPhase({
    instance,
    deps,
    sandbox,
    signal,
    wiring: w,
    prepared: preparedContext,
  })
  let finalPrepared = preparedContext
  let finalPhase = thinPhase
  const revisions: string[] = []
  const initialPacket = buildAdaptivePhasePacket({
    instance,
    phase: thinPhase,
    prepared: preparedContext,
    sandbox,
  })
  revisions.push(initialPacket.evidenceRevision)
  const adaptive = await runAdaptiveBenchAttempt({
    intakePacket: initialPacket,
    base: preparedContext.state,
    env: process.env,
    modelCall: buildRouterModelCall(deps, signal),
    runPhase: async ({ state, posture }) => {
      const widening = await adaptiveNextPassOwners({
        prepared: finalPrepared,
        phase: finalPhase,
        forwardLocalize: posture.forwardLocalize,
        sandbox,
        timeoutMs: deps.timeoutMs,
      })
      const nextPrepared = await prepareAttemptContext(
        instance,
        sandbox,
        deps,
        signal,
        posture,
        state,
        widening.owners,
      )
      const nextPhase = await runMainPhase({
        instance,
        deps,
        sandbox,
        signal,
        wiring: w,
        prepared: nextPrepared,
      })
      if (widening.telemetry !== undefined) nextPhase.ownerWidening = widening.telemetry
      finalPrepared = nextPrepared
      finalPhase = nextPhase
      const packet = buildAdaptivePhasePacket({
        instance,
        phase: nextPhase,
        prepared: nextPrepared,
        sandbox,
      })
      revisions.push(packet.evidenceRevision)
      return { packet }
    },
  })
  const adaptiveRoute = adaptiveRouteTelemetryOf(adaptive, revisions)
  if (adaptive.outcome !== "finalize") {
    return {
      ...latePhaseFailureResultOf({
        instance,
        phase: finalPhase,
        reproTest,
        error: `adaptive controller stopped: ${String(adaptive.reason ?? adaptive.outcome)}`,
        prepared: finalPrepared,
        sandbox,
      }),
      adaptiveRoute,
    }
  }
  args.onFinals(finalPhase, finalPrepared)
  const terminal = await maybeValidateTerminalResult({
    instance,
    phase: finalPhase,
    reproTest,
    deps,
    wiring: w,
    startedAt,
    signal,
    prepared: finalPrepared,
    sandbox,
  })
  if (terminal !== undefined) return { ...terminal, adaptiveRoute }
  return {
    ...(await verifyAndFinalizeResult({
      instance,
      phase: finalPhase,
      deps,
      sandbox,
      signal,
      reproTest,
      wiring: w,
      startedAt,
      prepared: finalPrepared,
    })),
    adaptiveRoute,
  }
}

/**
 * A5 — drain the per-instance repro-vote outcome sink and attach the typed
 * telemetry to the result. Drained EXACTLY ONCE per instance (the drain is
 * consuming), so a later read can never double-count. Returns the result
 * unchanged when no vote round was recorded (knob off / no reproducing set) so
 * the report stays byte-identical. The sink is RESET at instance start (see
 * `runInstanceOnce`), guaranteeing no cross-instance accumulation.
 */
export const attachReproVoteOutcomes = (result: InstanceResult): InstanceResult => {
  const summary = summarizeReproVoteOutcomes(drainReproVoteOutcomes())
  return summary === undefined ? result : { ...result, reproVoteOutcomes: summary }
}

/** A5 — reset the per-instance repro-vote sink at instance START. Re-exported so
 *  the apps/bench driver resets the SAME module sink (one SSOT) before its run,
 *  preventing cross-instance accumulation on either driver. */
export { resetReproVoteOutcomes } from "./repair/repro-vote"

export const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  // A5: reset the repro-vote sink at instance START so vote outcomes recorded by
  // the validator during THIS instance's repair/selection rounds cannot leak
  // into the next instance's telemetry (the audit's cross-instance accumulation
  // risk). Drained per result via `attachReproVoteOutcomes`.
  resetReproVoteOutcomes()
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  let deadline: ReturnType<typeof setTimeout> | undefined
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  let reproTest: BenchReproTestTelemetry | undefined
  let prepared: PreparedAttemptContext | undefined
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)
    const prep = await runEnvPrep(instance, sandbox, deps.timeoutMs)
    if (!prep.ok) return envPrepFailedResult(instance, prep)
    if (instance.swebench?.repo !== undefined) {
      await materializeBuildEnv(sandbox, instance.swebench.repo)
    }
    prepared = await prepareAttemptContext(instance, sandbox, deps, abort.signal)
    const preparedContext = prepared
    reproTest = preparedContext.reproTest
    deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
    if (v5AdaptiveEnabledForState(preparedContext.state, process.env)) {
      return attachReproVoteOutcomes(
        await runV5AdaptiveAttempt({
          instance,
          deps,
          sandbox,
          signal: abort.signal,
          wiring: w,
          prepared: preparedContext,
          reproTest,
          startedAt,
          onFinals: (p, pr) => {
            phase = p
            prepared = pr
          },
        }),
      )
    }
    phase = await runMainPhase({
      instance,
      deps,
      sandbox,
      signal: abort.signal,
      wiring: w,
      prepared: preparedContext,
    })
    const followup = await maybeRunRepairEscalationFollowup({
      instance,
      deps,
      sandbox,
      signal: abort.signal,
      prepared: preparedContext,
      phase,
      runPhase: (nextPrepared) =>
        runMainPhase({
          instance,
          deps,
          sandbox,
          signal: abort.signal,
          wiring: w,
          prepared: nextPrepared,
        }),
    })
    phase = followup.phase
    prepared = followup.prepared
    if (prepared.reproTest !== undefined) reproTest = prepared.reproTest
    if (followup.telemetry !== undefined) phase.ownerWidening = followup.telemetry
    const terminal = await maybeValidateTerminalResult({
      instance,
      phase,
      reproTest,
      deps,
      wiring: w,
      startedAt,
      signal: abort.signal,
      prepared,
      sandbox,
    })
    if (terminal !== undefined) return attachReproVoteOutcomes(terminal)
    // NOTE (jun-21): no strict patch-budget terminal-discard here anymore — an
    // over-budget patch ESCALATES to grading (telemetry recorded on the result),
    // never a hard reject. See the removal note above the old fn site.
    // Await inside the try so sandbox cleanup in `finally` cannot race the
    // final verifier. A bare `return promise` here would run `finally`
    // immediately and tear down the sandbox while verify is still spawning.
    return attachReproVoteOutcomes(
      await verifyAndFinalizeResult({
        instance,
        phase,
        deps,
        sandbox,
        signal: abort.signal,
        reproTest,
        wiring: w,
        startedAt,
        prepared,
      }),
    )
  } catch (e) {
    return attachReproVoteOutcomes(
      latePhaseFailureResultFromError({
        instance,
        phase,
        reproTest,
        error: e,
        prepared,
        sandbox,
      }),
    )
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
    w.observer?.close()
    await cleanupSandbox(sandbox)
  }
}

/** Project `AttemptOutcome` (the retry-policy enum) into `BenchAttemptOutcome`
 *  (the wire shape on `InstanceResult.budget`). Same union, mirrored here so
 *  the bench-types module doesn't have to depend on `retry-policy.ts`.
 *  Exported so the apps/bench driver's retry wrapper stamps an identical shape. */
export const projectOutcome = (o: AttemptOutcome): BenchAttemptOutcome => {
  if (o.kind === "pass") return { kind: "pass" }
  if (o.kind === "empty-patch") {
    return o.reason !== undefined
      ? { kind: "empty-patch", reason: o.reason }
      : { kind: "empty-patch" }
  }
  if (o.kind === "admission-blocked") {
    return { kind: "admission-blocked", source: o.source, reason: o.reason }
  }
  if (o.kind === "generation-fail") return { kind: "generation-fail", reason: o.reason }
  if (o.kind === "grader-invalid") return { kind: "grader-invalid", reason: o.reason }
  if (o.kind === "timeout") return { kind: "timeout" }
  if (o.kind === "real-fail") return { kind: "real-fail", subkind: o.subkind }
  return { kind: "infra-fail", reason: o.reason }
}

/**
 * Public entry-point with measurement-stability wrapper.
 *
 * Flow:
 *   1. Resolve bench knob state from `process.env`. (Pure: closed-port read.)
 *   2. Compute the adaptive per-attempt timeout via `computeAdaptedTimeout`
 *      (= `baseMs * Σ(active knob costMultipliers)`, clamped to 30 min).
 *   3. Resolve `maxAttempts` (`deps.measurementStability?.maxAttempts` >
 *      `QUANTA_BENCH_RETRY_TRANSIENT` > 1).
 *   4. Run the retry loop: each iteration calls `runInstanceOnce` with deps
 *      whose `timeoutMs` is the ADAPTED value. Classify the result; stop on
 *      pass / real-fail / policy says stop.
 *   5. Stamp `result.budget` with the per-attempt history when adaptive OR
 *      retry produced a non-baseline value; otherwise omit (byte-identical
 *      JSON report shape).
 *
 * Byte-identical fence: when `maxAttempts === 1` (default) AND every active
 * knob's `costMultiplier <= 1` (i.e. `adaptedTimeoutMs === baseTimeoutMs`),
 * the wrapper:
 *   - calls `runInstanceOnce` EXACTLY ONCE with `deps.timeoutMs` unchanged;
 *   - does NOT stamp `result.budget` (omitted);
 *   - returns the same `InstanceResult` shape the legacy path would have.
 */
export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  // Resolve knob state for adaptive timeout. Fail-soft: any unexpected
  // throw in the resolver falls back to baseMs (byte-identical posture).
  let adaptedTimeoutMs = deps.timeoutMs
  const baseTimeoutMs = deps.timeoutMs
  try {
    const state = resolveBenchKnobs({ envVars: process.env })
    adaptedTimeoutMs = computeAdaptedTimeout(deps.timeoutMs, state)
    // computeAdaptedTimeout returns 0 for garbage baseMs; preserve the caller's
    // value in that case (the deadline timer will fire immediately, which is
    // the intended fail-fast posture).
    if (adaptedTimeoutMs === 0 && deps.timeoutMs > 0) adaptedTimeoutMs = deps.timeoutMs
  } catch {
    // Any resolution error ⇒ baseline posture. Telemetry concerns must
    // never fail a measurement run.
  }

  // Resolve maxAttempts. Precedence: deps.measurementStability.maxAttempts
  // (test seam) > unified posture `retryTransient` (preset/env via the knob
  // framework; preset `agentless-v1` ⇒ 3, explicit QUANTA_BENCH_RETRY_TRANSIENT
  // overrides) > 1. Transient failures (empty patch, infra fail) are cheap to
  // retry and significantly improve reliability on flaky instances.
  const maxAttempts = Math.max(
    1,
    Math.floor(deps.measurementStability?.maxAttempts ?? benchOptIns().retryTransient ?? 1),
  )
  const policy = deps.measurementStability?.policy ?? DEFAULT_POLICY

  // Adapted deps: only `timeoutMs` differs. All other fields are passed
  // through verbatim so each attempt sees the same agent / repair / observe
  // wiring. `measurementStability` is stripped so the inner call doesn't try
  // to recurse into the wrapper.
  const innerDeps: RunInstanceDeps = {
    llm: deps.llm,
    maxTurns: deps.maxTurns,
    timeoutMs: adaptedTimeoutMs,
    ...(deps.budgetMeterFactory !== undefined
      ? { budgetMeterFactory: deps.budgetMeterFactory }
      : {}),
    ...(deps.pythonSwebench !== undefined ? { pythonSwebench: deps.pythonSwebench } : {}),
    ...(deps.observe !== undefined ? { observe: deps.observe } : {}),
    ...(deps.repair !== undefined ? { repair: deps.repair } : {}),
    ...(deps.goldSanity !== undefined ? { goldSanity: deps.goldSanity } : {}),
  }

  // Byte-identical fast path: single attempt + adapted === base ⇒ run the
  // legacy single-pass and return without stamping `budget`. This is the
  // contract that keeps `QUANTA_BENCH_RETRY_TRANSIENT=1` + all-knobs-OFF
  // identical to the pre-feature wall-clock and JSON shape.
  if (maxAttempts === 1 && adaptedTimeoutMs === baseTimeoutMs) {
    return runInstanceOnce(instance, innerDeps)
  }

  const { result, loop } = await runRetryLoop(
    async () => runInstanceOnce(instance, innerDeps),
    maxAttempts,
    policy,
  )
  const budget = {
    baseTimeoutMs,
    adaptedTimeoutMs,
    attempts: loop.attempts,
    attemptOutcomes: loop.outcomes.map(projectOutcome),
  }
  return { ...result, budget }
}

/** Re-export the adaptive-timeout helpers so apps/bench's matrix budget tools
 *  can reuse the exact same projection. */
export { computeAdaptedTimeout, MAX_TIMEOUT_MS, sumCostMultipliers } from "./adaptive-timeout"
export type { BenchIssueHintMode, BenchKnobState, BenchPosture } from "./knobs-bench"
// Knob wiring helpers — re-exported for the report path + tests so callers
// don't have to import from two siblings.
export {
  applyBenchKnobs,
  benchPostureFromState,
  knobsForReport,
  readKnobValue,
  resolveBenchKnobs,
} from "./knobs-bench"
export { runRetryLoop } from "./retry-policy"
export type { AttemptOutcome, RetryPolicy }
/** Re-export the classifier + policy types so apps/bench callers can wire
 *  custom policies (test seam) or inspect outcomes without reaching into the
 *  retry-policy sub-slice directly. */
// Re-export the observation usage tap so test fixtures and other internals can
// continue to use bench's typed surface unchanged.
export { BenchObserver, classifyOutcome, DEFAULT_POLICY, parseRetryTransientEnv, UsageTap }
