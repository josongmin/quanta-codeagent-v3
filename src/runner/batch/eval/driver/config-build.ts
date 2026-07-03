import {
  type AgentConfig,
  BUDGET_PRESETS,
  BudgetMeter,
  composeIssueHint,
  composeSystemPromptForSurface,
  extractIssueHint,
  lspNavCheapToolList,
  lspNavToolList,
  SWE_SURFACE_PROFILE,
  wireOptionalAgentPorts,
} from "@/agent"
import {
  FIND_REFS_STEER,
  LSP_GROUNDING_STEER,
  SPEC_FIDELITY_STEER,
} from "@/agent/localize-phase-guard"
import { extractIssueDeclaredExpected } from "@/agent/verification-plan"
import { buildVerifyGuard } from "@/agent/verify-guard"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { gateDisabled, gateOn, normalizePublicIssueText } from "@/shared"
import { setKnobOverride } from "@/shared/knob-overrides"
import type { AgentEvent, StreamPort } from "@/stream"
import { astGrepTool, buildDefaultTools, findReferencesTool, type Tool, ToolRegistry } from "@/tool"
import { testRunnerTool } from "@/tool/test-runner"
import type { Instance } from "../../types"
import {
  applyBenchKnobs,
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  knobsForReport,
  readKnobValue,
  resolveBenchKnobs,
} from "../knobs-bench"
import { wireNoPatchBreaker } from "../no-patch-breaker-adapter"
import { projectEnvPythonShimLocalEnv } from "../project-env-python-shim"
import { composePromptText } from "../prompt-augment"
import { agentVisibleBenchVerifierCommand } from "../repo-local-verifier-command"
import type { RunInstanceDeps } from "./context-types"
import { composeBaseText, SIBLING_COMPLETION_STEER, SIMPLICITY_STEER } from "./prompt-directives"
import { repoLocalVerifierHint } from "./repro-test-prep"

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
  const authoritative = agentVisibleBenchVerifierCommand(instance, process.env)
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
  const cmd = agentVisibleBenchVerifierCommand(instance, process.env)
  return cmd === undefined ? undefined : [cmd]
}

const applyLiveOverrides = (envKeys: readonly string[]): void => {
  for (const envKey of envKeys) {
    setKnobOverride(envKey, "1")
  }
}

const buildBenchRegistry = (instance: Instance, opt: BenchPosture, cwd: string): ToolRegistry => {
  // jun-26 (REPORT-jun26-tool-impl-vs-frontier §4.5) — LSP-nav tiering. The full
  // opt-in (`opt.lspNav`, QUANTA_BENCH_LSP / QUANTA_LSP_TOOLS=full) supersets the
  // cheap tier and additionally exposes the MEASURED-intractable members
  // (`lsp_references` / `lsp_implementation`), so it wins when set. Otherwise the
  // DEFAULT-ON cheap tier (`opt.lspNavCheap`) registers the index-backed /
  // call-graph nav moat; an explicit `QUANTA_BENCH_LSP_CHEAP=0/off/false` (or a
  // preset `lsp-cheap:false`) makes `lspNavCheap` false ⇒ empty list ⇒ the nav
  // surface is byte-identical to the legacy default-OFF posture.
  const lspNavTools = opt.lspNav
    ? lspNavToolList(() => cwd)
    : opt.lspNavCheap
      ? lspNavCheapToolList(() => cwd)
      : []
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
      // Default OFF; opt-in via QUANTA_BENCH_SIMPLICITY (unvalidated absorbed steer — A/B before promoting).
      isSwebench && gateOn(process.env, "QUANTA_BENCH_SIMPLICITY"),
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

/** must-pass knob override shape (bench consumes it HERE, not via apply-binding —
 *  see {@link reconcileBenchGuards}). Mirrors the parsed `mustPassSchema` value. */
interface MustPassOverride {
  readonly mustPass: boolean
  readonly maxTrips?: number
  readonly stickyRed?: boolean
}
const isMustPassOverride = (v: unknown): v is MustPassOverride =>
  typeof v === "object" && v !== null && typeof (v as { mustPass?: unknown }).mustPass === "boolean"

/**
 * SINGLE authority for bench AgentConfig GUARD fields (ADR-0013 + jun-28 SSOT).
 * Runs AFTER `applyBenchKnobs` and is the ONLY place verifyGuard / lspPrewarm /
 * protectTestPaths / evictLspPoolOnEnd are set — no driver-hardcode-vs-knob
 * double-set (the merge-order fragility that previously dropped `exactCommands`).
 *
 * `verifyGuard` = posture DEFAULT (swebench + in-loop-exec=full) ⊕ the optional
 * `must-pass` knob OVERRIDE. The override replaces the default per-field but
 * ALWAYS inherits the instance's `exactCommands` so an explicit override never
 * silently broadens verify detection. Byte-identical fence: no preset/env ⇒
 * `opt` all-OFF and `mustPass` undefined ⇒ same fields as the pre-SSOT path.
 */
const reconcileBenchGuards = (
  cfg: AgentConfig,
  args: {
    instance: Instance
    opt: BenchPosture
    signal: AbortSignal
    mustPass: MustPassOverride | undefined
  },
): AgentConfig => {
  const { instance, opt, signal, mustPass } = args
  const exactCommands = benchVerifyAuthorityCommandsOf(instance)
  const defaultGuard =
    instance.swebench && opt.inLoopExecMode === "full"
      ? exactCommands !== undefined
        ? { mustPass: true, maxTrips: 2, exactCommands }
        : { mustPass: true, maxTrips: 2 }
      : undefined
  const verifyGuard =
    mustPass !== undefined ? buildVerifyGuard(mustPass, exactCommands) : defaultGuard
  return {
    ...cfg,
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

/**
 * Repair-round localize-phase suppression (jun-25).
 *
 * The localize-phase EDIT-BLOCK (`decideLocalizePhase`) is an INITIAL-generation
 * safety: it denies mutating tools for the first `phase1Turns` of a session to
 * stop the model editing the wrong file before the fault is localized. A REPAIR
 * round spins a FRESH agent session (turn 0) but the fault is ALREADY localized
 * by construction — the patch exists and the failing gate is named, and the
 * repair seed explicitly says "Revise the existing cumulative patch …
 * repair_existing_patch_only". Letting the edit-block re-fire there is a
 * straitjacket: the model is told to fix the patch AND forbidden to edit for the
 * first 5 turns, wasting a round re-localizing.
 *
 * This strips `phase1Turns` from the repair posture's `localizePhase` so
 * `buildLocalizePhase` returns `undefined` (no state ⇒ `decideLocalizePhase`
 * never blocks). The advisory LSP-grounding / CHA steers ride on the SAME
 * `localizePhase` object (`lspGroundingSteer` is read by `buildDirectiveSteers`
 * as an always-present directive line), so we PRESERVE those fields and only
 * drop `phase1Turns` — repair keeps the optional steer but loses the hard
 * edit-block. Absent `localizePhase` ⇒ pass-through (byte-identical).
 *
 * INITIAL generation is untouched: this only rewrites the posture used by the
 * repair `runAgentOnce` call, never the single-pass / generation phase.
 */
export const repairLocalizePhaseSuppressed = (opt: BenchPosture): BenchPosture => {
  const lp = opt.localizePhase
  if (lp === undefined) return opt
  const { phase1Turns: _dropped, ...rest } = lp
  return { ...opt, localizePhase: rest }
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

/**
 * Bench budget meter (reused attempt-wide by the apps driver, or per-config by
 * direct callers). The bench harness assembles its config via `buildConfig`
 * (NOT the host `assembleAgentConfig`), so the batch preset dials and the
 * autonomous-mode cost caps never reached it directly.
 *
 * DEFAULT-OFF (HARD byte-identical invariant): with NO operator cost cap set, this
 * returns `undefined` ⇒ no meter ⇒ the bench loop keeps its prior behavior exactly
 * (no new always-on `maxTurns`/`maxWallClockMs`/`maxConsecutiveFailures`/call caps
 * that could abort a legitimate hard-instance repair trajectory mid-solve and
 * record it as a real miss — a measurement confound). Bounding bench unconditionally
 * is a posture change that must ride its OWN opt-in knob + an A/B, not the default.
 *
 * A meter is minted ONLY when an operator opts into a cumulative and/or per-turn
 * cost ceiling via `QUANTA_BENCH_MAX_COST_USD` / `QUANTA_BENCH_MAX_COST_PER_TURN_USD`
 * (positive USD, fractional allowed). Once opted in, it ALSO carries the canonical
 * batch dials (minus the preset's default dollar cap) so a cost-capped run is fully
 * bounded, and the SAME L0/L2/L3 machinery engages: `emitUsage` ticks the priced
 * cost, the turn epilogue `checkExhausted` stops on the first tripped dial, and the
 * pre-flight refuses a guaranteed-breach call. A caller-provided
 * `budgetMeterFactory` still wins. Exported for direct unit testing. */
export const benchBudgetMeterFromEnv = (
  env: Record<string, string | undefined>,
): BudgetMeter | undefined => {
  const posUsd = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number.parseFloat(raw.trim())
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const maxCostUsd = posUsd(env.QUANTA_BENCH_MAX_COST_USD)
  const maxCostPerTurnUsd = posUsd(env.QUANTA_BENCH_MAX_COST_PER_TURN_USD)
  // No operator cost cap ⇒ NO meter (byte-identical default-OFF). The batch dials
  // engage only as a side-effect of an opted-in cost cap below.
  if (maxCostUsd === undefined && maxCostPerTurnUsd === undefined) return undefined
  const { maxCostUsd: _defaultBatchCostCap, ...batchDialsSansDefaultCost } = BUDGET_PRESETS.batch
  return new BudgetMeter({
    dials: {
      ...batchDialsSansDefaultCost,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(maxCostPerTurnUsd !== undefined ? { maxCostPerTurnUsd } : {}),
    },
  })
}

/**
 * Compose the user-message array for a bench agent config — the prompt text
 * (base task + the agentless/repro/closure/multi-site hint sections) wrapped as
 * user messages. Extracted verbatim from `buildConfig` so that closure stays
 * under the god-function line cap; behaviour-identical — every hint stays
 * conditionally spread (byte-identical when absent), and the prompt-composition
 * methodology comments move here with the code they describe.
 */
const buildAgentMessages = (args: {
  instance: Instance
  sandbox: string
  opt: BenchPosture
  seedMsg?: string
  precomputedHint?: string
  reproHint?: string
  closureHint?: string
  chaMultisiteSteer?: string
}): ReturnType<typeof userPromptMessages> => {
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
  // that philosophy verbatim-in-spirit. Default OFF; opt-in via
  // QUANTA_BENCH_SIMPLICITY (unvalidated absorbed steer — A/B before promoting).
  // Earlier DEFAULT-ON claim (2026-06-19) lacked an in-repo A/B harness, so the
  // steer is now opt-in to keep it cleanly measurable; OFF ⇒ "" ⇒ byte-identical
  // prompt restoring the pre-absorption baseline.
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
    instance: args.instance,
    sandbox: args.sandbox,
    opt: args.opt,
    ...(args.seedMsg !== undefined ? { seedMsg: args.seedMsg } : {}),
    ...(args.precomputedHint !== undefined ? { precomputedHint: args.precomputedHint } : {}),
    ...(args.reproHint !== undefined ? { reproHint: args.reproHint } : {}),
    ...(args.closureHint !== undefined ? { closureHint: args.closureHint } : {}),
    ...(args.chaMultisiteSteer !== undefined ? { chaMultisiteSteer: args.chaMultisiteSteer } : {}),
  })
  return userPromptMessages(text)
}

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
  // Prompt + hint composition (agentless / repro / closure / multi-site steer)
  // lives in `buildAgentMessages` to keep this closure under the god-function
  // line cap — behaviour-identical, every hint conditionally spread.
  const messages = buildAgentMessages({
    instance,
    sandbox,
    opt,
    ...(seedMsg !== undefined ? { seedMsg } : {}),
    ...(precomputedHint !== undefined ? { precomputedHint } : {}),
    ...(reproHint !== undefined ? { reproHint } : {}),
    ...(closureHint !== undefined ? { closureHint } : {}),
    ...(chaMultisiteSteer !== undefined ? { chaMultisiteSteer } : {}),
  })
  const budgetMeter = deps.budgetMeterFactory?.() ?? benchBudgetMeterFromEnv(process.env)
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
    // A2 (jul-3 strategy-audit): batch driver runs are graded by an external
    // harness — declare the SWE surface profile so the system prompt carries the
    // `batch` pack (R-NO-EXPLORE-OVER-EDIT: stop exploring once you have a coherent
    // edit + verify step). Routed through the SurfaceProfile seam (jul-4) rather
    // than a raw `buildSystemPrompt({ promptPack: "batch" })` so bench declares its
    // surface like every other entry point — byte-identical to the prior call.
    // VERIFY axis (jul-4, default-OFF `QUANTA_BENCH_REPRODUCE_FIRST`): on a SWE
    // instance the knob adds the reproduce-first rule (reproduce the reported
    // failure → fix → rerun). Absent ⇒ SWE_SURFACE_PROFILE unchanged ⇒ byte-identical.
    // Measure-first (flat A/B ⇒ revert). CONFOUND WARNING: do NOT A/B this together with
    // the reproTestK repro-hint path (`prepareReproTest` writes reproduce_issue.py + threads
    // REPRO_HINT_MESSAGE) — that tells the model a reproduction ALREADY EXISTS, which overlaps
    // /contradicts this "write your own reproduction" rule. Hold reproTestK fixed (ideally 0)
    // when measuring this lever.
    system: composeSystemPromptForSurface(
      instance.swebench !== undefined && gateOn(process.env, "QUANTA_BENCH_REPRODUCE_FIRST")
        ? { ...SWE_SURFACE_PROFILE, verifyStrategy: "reproduce-first" }
        : SWE_SURFACE_PROFILE,
      { cwd: sandbox },
    ),
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
    // Test-scope guard (RCA 2026-06-19, django-13417). ENFORCING — when ON, the
    // dispatch pre-flight `consultTestScope` DENIES any mutating tool call whose
    // target is a test path (edit/write/apply_patch); source-only is a benchmark
    // invariant for ALL real swebench modes, not just full execution. This keeps
    // the agent from editing existing tests, chasing its own modified tests, or
    // gaming PASS_TO_PASS / the oracle. DEFAULT-ON (a defensible measurement
    // safeguard): the guard is enforced for every swebench instance unless
    // `QUANTA_BENCH_PROTECT_TESTS=0` is set, which disables it (advisory baseline).
    // Guard fields (verifyGuard / lspPrewarm / protectTestPaths /
    // evictLspPoolOnEnd) are NOT set here — `reconcileBenchGuards` is the single
    // authority, applied AFTER knobs below (jun-28 SSOT: no driver/knob double-set).
    // Bench A/B opt-ins (default-OFF; all unset ⇒ keys omitted entirely,
    // exactOptionalPropertyTypes-friendly, AgentConfig byte-identical).
  }
  const knobApplied = applyBenchKnobs(baseConfig, state, { instance, sandbox })
  const guarded = reconcileBenchGuards(knobApplied, {
    instance,
    opt,
    signal,
    mustPass: readKnobValue(state, "must-pass", isMustPassOverride),
  })
  const noPatchApplied = opt.noPatchBreaker
    ? wireNoPatchBreaker(guarded, opt.noPatchForceFraction)
    : guarded
  const localizePhase = localizePhaseConfigOf(opt, chaMultisiteSteer)
  return wireOptionalAgentPorts(
    wirePostureAgentPorts({ config: noPatchApplied, opt, localizePhase }),
    process.env,
  )
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
