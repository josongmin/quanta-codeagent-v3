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
import { join, relative, sep } from "node:path"
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
  lspNavToolList,
  type ReproExecPort,
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
import {
  FIND_REFS_STEER,
  LSP_GROUNDING_STEER,
  SPEC_FIDELITY_STEER,
} from "@/agent/localize-phase-guard"
import { decideEscalation } from "@/agent/repair-escalation"
import { extractIssueDeclaredExpected, extractIssueRepro } from "@/agent/verification-plan"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { errMessage, gateDisabled, gateOn } from "@/shared"
import { setKnobOverride } from "@/shared/knob-overrides"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Tool } from "@/tool"
import { astGrepTool, buildDefaultTools, findReferencesTool, ToolRegistry } from "@/tool"
import { testRunnerTool } from "@/tool/test-runner"
import { reproRunArgv } from "../corpus/dataset"
import { type AttemptObservation, BenchObserver, UsageTap } from "../observe"
import type {
  BenchAttemptOutcome,
  BenchReproTestTelemetry,
  Instance,
  InstanceResult,
  ReproOracleCalibration,
} from "../types"
import { computeAdaptedTimeout } from "./adaptive-timeout"
import {
  buildClosureSession,
  buildPhasePatchHygiene,
  type ClosureSessionState,
} from "./closure-session"
import { runEnvPrep } from "./env-prep"
import { exec, execArgv } from "./exec"
import { validateGoldPatch } from "./gold-sanity"
import {
  applyBenchKnobs,
  type BenchIssueHintMode,
  type BenchPosture,
  benchPostureFromState,
  knobsForReport,
  resolveBenchKnobs,
} from "./knobs-bench"
import { noPatchExhaustedErrorOf, wireNoPatchBreaker } from "./no-patch-breaker-adapter"
import {
  buildPhasePatchBudget,
  buildStrictPatchBudgetBlockedResult,
} from "./patch-budget-admission"
import { composePromptPrelude, composePromptText } from "./prompt-augment"
import { toRegressionGreen } from "./regression-oracle"
import { makeBenchRegressionOracle } from "./regression-oracle-adapter"
import { candidatePatchAppliesCleanly, withCandidatePatch } from "./rematerialize"
import { buildRepairContext } from "./repair/context"
import { runRepairRounds } from "./repair/index"
import { makeReproVoteValidate } from "./repair/repro-vote"
import { makePatchedResolvedConsensus } from "./repair/resolved-consensus"
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
import { calibrateReproOracle } from "./repro-oracle-calibration"
import {
  type AttemptOutcome,
  classifyOutcome,
  DEFAULT_POLICY,
  parseRetryTransientEnv,
  type RetryPolicy,
  runRetryLoop,
} from "./retry-policy"
import { cleanupSandbox, copyRepo, createSandbox, forkSandbox } from "./sandbox"
import {
  buildSelectionInputs,
  type Candidate,
  filesFromPatch,
  runSelection,
  type SelectionTelemetry,
  summarizeSelection,
} from "./selection-executor"
import { selectionGenerationErrorOf } from "./selection-generation-error"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"
import { BenchStreamTap, relFromSandbox } from "./stream-tap"
import { type PythonSwebenchEvaluate, verify } from "./verdict"

export interface RunInstanceDeps {
  llm: LLMPort
  /** Hard ceiling on agent turns per attempt. */
  maxTurns: number
  /** Wall-clock budget (ms) for the whole instance. */
  timeoutMs: number
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
  "field on the object answers the question (e.g. `self.query.group_by`), read " +
  "it DIRECTLY — do NOT build or call a runtime/execution/compiler object " +
  "(e.g. get_compiler(), pre_sql_setup(), running the query) and do NOT add a " +
  "new helper method, function, or class when editing the existing expression " +
  "in place would do. Eliminating a special case beats adding a branch or a new " +
  "abstraction; ask 'is there a one-line change to the existing code?' before " +
  "writing new code. Remove any reproduction script or downloaded file you " +
  "created so only the real source fix remains."

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
const SWEBENCH_DIRECTIVE_LEAN = [
  "",
  "",
  "You are fixing a real defect in this repository. An automated grader runs",
  "hidden tests against ONLY your source changes.",
  "- Test-driven: reproduce the issue with a small script, fix it, then verify",
  "  with your reproducer AND by finding and running the repository's own",
  "  relevant regression tests. Never modify, add, or delete any test file.",
  "- Solve it the way the problem warrants — reproduction, code inspection, or",
  "  test analysis — and make the SMALLEST change that fixes the root cause. Edit",
  "  the existing code in place; do not add helper methods or reach for runtime",
  "  APIs when an in-place edit works.",
  "- Change source code ONLY; never rewrite or reformat whole files. Your final",
  "  unified diff is the submission.",
].join("\n")

/**
 * Edit-and-submit variant of {@link SWEBENCH_DIRECTIVE} — used when the
 * `bench-in-loop-exec` knob is OFF (`opt.inLoopExec === false`, mini-swe posture).
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
 *  - LEAN ON (`QUANTA_BENCH_LEAN_PROMPT`): the SHORT {@link SWEBENCH_DIRECTIVE_LEAN}
 *    INSTEAD of the verbose directive, and the bolt-on steers (lsp / spec /
 *    simplicity / sibling) OMITTED — LEAN folds their intent in. The
 *    tool-availability `findRefs` steer is retained (it only names an actually-
 *    wired tool and is default-OFF itself).
 *
 * Non-swebench instances always return `base` unchanged on both arms.
 */
const composeBaseText = (
  base: string,
  isSwebench: boolean,
  inLoopExec: boolean,
  steers: SteerLines,
  leanPrompt: boolean,
): string => {
  if (!isSwebench) return base
  if (leanPrompt) {
    return `${base}${SWEBENCH_DIRECTIVE_LEAN}${steers.findRefs}`
  }
  const directive = inLoopExec ? SWEBENCH_DIRECTIVE : SWEBENCH_DIRECTIVE_NOEXEC
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
  /** T-201 observer seam (optional, no-op by default). When the agentless
   *  localizer produces ranked candidate files, they are handed here BEFORE
   *  being collapsed into the hint string — so the caller can build a
   *  FaultEvidencePacket from the SAME localization pass (no second LLM call).
   *  Pure observation: does not affect the returned hint. Fires only in
   *  agentless mode with a non-empty result. */
  readonly onCandidates?: (files: readonly string[]) => void
}

const DEFAULT_PREPARE_TIMEOUT_MS = 30_000

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
  const opt = benchOptIns()
  const extractOpts = { withExpectedActual: opt.issueHintExpectedActual }
  if (mode === "regex") {
    return composeIssueHint(extractIssueHint(instance.problemStatement, extractOpts))
  }
  // mode === "agentless"
  const regexFallback = (): string =>
    composeIssueHint(extractIssueHint(instance.problemStatement, extractOpts))
  // Empty problem statement ⇒ regex also yields "" ⇒ byte-identical.
  if (typeof instance.problemStatement !== "string" || instance.problemStatement.length === 0) {
    return regexFallback()
  }
  const fileTree = deps.fileTree ?? (async () => enumerateRepoSources(sandbox))
  const localize = deps.localize ?? agentlessLocalize
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<AgentlessLocalizeResult>((resolve) => {
    timer = setTimeout(() => resolve({ files: [], rationales: [], rawResponse: "" }), timeoutMs)
  })
  let result: AgentlessLocalizeResult
  try {
    result = await Promise.race([
      localize(instance.problemStatement, { llm: deps.llm, fileTree }),
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
}

/** Per-instance reproduction-script filename written into the sandbox. The
 *  agent's user message references this exact path. The leading underscore
 *  is intentional — keeps the script at the top of `ls` so the agent sees
 *  it without scanning. */
export const REPRO_FILE_NAME = "reproduce_issue.py"

/** User-message line appended (before the existing base text) when a repro
 *  test was successfully selected. Verbatim contract — the agent sees this
 *  exact string. */
export const REPRO_HINT_MESSAGE = [
  "A reproduction script has been placed at `reproduce_issue.py` in the sandbox.",
  "After your fix, run `python reproduce_issue.py` — it must print exactly",
  '"Issue resolved". If it prints anything else ("Issue reproduced",',
  '"Other issues", or nothing), your fix is incorrect and you must iterate.',
].join("\n")

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

const generateReproCandidateTests = async (
  instance: Instance,
  deps: PrepareReproTestDeps,
  config: ReproTestConfig,
): Promise<readonly string[] | null> => {
  try {
    const mwe = extractIssueRepro(instance.problemStatement)?.code
    return await (deps.generate ?? generateReproTests)({
      issue: instance.problemStatement,
      llm: deps.llm,
      config,
      ...(mwe !== undefined ? { mwe } : {}),
      ...(deps.adversarial === true ? { adversarial: true } : {}),
    })
  } catch {
    return null
  }
}

const executeReproCandidateTests = async (
  tests: readonly string[],
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
    return await (deps.execute ?? executeReproTests)({
      tests,
      repoRoot: sandbox,
      exec: buildReproExecPort(instance, deps),
      writeFile:
        deps.writeFile ??
        (async (path: string, content: string): Promise<void> => {
          await Bun.write(path, content)
        }),
      config,
      ...(buildArgv !== undefined ? { buildArgv } : {}),
    })
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
  const config: ReproTestConfig = { samples: k }
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
  // instances, build a `uvx --with-editable . python <script>` argv keyed on the
  // repo's python version; non-SWE-bench fixtures keep the bare python3 default.
  const samples = await executeReproCandidateTests(tests, instance, sandbox, deps, config)
  if (samples === null) return failedReproResult("execution_failed")
  const selection = select(samples)
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
 *   write `<sandbox>/reproduce_issue.py` ⇒ on success return REPRO_HINT_MESSAGE
 *   on disk write failure ⇒ undefined (byte-identical to K-unset)
 */
interface InstallReproTestResult {
  readonly hint: string | undefined
  readonly telemetry: BenchReproTestTelemetry | undefined
  /** #2 repro-vote: the scripts that REPRODUCED the bug on the un-patched tree
   *  (outcome === "reproduced"). Re-run on the patched tree + majority-voted by
   *  the K-of-N RESOLVED gate when the `repro-vote` knob is on. Empty/absent ⇒
   *  no vote (byte-identical legacy gate). */
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
  const posture = benchOptIns()
  const reproK = posture.reproTestK
  if (reproK === undefined) return { hint: undefined, telemetry: undefined }
  const preparation = await prepareReproTestDetailed(instance, sandbox, reproK, {
    llm,
    ...(posture.adversarialRepro === true ? { adversarial: true } : {}),
  })
  const { selection, telemetry } = preparation
  if (selection === null || selection.selected === null) return { hint: undefined, telemetry }
  // #2 repro-vote: keep EVERY reproducing script (not just the selected winner)
  // so the validation-time K-of-N RESOLVED vote can re-run the whole set.
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
  } catch {
    return { hint: undefined, reproSources, telemetry: writeFailedTelemetry(telemetry) }
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
  if (instance.swebench === undefined) return ""
  const testCmd = instance.testCmd.trim()
  if (testCmd.length === 0) return ""
  return [
    `Repository-local verifier for this task: ${testCmd}`,
    "When running repo tests, prefer this command (or a narrower variant of it) over bare host-global pytest/python.",
  ].join("\n")
}

type BenchTestRunnerInput = Parameters<typeof testRunnerTool.execute>[0]

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
  const authoritative = instance.testCmd.trim()
  if (authoritative === "") return undefined
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

const localEnvSlotOf = (instance: Instance): Pick<AgentConfig, "localEnv"> =>
  instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}

const applyLiveOverrides = (envKeys: readonly string[]): void => {
  for (const envKey of envKeys) {
    setKnobOverride(envKey, "1")
  }
}

const buildBenchRegistry = (instance: Instance, opt: BenchPosture): ToolRegistry => {
  const lspNavTools = opt.lspNav ? lspNavToolList() : []
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
  return verifierHint === ""
    ? `${instance.problemStatement}\n\nWork inside ${sandbox}. When done, stop.`
    : `${instance.problemStatement}\n\nWork inside ${sandbox}.\n${verifierHint}\nWhen done, stop.`
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
} => ({
  lsp:
    instance.swebench && opt.localizePhase?.lspGroundingSteer === true
      ? `\n-${LSP_GROUNDING_STEER}`
      : "",
  findRefs:
    instance.swebench && gateOn(process.env, "QUANTA_BENCH_FIND_REFS")
      ? `\n-${FIND_REFS_STEER}`
      : "",
  spec:
    instance.swebench &&
    opt.specFidelitySteer === true &&
    extractIssueDeclaredExpected(instance.problemStatement) !== undefined
      ? `\n-${SPEC_FIDELITY_STEER}`
      : "",
  simplicity:
    instance.swebench && !gateDisabled(process.env, "QUANTA_BENCH_SIMPLICITY")
      ? `\n-${SIMPLICITY_STEER}`
      : "",
  sibling:
    instance.swebench && gateOn(process.env, "QUANTA_BENCH_SIBLING")
      ? `\n-${SIBLING_COMPLETION_STEER}`
      : "",
})

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

const buildPromptText = (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly opt: BenchPosture
  readonly seedMsg?: string
  readonly precomputedHint?: string
  readonly reproHint?: string
  readonly closureHint?: string
}): string => {
  const leanPrompt = gateOn(process.env, "QUANTA_BENCH_LEAN_PROMPT")
  const baseText = composeBaseText(
    buildBaseProblemText(args.instance, args.sandbox),
    Boolean(args.instance.swebench),
    args.opt.inLoopExec,
    buildDirectiveSteers(args.instance, args.opt),
    leanPrompt,
  )
  const round0ReproSuppressed = args.opt.round0Minimal === true && args.seedMsg === undefined
  const effectiveReproHint = round0ReproSuppressed ? undefined : args.reproHint
  return composePromptText({
    issueHint: resolveIssueHintText(args.instance, args.opt, args.precomputedHint),
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
): Partial<AgentConfig> => ({
  ...(opt.lspNav ? { evictLspPoolOnEnd: true } : {}),
  ...(opt.lspNav && !gateDisabled(process.env, "QUANTA_LSP_PREWARM")
    ? { lspPrewarm: { enabled: true, warmSignal: signal } }
    : {}),
  ...(instance.swebench && opt.inLoopExec ? { verifyGuard: { mustPass: true, maxTrips: 2 } } : {}),
  ...(instance.swebench &&
  opt.inLoopExec &&
  !gateDisabled(process.env, "QUANTA_BENCH_PROTECT_TESTS")
    ? { protectTestPaths: true }
    : {}),
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
) => {
  // ADR-0015 LSP-nav: opt-in via `QUANTA_LSP_TOOLS=full` (same gate as CLI) OR
  // the bench-only `QUANTA_BENCH_LSP=1`. When the language-server binary
  // (`pyright-langserver` / `typescript-language-server`) is absent the
  // per-call probe in `lsp-bridge` makes the tools emit a clean `ok:false` —
  // registration is harmless without a server. Default-OFF preserves
  // byte-identical bench behavior.
  const state = resolveBenchKnobs({ envVars: process.env })
  const opt = benchPostureFromState(state, process.env)
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
  const registry = buildBenchRegistry(instance, opt)
  const permission: PermissionContext = { mode: "acceptEdits" }
  // Default behavior (no seedMsg) is byte-identical to the pre-b2 prompt: the
  // user message is `base` (+ SWEBENCH_DIRECTIVE for swebench instances). A
  // seedMsg ⇒ appended after a blank line ONLY for repair rounds ≥1.
  // `bench-in-loop-exec` knob (default-ON ⇒ byte-identical): ON uses the
  // test-running SWEBENCH_DIRECTIVE; OFF (mini-swe posture) swaps to the
  // edit-and-submit SWEBENCH_DIRECTIVE_NOEXEC.
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
  })
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text }],
    },
  ]
  const baseConfig = {
    llm: deps.llm,
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
    ...localEnvSlotOf(instance),
    maxTurns: deps.maxTurns,
    signal,
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
    // Gated additionally on `opt.inLoopExec`: the mini-swe (OFF) posture
    // edits-and-submits, so a "must verify" guard is moot (and would push the
    // agent at the same unrunnable host test-env). ON ⇒ byte-identical.
    // Test-scope guard (RCA 2026-06-19, django-13417). DEFAULT-ON for real
    // swebench in-loop runs (the no-test-edit rule is already DECLARED in the
    // bench system prompt — this ENFORCES it at the dispatch layer so the
    // model can't edit tests, chase its own modified tests, and regress a
    // correct minimal fix). Off-switch `QUANTA_BENCH_PROTECT_TESTS=0` yields
    // the A/B baseline arm (advisory-only, the pre-fix behavior). Gated on
    // `inLoopExec` like verifyGuard: the mini-swe posture (OFF) edits-and-
    // submits with test edits already stripped at diff time, so the guard is
    // moot there.
    ...buildConfigGuards(instance, opt, signal),
    // Bench A/B opt-ins (default-OFF; all unset ⇒ keys omitted entirely,
    // exactOptionalPropertyTypes-friendly, AgentConfig byte-identical).
  }
  const knobApplied = applyBenchKnobs(baseConfig, state, { instance, sandbox })
  const noPatchApplied = opt.noPatchBreaker ? wireNoPatchBreaker(knobApplied) : knobApplied
  return wireOptionalAgentPorts(
    {
      ...noPatchApplied,
      ...(opt.subagent !== undefined ? { subagent: opt.subagent } : {}),
      ...(opt.skills !== undefined ? { skills: opt.skills } : {}),
      ...(opt.localizePhase !== undefined ? { localizePhase: opt.localizePhase } : {}),
      ...(opt.branchSearch !== undefined ? { branchSearch: opt.branchSearch } : {}),
    },
    process.env,
  )
}

interface Phase {
  patch: string
  turns: number
  stopReason?: StopReason
  agentError?: string
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
const emitKnobsApplied = (stream: StreamPort, envVars: NodeJS.ProcessEnv): void => {
  try {
    const state = resolveBenchKnobs({ envVars })
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
): Promise<RunOnceResult> => {
  const tap = new BenchStreamTap(w.stream)
  // Knob telemetry (2026-05-26): emit ONE `knobs_applied` event per
  // runAgent invocation. In the repair orchestrator each round calls this
  // helper, so each round produces its own trajectory line (the env doesn't
  // change between rounds, so the lines are identical — useful as a
  // boundary marker).
  emitKnobsApplied(tap, process.env)
  const outcome = await runAgent(
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
      const tap = new BenchStreamTap(w.stream)
      // Knob telemetry: emit once per phase entry (matches the contract
      // documented on `emitKnobsApplied`). The single-pass path bypasses
      // `runAgentOnce`, so the emit lives here directly.
      emitKnobsApplied(tap, process.env)
      const outcome = await runAgent(
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
        ),
      )
      turns = outcome.turns
      stopReason = outcome.reason
      agentError = tap.lastErrorMessage
      firstEditFile = relFromSandbox(sandbox, tap.firstEditFile)
      editCount = tap.editCount
      turnsToFirstEdit = tap.turnsToFirstEdit
    },
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
 * `repro-vote` knob is on AND a reproducing set exists. ON ⇒ wraps the
 * K-of-N RESOLVED majority vote that re-runs the reproducing set on the patched
 * sandbox (`makeReproVoteValidate`), with `fallback` as the inconclusive/empty/
 * fail-open path. The exec port mirrors the base-red run (uvx project-env argv
 * for SWE-bench, the instance's `localEnv`) so imports resolve identically.
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
  if (benchOptIns().reproVote !== true || reproSources.length === 0) return fallback
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
      timeoutMs,
      probe: (sb) => probe(sb),
    })
}

const CALIBRATION_UNAVAILABLE: ReproOracleCalibration = {
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
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
  if (reproSources.length === 0) return { port: base, calibration: CALIBRATION_UNAVAILABLE }
  const probe = makePatchedResolvedConsensus({
    sources: reproSources,
    ...reproExecBundle(instance),
  })
  const calibration = await calibrateReproOracle({
    resolvedProbe: probe,
    goldPatch: instance.goldPatch,
    sandbox,
    baseCommit: instance.swebench?.baseCommit,
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
): Promise<Phase> => {
  let turns = 0
  let finalPatch = ""
  let repairValidated = false
  let repairFalseGreen = false
  let repairFalseRed = false
  let repairRounds = 0
  // #2 repro-vote: when the knob is on AND we have a reproducing set, the
  // validator becomes the K-of-N RESOLVED majority vote (re-run the set on the
  // patched tree); it falls back to the legacy gate on an empty set / fail /
  // tie. Default-OFF or no repro ⇒ `baseValidate` ⇒ byte-identical. The exec
  // wiring lives in the SHARED `buildReproVoteValidate` so both drivers agree.
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

const unavailableReproCalibration = (): ReproOracleCalibration => ({
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
})

const resolveSelectionReproConsensus = async (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
  reproSources: readonly string[],
  mode: BenchPosture["verifySelectRepro"],
) => {
  const reproPolicy = selectionReproPolicy(mode)
  const calibrationUnavailable = unavailableReproCalibration()
  if (!reproPolicy.enabled) {
    return {
      reproPolicy,
      resolvedKofNSelectionPort: undefined,
      calibration: calibrationUnavailable,
    }
  }
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
      calibration,
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
    calibration: calibrationUnavailable,
  }
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
  verifySelectRegression: BenchPosture["verifySelectRegression"],
  verifySelectRepro: BenchPosture["verifySelectRepro"],
  selectionOwnerCandidates: readonly string[],
  baseValidatedRed: boolean,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  reproSources: readonly string[],
): Promise<Phase> => {
  const selectionInputs = buildSelectionInputs({
    n,
    ownerCandidates: selectionOwnerCandidates,
    sandbox,
  })
  const generationErrors = new Map<number, string>()
  const mergeHint = (seed: string | undefined): string | undefined =>
    seed === undefined
      ? closureHint
      : closureHint === undefined
        ? seed
        : `${closureHint}\n\n${seed}`

  let totalTurns = 0
  const { reproPolicy, resolvedKofNSelectionPort, calibration } =
    await resolveSelectionReproConsensus(
      instance,
      sandbox,
      deps.timeoutMs,
      reproSources,
      verifySelectRepro,
    )
  const discoveredRegressionPort =
    verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionPort({ instance, sandbox, timeoutMs: deps.timeoutMs })
      : undefined
  const selectionBaseValidatedRed =
    verifySelectRegression === "discovered" ? null : baseValidatedRed
  const result = await runSelection({
    n,
    owners: selectionInputs.owners,
    seeds: selectionInputs.seeds,
    resolvedKofNMode: reproPolicy.resolvedKofNMode,
    earlyAccept,
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
          const generationError = selectionGenerationErrorOf({
            stopReason: phase.stopReason,
            ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
          })
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
            ...(phase.stopReason !== undefined ? { stopReason: phase.stopReason } : {}),
            ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
            ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
          }
        } finally {
          if (isolated) await cleanupSandbox(candidateSandbox)
        }
      },
      applyClean: (c) =>
        candidatePatchAppliesCleanly({
          sandbox,
          patch: c.patch,
          baseCommit: instance.swebench?.baseCommit,
          timeoutMs: deps.timeoutMs,
        }),
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
            const r = await makeBenchRegressionOracle(
              undefined,
              instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {},
            )
              .run({ tests, sandbox: sb })
              .catch(() => null)
            return toRegressionGreen(tests, r)
          },
        })
      },
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
    ...(result.terminalCandidate?.stopReason !== undefined
      ? { stopReason: result.terminalCandidate.stopReason }
      : {}),
    ...(result.terminalCandidate?.agentError !== undefined
      ? { agentError: result.terminalCandidate.agentError }
      : {}),
    ...(result.terminalCandidate?.editCount !== undefined
      ? { editCount: result.terminalCandidate.editCount }
      : {}),
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
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...(args.phase.selectionTelemetry?.winnerId === null
      ? {
          error:
            "verify-select produced no submittable candidate (all candidates were empty or did not apply)",
        }
      : {}),
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

type RepairConfig = NonNullable<RunInstanceDeps["repair"]>

interface HintReproContext {
  readonly posture: BenchPosture
  readonly precomputedHint: string
  readonly localizeCandidates: readonly string[]
  readonly reproHint: string | undefined
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly reproSources: readonly string[]
}

interface PreparedAttemptContext extends HintReproContext {
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly closureSession: ClosureSessionState | undefined
  readonly verificationPlan: ClosureSessionState["bundle"]["plan"] | undefined
  readonly primaryRailStep: PrimaryRailStep | undefined
  readonly closureHint: string | undefined
  readonly effectiveRepair: RepairConfig | undefined
  readonly repairGateEligible: boolean
  readonly gateDecisionVerify: boolean
  readonly runRepair: boolean
}

const envPrepFailedResult = (
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

const prepareHintAndReproContext = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
): Promise<HintReproContext> => {
  const posture = benchOptIns()
  let localizeCandidates: readonly string[] = []
  const precomputedHint = await prepareIssueHint(instance, sandbox, posture.issueHintMode, {
    llm,
    onCandidates: (files) => {
      localizeCandidates = files
    },
  })
  const reproInstall = benchInstallsReproHint(posture.inLoopExec)
    ? await installReproTestHint(instance, sandbox, llm)
    : { hint: undefined, telemetry: undefined }
  return {
    posture,
    precomputedHint,
    localizeCandidates,
    reproHint: reproInstall.hint,
    reproTest: reproInstall.telemetry,
    reproSources: reproInstall.reproSources ?? [],
  }
}

const resolveOwnerResolved = async (args: {
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly stage1Files: readonly { file: string; score: number }[]
  readonly sandbox: string
  readonly signal: AbortSignal
}): Promise<readonly OwnerSibling[] | undefined> => {
  if (!(args.instance.swebench !== undefined && args.posture.faultEvidence && args.posture.lspNav)) {
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

const buildClosureAttemptState = (args: {
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly stage1Files: readonly { file: string; score: number }[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly reproTest: BenchReproTestTelemetry | undefined
}): ClosureSessionState | undefined =>
  args.instance.swebench === undefined
    ? undefined
    : buildClosureSession({
        problemStatement: args.instance.problemStatement,
        stage1Files: args.stage1Files,
        ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
        ...(args.reproTest?.installed === true && args.reproTest.reproducedCount > 0
          ? { reproScript: { cmd: `python "${args.reproTest.path}"`, baseValidatedRed: true } }
          : {}),
        posture: {
          lspNav: args.posture.lspNav,
          primaryRail: args.posture.primaryRail,
          faultEvidence: args.posture.faultEvidence,
        },
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
    args.posture.inLoopExec,
  )
  const gateDecisionVerify = repairGateEligible && args.closureSession?.bundle.gate.action === "verify"
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

const prepareAttemptContext = async (
  instance: Instance,
  sandbox: string,
  deps: RunInstanceDeps,
  signal: AbortSignal,
): Promise<PreparedAttemptContext> => {
  const hintRepro = await prepareHintAndReproContext(instance, sandbox, deps.llm)
  const stage1Files = stage1FilesOf(hintRepro.localizeCandidates)
  const ownerResolved = await resolveOwnerResolved({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    sandbox,
    signal,
  })
  const closureSession = buildClosureAttemptState({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    ownerResolved,
    reproTest: hintRepro.reproTest,
  })
  return {
    ...hintRepro,
    ownerResolved,
    closureSession,
    verificationPlan: closureSession?.bundle.plan,
    primaryRailStep: closureSession?.primaryRailStep,
    closureHint: closureSession?.closureHint,
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
    return runSelectionPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.posture.verifySelectN,
      args.prepared.posture.verifySelectConcurrency,
      args.prepared.posture.verifySelectEarlyAccept,
      args.prepared.posture.verifySelectRegression,
      args.prepared.posture.verifySelectRepro,
      args.prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ??
        args.prepared.localizeCandidates,
      args.prepared.verificationPlan?.baseValidatedRed ?? false,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.reproSources,
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
  )
}

const maybeValidateTerminalResult = async (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
  readonly signal: AbortSignal
}): Promise<InstanceResult | undefined> => {
  const terminal = terminalAgentResult(args)
  if (terminal === undefined) return undefined
  if (!shouldValidateGold(args.deps, false)) return terminal
  const gold = await validateGoldPatch(args.instance, { ...args.deps, signal: args.signal })
  if (gold.ok) return terminal
  const { error: _prevError, ...rest } = terminal
  return { ...rest, passed: false, verdict: "grader_invalid", error: gold.error }
}

const observeStrictBudgetBlock = (args: {
  readonly extra: Partial<InstanceResult>
  readonly deps: RunInstanceDeps
  readonly instance: Instance
  readonly wiring: Wiring
  readonly phase: Phase
  readonly startedAt: number
  readonly strictBudget: ReturnType<typeof buildPhasePatchBudget>
}): void => {
  if (!(args.deps.observe && args.wiring.observer)) return
  args.extra.verdict = "ok"
  args.extra.durationMs = Date.now() - args.startedAt
  args.extra.patchPath = emitPatch(
    args.deps.observe,
    args.instance,
    args.wiring.observer,
    args.phase.patch,
  )
  const usage = args.wiring.usage?.total()
  if (usage) args.extra.usage = usage
  if (args.phase.firstEditFile !== undefined) args.extra.firstEditFile = args.phase.firstEditFile
  if (args.phase.editCount !== undefined) args.extra.editCount = args.phase.editCount
  if (args.phase.turnsToFirstEdit !== undefined) args.extra.turnsToFirstEdit = args.phase.turnsToFirstEdit
  args.extra.patchBudget = args.strictBudget
}

const maybeStrictBudgetBlockedResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
  readonly posture: BenchPosture
  readonly closureSession: ClosureSessionState | undefined
}): InstanceResult | undefined => {
  const strictBudget =
    args.posture.patchBudgetStrict && args.instance.swebench !== undefined
      ? buildPhasePatchBudget({
          patch: args.phase.patch,
          repo: args.instance.swebench.repo,
          closureSession: args.closureSession,
          strict: true,
        })
      : undefined
  if (strictBudget === undefined || strictBudget.withinBudget) return undefined
  const extra: Partial<InstanceResult> = reproResultExtra(args.reproTest)
  observeStrictBudgetBlock({ ...args, extra, strictBudget })
  return buildStrictPatchBudgetBlockedResult({
    id: args.instance.id,
    turns: args.phase.turns,
    verdict: strictBudget,
    extra,
  })
}

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
  if (args.phase.turnsToFirstEdit !== undefined) args.extra.turnsToFirstEdit = args.phase.turnsToFirstEdit
}

const attachClosureMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  const { posture, verificationPlan, primaryRailStep, repairGateEligible, gateDecisionVerify } =
    args.prepared
  if (posture.verificationPlan || posture.primaryRail) {
    args.extra.primaryRailPresent = primaryRailStep !== undefined
    args.extra.requiredVerificationCovered =
      verificationPlan?.required.some((s) => s.successPredicate !== undefined) ?? false
    if (verificationPlan !== undefined) args.extra.synthReproBaseRed = verificationPlan.baseValidatedRed
    if (primaryRailStep !== undefined && args.phase.primaryFalseGreen !== undefined) {
      args.extra.primaryFalseGreen = args.phase.primaryFalseGreen
    }
    if (primaryRailStep !== undefined && args.phase.primaryFalseRed !== undefined) {
      args.extra.primaryFalseRed = args.phase.primaryFalseRed
    }
  }
  if (repairGateEligible) {
    args.extra.gateEntered = gateDecisionVerify
    args.extra.gateBypassed = !gateDecisionVerify
    if (args.phase.verifyRounds !== undefined) args.extra.verifyRounds = args.phase.verifyRounds
  }
}

const attachSelectionAndClosureArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  const { posture, verificationPlan, closureSession, primaryRailStep, ownerResolved } = args.prepared
  if (args.phase.reproOracleCalibration !== undefined) {
    args.extra.reproOracleCalibration = args.phase.reproOracleCalibration
  }
  if (args.phase.selectionTelemetry !== undefined) {
    args.extra.selectionTelemetry = args.phase.selectionTelemetry
  }
  const ownerHint = relFromSandbox(args.sandbox, args.phase.firstEditFile)
  const hygiene =
    args.instance.swebench !== undefined ? buildPhasePatchHygiene(args.phase.patch, ownerHint) : undefined
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
    args.extra.repairEscalation = decideEscalation({
      candidates: closureSession.bundle.evidence.candidates.map((c) => ({
        file: c.file,
        score: c.score,
        sources: c.sources,
      })),
      primaryRailRedAfterRepair: primaryRailRedAfterRepair(
        primaryRailStep,
        args.phase.validated,
        args.phase.primaryFalseGreen,
      ),
      siblingFiles: ownerResolved?.map((o) => o.file) ?? [],
    })
  }
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
  attachObservedSuccessBasics(args)
  attachClosureMetrics(args)
  attachSelectionAndClosureArtifacts(args)
  if (args.verified.breakdown !== undefined) extra.gradeBreakdown = args.verified.breakdown
  return extra
}

const verifyAndFinalizeResult = async (args: {
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
export const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  let deadline: ReturnType<typeof setTimeout> | undefined
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  let reproTest: BenchReproTestTelemetry | undefined
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)

    // T4 — per-instance env pre-preparation (fail-fast). When the instance
    // carries a `setupCmd`, run it in the sandbox copy BEFORE the agent. If
    // setup exits non-zero we fail-fast with a DISTINCT `env_prep_failed`
    // verdict and DO NOT run the agent — handing a half-prepared env to the
    // agent is exactly the failure this prevents.
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

    // Pre-compute the issue-hint text. For mode `"off"` and `"regex"` this is
    // a cheap synchronous shortcut (regex path computed eagerly so the hint
    // string is byte-identical to the legacy in-buildConfig path). For mode
    // `"agentless"` an async LLM localization call runs here exactly ONCE
    // per instance, before any agent turn — repair rounds reuse the same
    // hint (the issue text doesn't change across rounds; re-asking the LLM
    // would just waste budget).
    const posture = benchOptIns()
    const hintMode = posture.issueHintMode
    // T-201: capture the agentless localizer's ranked candidates from the SAME
    // pass (observer seam — no second LLM call). Empty unless agentless mode runs.
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
    // #2 repro-vote: the reproducing set (empty unless repro reproduced), passed
    // to the repair phase so the K-of-N RESOLVED gate can re-run it on the patch.
    const reproSources = reproInstall.reproSources ?? []

    // T-302 primary-rail SELECTION (default-OFF, knob `primary-rail`). When a repro
    // was installed AND it reproduced the bug on the unpatched base
    // (`reproducedCount > 0` ⇒ red-on-injection), that repro IS the primary rail:
    // buildVerificationPlan only promotes it to primaryRail because baseValidatedRed
    // is true (a non-red repro would be demoted to optional ⇒ null rail ⇒ no
    // enforcement). The rail's cmd then GATES the repair loop (see runValidate):
    // the agent's own verify can no longer clear a round — the false-green killer
    // fires. Knob OFF or no red repro ⇒ undefined ⇒ byte-identical agent gate.
    // gap-B: extract the issue-declared expected output (public, fail-closed) so
    // the verification plan can carry a typed exact-output predicate AND the
    // spec-fidelity steer can fire only when a concrete spec exists.
    const stage1Files = localizeCandidates.map((file, i) => ({
      file,
      score: localizeCandidates.length - i,
    }))
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
    // `timeoutMs` of think time (copy/setup/hint prep are outside the budget).
    deadline = setTimeout(() => abort.abort(), deps.timeoutMs)

    // b2 — Repair gating: ONLY when caller set `deps.repair` AND this is a
    // real SWE-bench instance (same posture as verifyGuard / SWEBENCH_DIRECTIVE).
    // ABSENT ⇒ existing single-pass path verbatim (byte-identical: same calls,
    // same buildConfig (no seedMsg), same single withGitSnapshot/runAgent,
    // same single verify()). The official verify() ALWAYS runs exactly once,
    // OUTSIDE the repair loop — its result is never fed back to the agent
    // (no-leak invariant; also enforced by code locality).
    //
    // When `hintMode === "off"`, `precomputedHint` is `""`; `buildConfig`
    // treats a defined-but-empty hint identically to undefined: no
    // injection. So the off-mode path is byte-identical to the pre-feature
    // pipeline (the legacy regex-on-`=1` path is also byte-identical
    // because `prepareIssueHint("regex")` returns the same string the
    // in-buildConfig regex would have produced).
    // The closure bundle's EXECUTION half. The verify-first repair loop is
    // enabled either by the operator's `--repair-rounds` CLI override
    // (`deps.repair`, which can also carry custom validate/buildContext) OR —
    // when the caller didn't set it — by the PRESET's `closure-repair` knob
    // (`posture.repairRounds`). The CLI override wins. Both absent ⇒ undefined ⇒
    // byte-identical single-pass path. This is what makes `agentless-v2`'s
    // selected rail (primary_rail_present_rate ≈ 0.82) actually GATE instead of
    // being an inert judgment (gate_enter_rate was n=0 because deps.repair was
    // disconnected from the preset).
    const effectiveRepair =
      deps.repair ??
      (posture.repairRounds !== undefined ? { maxRounds: posture.repairRounds } : undefined)
    const repairGateEligible = benchRunsRepairPhase(
      effectiveRepair !== undefined,
      instance.swebench !== undefined,
      posture.inLoopExec,
    )
    const gateDecisionVerify = repairGateEligible && closureSession?.bundle.gate.action === "verify"
    const runRepair =
      effectiveRepair !== undefined &&
      benchShouldRunRepairPhase({
        eligible: repairGateEligible,
        primaryRailEnabled: posture.primaryRail,
        gateAction: closureSession?.bundle.gate.action,
        primaryRailStep,
        verificationPlan,
      })
    phase =
      posture.verifySelectN !== undefined && instance.swebench !== undefined
        ? await runSelectionPhase(
            instance,
            deps,
            sandbox,
            abort.signal,
            w,
            posture.verifySelectN,
            posture.verifySelectConcurrency,
            posture.verifySelectEarlyAccept,
            posture.verifySelectRegression,
            posture.verifySelectRepro,
            closureSession?.bundle.evidence.candidates.map((c) => c.file) ?? localizeCandidates,
            verificationPlan?.baseValidatedRed ?? false,
            precomputedHint,
            reproHint,
            closureHint,
            reproSources,
          )
        : runRepair && effectiveRepair !== undefined
          ? await runRepairPhase(
              instance,
              deps,
              sandbox,
              abort.signal,
              w,
              effectiveRepair,
              precomputedHint,
              reproHint,
              closureHint,
              primaryRailStep,
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
      if (shouldValidateGold(deps, false)) {
        const gold = await validateGoldPatch(instance, { ...deps, signal: abort.signal })
        if (!gold.ok) {
          const { error: _prevError, ...rest } = terminal
          return { ...rest, passed: false, verdict: "grader_invalid", error: gold.error }
        }
      }
      return terminal
    }

    const strictBudget =
      posture.patchBudgetStrict && instance.swebench !== undefined
        ? buildPhasePatchBudget({
            patch: phase.patch,
            repo: instance.swebench.repo,
            closureSession,
            strict: true,
          })
        : undefined
    if (strictBudget !== undefined && !strictBudget.withinBudget) {
      const extra: Partial<InstanceResult> = reproResultExtra(reproTest)
      if (deps.observe && w.observer) {
        extra.verdict = "ok"
        extra.durationMs = Date.now() - startedAt
        extra.patchPath = emitPatch(deps.observe, instance, w.observer, phase.patch)
        const usage = w.usage?.total()
        if (usage) extra.usage = usage
        if (phase.firstEditFile !== undefined) extra.firstEditFile = phase.firstEditFile
        if (phase.editCount !== undefined) extra.editCount = phase.editCount
        if (phase.turnsToFirstEdit !== undefined) extra.turnsToFirstEdit = phase.turnsToFirstEdit
        extra.patchBudget = strictBudget
      }
      return buildStrictPatchBudgetBlockedResult({
        id: instance.id,
        turns: phase.turns,
        verdict: strictBudget,
        extra,
      })
    }

    // T01 (audit L5 H-5): thread the per-instance deadline signal into verify so
    // the official harness grading + its transient-crash retry sleep stop when
    // the instance deadline fires instead of cascading into the next instance.
    let v = await verify(instance, phase.patch, sandbox, { ...deps, signal: abort.signal })

    const extra: Partial<InstanceResult> = reproResultExtra(reproTest)
    if (shouldValidateGold(deps, v.passed)) {
      const gold = await validateGoldPatch(instance, { ...deps, signal: abort.signal })
      if (!gold.ok) {
        const { error: _prevError, ...rest } = v
        v = { ...rest, passed: false, error: gold.error }
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
      // T-3 closure measurement signals (observe-only; gated on the same closure
      // knobs as the plan telemetry ⇒ byte-identical report when off). Drive the
      // `primary_rail_present_rate` / `required_verification_coverage` metrics.
      if (posture.verificationPlan || posture.primaryRail) {
        extra.primaryRailPresent = primaryRailStep !== undefined
        extra.requiredVerificationCovered =
          verificationPlan?.required.some((s) => s.successPredicate !== undefined) ?? false
        if (verificationPlan !== undefined)
          extra.synthReproBaseRed = verificationPlan.baseValidatedRed
        // primaryFalseGreen is only meaningful when a primary RAIL was actually
        // gated (the predicate runs on the rail). Repair-without-rail (e.g.
        // verification-plan knob on but no rail selected) ⇒ omit ⇒ measurement null
        // (NOT false — emitting false would spuriously enlarge the rate denominator).
        if (primaryRailStep !== undefined && phase.primaryFalseGreen !== undefined)
          extra.primaryFalseGreen = phase.primaryFalseGreen
        if (primaryRailStep !== undefined && phase.primaryFalseRed !== undefined)
          extra.primaryFalseRed = phase.primaryFalseRed
      }
      if (repairGateEligible) {
        extra.gateEntered = gateDecisionVerify
        extra.gateBypassed = !gateDecisionVerify
        if (phase.verifyRounds !== undefined) extra.verifyRounds = phase.verifyRounds
      }
      if (phase.reproOracleCalibration !== undefined) {
        extra.reproOracleCalibration = phase.reproOracleCalibration
      }
      if (phase.selectionTelemetry !== undefined) {
        extra.selectionTelemetry = phase.selectionTelemetry
      }
      // T-401 — patch hygiene report over the final diff. Knob-gated + swebench-only
      // + observe-only ⇒ byte-identical report.json when the knob is OFF. The first
      // mutating edit (if any) is the only owner signal we have here, so it seeds
      // the owner set; absent ⇒ owner-outside telemetry suppressed (empty), never
      // flagging every file. Telemetry-first: we EMIT the report, we do NOT deny.
      const ownerHint = relFromSandbox(sandbox, phase.firstEditFile)
      const hygiene =
        instance.swebench !== undefined ? buildPhasePatchHygiene(phase.patch, ownerHint) : undefined
      if (posture.patchHygiene && hygiene !== undefined) {
        extra.patchHygiene = hygiene
        extra.outOfScopeFiles = hygiene.filesOutsideOwner.length > 0
      }
      if ((posture.patchBudget || posture.patchBudgetStrict) && instance.swebench !== undefined) {
        extra.patchBudget = buildPhasePatchBudget({
          patch: phase.patch,
          repo: instance.swebench.repo,
          closureSession,
          strict: posture.patchBudgetStrict,
        })
      }
      // T-301 verification-plan telemetry (knob-gated, observe-only).
      if (posture.verificationPlan && verificationPlan !== undefined) {
        extra.verificationPlan = verificationPlan
      }
      // T-201/T-202 fault-evidence packet + owner-admission reuse the SAME
      // ClosureBundle snapshot as the gate/plan. Empty evidence degrades honestly
      // (`partial` / `admit:false`); no separate ad hoc recomputation.
      if (posture.faultEvidence && closureSession !== undefined) {
        extra.faultEvidence = closureSession.bundle.evidence
        extra.ownerAdmission = closureSession.bundle.owner
      }
      // T-601 escalation uses the SAME evidence packet the prompt/gate saw.
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
          siblingFiles: ownerResolved !== undefined ? ownerResolved.map((o) => o.file) : [],
        })
      }
    }
    return okResult(instance, phase, v, extra)
  } catch (e) {
    if (e instanceof ObservationError) {
      return {
        id: instance.id,
        passed: false,
        patch: phase.patch,
        turns: phase.turns,
        verdict: "degraded",
        error: `observation failed (strict): ${e.message}`,
        ...reproResultExtra(reproTest),
      }
    }
    return {
      id: instance.id,
      passed: false,
      patch: phase.patch,
      turns: phase.turns,
      error: errMessage(e),
      ...reproResultExtra(reproTest),
    }
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
