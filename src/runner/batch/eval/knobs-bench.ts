/**
 * Bench-surface knob resolution helper.
 *
 * Thin wrapper around the `@/runner/knobs` framework that:
 *   1. Materialises the bench-surface knob registry view via
 *      `knobsForSurface("bench")`.
 *   2. Resolves each knob's layered value via `resolveKnobs`. ONLY the env-var
 *      layer is fed in — bench DELIBERATELY skips cli / session / config-file
 *      layers (measurement integrity: a stale dev shell or user config file
 *      must NEVER silently change a benchmark result; the operator opts in by
 *      exporting a `QUANTA_BENCH_*` env var explicitly). The preset layer is
 *      enabled (a benchmark sweep wants `--knobs-preset agentless-full` etc.).
 *   3. Returns a `BenchKnobState` carrying the surface registry, the resolved
 *      values, the per-id source map for telemetry, the optional preset name,
 *      and the list of registered-but-inactive knob ids.
 *
 * Byte-identical invariant:
 *   - Empty registry (knob files not yet imported) ⇒ `values` is an empty
 *     `Map`, `inactive` is `[]`, `applyKnobs(baseConfig, ...)` is a no-op
 *     (proved in `apply.ts`).
 *   - Any registered knob whose `parse` rejects its env value falls through to
 *     the next layer (preset, then `default`). A knob with no value in any
 *     layer is reported as `inactive` and NOT applied.
 *
 * The helper is split out from `driver.ts` so unit tests can pin the resolver
 * contract independently of `buildConfig`.
 */

import type { AgentConfig, BranchSearchConfig } from "@/agent"
import {
  type ApplyContext,
  applyKnobs,
  type Knob,
  type KnobValueMap,
  knobsForSurface,
  resolveKnobs,
} from "@/runner/knobs"
import type { BenchInLoopExecModeKnob } from "@/runner/knobs/knobs/bench-in-loop-exec"
import type { LocalizeBudgetValue } from "@/runner/knobs/knobs/localize-budget"
import type { SelectorModeKnob } from "@/runner/knobs/knobs/selector-mode"
import type { VerifySelectLlmRiskGateMode } from "@/runner/knobs/knobs/verify-select-llm-risk-gate"
import type { VerifySelectRegressionMode } from "@/runner/knobs/knobs/verify-select-regression"
import type { VerifySelectReproMode } from "@/runner/knobs/knobs/verify-select-repro"
// Side-effect: registers all bench/agent knobs so knobsForSurface("bench")
// returns a populated map. Safe to import multiple times (module cached once).
import "@/runner/knobs/knobs"
import { gateDisabled, gateOn } from "@/shared"

export interface BenchKnobState {
  /** Bench-surface registry view (frozen by the framework). */
  readonly knobs: ReadonlyMap<string, Knob>
  /** Layered-resolution result, in registry iteration order. */
  readonly values: KnobValueMap
  /** Resolved preset name. Precedence: `QUANTA_BENCH_PRESET` >
   *  `QUANTA_BENCH_SOTA=1` alias (→ `agentless-v1`) > legacy `QUANTA_KNOBS_PRESET`. */
  readonly preset: string | undefined
  /** Registered-but-inactive knob ids (no value resolved + no default). */
  readonly inactive: readonly string[]
  /** #5: env vars set to a PRESENT, non-empty value whose parser REJECTED it
   *  (out of domain / malformed) so it silently fell through to the default.
   *  Distinct from `inactive` (genuinely unset / intentionally empty): a stray
   *  `QUANTA_BENCH_REGRESSION_MAX_TESTS=300` is a MISCONFIG that would otherwise
   *  run the wrong config while the report looked clean. Surfaced loudly so the
   *  report SSOT shows `REJECTED(env="300")`, not a phantom default. */
  readonly rejected: readonly {
    readonly id: string
    readonly envKey: string
    readonly raw: string
  }[]
}

export interface ResolveBenchKnobsArgs {
  /** Process env snapshot. Required — the helper does NOT read `process.env`
   *  itself (closed-port contract). */
  readonly envVars: NodeJS.ProcessEnv
}

/** Materialise the bench-surface knob registry + resolved values.
 *
 *  The function is referentially transparent over `envVars` once the
 *  registry is fixed: same envVars ⇒ same `BenchKnobState` (proved by the
 *  framework's `resolveKnobs` being a pure function over its inputs). */
export const resolveBenchKnobs = (args: ResolveBenchKnobsArgs): BenchKnobState => {
  const knobs = knobsForSurface("bench")
  // Preset selector precedence (value-taking, NOT on/off):
  //   1. QUANTA_BENCH_PRESET=<name>      — the canonical selector.
  //   2. QUANTA_BENCH_SOTA=1             — back-compat alias for `agentless-v1`.
  //   3. QUANTA_KNOBS_PRESET=<name>      — legacy framework-wide spelling.
  // Empty string at any layer is treated as unset (whitespace-safe handled by
  // the trim below before the resolver sees it).
  const sotaAlias = gateOn(args.envVars, "QUANTA_BENCH_SOTA") ? "agentless-v1" : undefined
  const rawPreset =
    args.envVars.QUANTA_BENCH_PRESET ?? sotaAlias ?? args.envVars.QUANTA_KNOBS_PRESET
  const preset = rawPreset !== undefined && rawPreset.trim() !== "" ? rawPreset.trim() : undefined
  const resolveArgs: Parameters<typeof resolveKnobs>[0] = {
    surface: "bench",
    knobs,
    envVars: args.envVars,
    ...(preset !== undefined ? { preset } : {}),
  }
  const values = resolveKnobs(resolveArgs)
  const inactive: string[] = []
  const rejected: { id: string; envKey: string; raw: string }[] = []
  for (const [id, knob] of knobs) {
    if (values.has(id)) continue
    // #5: a present, non-empty env raw whose own parser rejects it is a MISCONFIG
    // (silent-default footgun), NOT an unset knob. Classify it as `rejected` and
    // keep it OUT of `inactive`, so the report cleanly separates "never set" from
    // "set wrong". The resolver stays pure — this detection is the surface's job;
    // only the env layer is inspected.
    //
    // ONLY VALUED knobs (`unit` defined — numeric/structured) have a "rejected"
    // state. Unit-less boolean knobs either resolve to an explicit boolean
    // (`true` or, for knobs that support it, `false`) or intentionally fall
    // through to unset; we do not classify their raws as misconfigs here because
    // the parser defines the knob-local vocabulary.
    const raw = args.envVars[knob.envKey]
    if (
      knob.unit !== undefined &&
      raw !== undefined &&
      raw.trim() !== "" &&
      knob.parse(raw) === undefined
    ) {
      rejected.push({ id, envKey: knob.envKey, raw })
      continue
    }
    inactive.push(id)
  }
  return {
    knobs,
    values,
    preset,
    inactive,
    rejected,
  }
}

/** Fold the resolved bench knobs into `base`. Convenience wrapper around
 *  `applyKnobs` so the driver doesn't have to thread the registry separately.
 *
 *  When `state.values` is empty the framework's `applyKnobs` returns `base`
 *  unchanged (proved in `apply.ts`) — this preserves the byte-identical
 *  contract for the empty-registry case. */
export const applyBenchKnobs = (
  base: AgentConfig,
  state: BenchKnobState,
  ctx: Omit<ApplyContext, "surface">,
): AgentConfig =>
  applyKnobs(base, state.knobs, state.values, {
    surface: "bench",
    ...(ctx.instance !== undefined ? { instance: ctx.instance } : {}),
    ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
  })

/** Knob-id → value extractor with strict shape guard. Returns the parsed value
 *  when the knob is active and the value matches the predicate, else
 *  `undefined`. The async bench-orchestration code (issue-hint / repro-test
 *  pre-compute) consumes this. */
export const readKnobValue = <T>(
  state: BenchKnobState,
  id: string,
  guard: (v: unknown) => v is T,
): T | undefined => {
  const kv = state.values.get(id)
  if (kv === undefined) return undefined
  return guard(kv.value) ? kv.value : undefined
}

/** Render a knob value with its UNIT so a bare "5" never appears. Number + unit
 *  ⇒ "5 turns"; a knob with no unit is a boolean flag ⇒ "on"/"off"; a non-number value
 *  (e.g. issue-hint mode) ⇒ "agentless (mode)" when unit is "mode", else the
 *  raw value. Pure — exported so the report AND any preset table share one SSOT. */
export const formatKnobValue = (value: unknown, unit: string | undefined): string => {
  if (unit === undefined) return value === false ? "off" : "on" // unit-less ⇒ boolean ON/OFF flag
  if (typeof value === "number") return `${value} ${unit}`
  // Some knobs parse to a wrapper object whose meaningful quantity is a single
  // numeric field (localize-phase ⇒ {phase1Turns:5}, repro-test ⇒ {samples:5}).
  // Pull the first numeric field so the display is "5 turns", not "[object…]".
  if (value !== null && typeof value === "object") {
    const num = Object.values(value as Record<string, unknown>).find((v) => typeof v === "number")
    if (typeof num === "number") return `${num} ${unit}`
  }
  return `${String(value)} (${unit})` // string-valued (e.g. issue-hint mode)
}

/** Telemetry projection: id → { value, unit, display, source } for the report.
 *  `unit` + `display` make every number self-describing (no bare "5"). Plain
 *  object (not Map) so it serialises cleanly through `JSON.stringify`. */
export const knobsForReport = (
  state: BenchKnobState,
): Record<
  string,
  { value: unknown; unit: string | undefined; display: string; source: string }
> => {
  const out: Record<
    string,
    { value: unknown; unit: string | undefined; display: string; source: string }
  > = {}
  for (const [id, kv] of state.values) {
    const unit = state.knobs.get(id)?.unit
    out[id] = { value: kv.value, unit, display: formatKnobValue(kv.value, unit), source: kv.source }
  }
  return out
}

/** Bench issue-hint mode tri-state. `"off"` = no hint; `"regex"` = legacy
 *  verbatim-evidence extractor; `"agentless"` = LLM Stage-1 localization. */
export type BenchIssueHintMode = "off" | "regex" | "agentless"
export type BenchInLoopExecMode = "full" | "repro-only" | "off"

/**
 * The bench A/B posture, derived ENTIRELY from a resolved {@link BenchKnobState}
 * (preset + env layered) — NOT from raw `process.env`. This is the SINGLE
 * source that drives BOTH the agent config (`buildConfig`) and the telemetry
 * report, which makes "report ≠ applied" (the old split-brain report-lie)
 * structurally impossible: the same resolver feeds both.
 *
 * Every field maps to a registered bench framework knob:
 *   - config-fold knobs (lsp/subagent/skills/localize-phase/branch-search) →
 *     the corresponding AgentConfig slot.
 *   - out-of-band knobs (issue-hint / issue-hint-expected-actual / repro-test /
 *     retry-transient) → consumed by the driver's hint/repro/retry orchestration.
 *   - runtime-config-bridged knobs (read-outline / test-runner / repo-map) →
 *     `liveOverrides` envKeys the driver pushes into `setKnobOverride` so the
 *     wire-time `runtimeConfig()` read picks them up.
 *
 * Byte-identical fence: with no preset and no `QUANTA_BENCH_*` env, `state`
 * carries no values, so every field is OFF/undefined and `liveOverrides` is
 * empty — identical to the pre-preset all-OFF posture.
 */
export interface BenchPosture {
  readonly lspNav: boolean
  /**
   * jun-26 (REPORT-jun26-tool-impl-vs-frontier §4.5) — register the CHEAP /
   * index-backed LSP-nav tier (definition / hover / type_definition /
   * document_symbol / workspace_symbol / incoming·outgoing_calls / code_action /
   * format / signature_help) WITHOUT the two measured-intractable members
   * (`lsp_references` / `lsp_implementation`). DEFAULT-ON gated-flip: from the
   * `lsp-cheap` knob, which defaults true; `QUANTA_BENCH_LSP_CHEAP=0/off/false`
   * suppresses it for a byte-identical legacy (empty nav) surface. Ignored when
   * the full `lspNav` is on (the full `lspNavToolList` already supersets it,
   * including the expensive members behind the explicit opt-in).
   */
  readonly lspNavCheap: boolean
  readonly subagent: AgentConfig["subagent"] | undefined
  readonly skills: AgentConfig["skills"] | undefined
  readonly localizePhase: AgentConfig["localizePhase"] | undefined
  readonly branchSearch: BranchSearchConfig | undefined
  readonly issueHint: boolean
  readonly issueHintMode: BenchIssueHintMode
  readonly issueHintExpectedActual: boolean
  /** Agentless §3.3.1 reproduction-test K (undefined ⇒ no repro pre-compute). */
  readonly reproTestK: number | undefined
  /** jun-22 config-extraction: per-repro-script exec timeout (ms). undefined ⇒ 60s. */
  readonly reproExecTimeoutMs: number | undefined
  /** jun-22 config-extraction: agentless one-shot localizer breadth dials
   *  (topK/maxTreeChars/maxFiles). undefined ⇒ hardcoded defaults. */
  readonly localizeBudget: LocalizeBudgetValue | undefined
  /** jun-22 config-extraction: no-patch breaker fire fraction. undefined ⇒ 0.8. */
  readonly noPatchForceFraction: number | undefined
  /** jun-22 config-extraction: max discovered regression witnesses run. undefined ⇒ 12. */
  readonly regressionMaxTests: number | undefined
  /** jun-19 #10999 under-fix lever: ON ⇒ the repro prompt gets the
   *  ADVERSARIAL-coverage block so a shallow happy-path fix stays RED. */
  readonly adversarialRepro: boolean
  /** repro-doubt steer active. The knob folds into AgentConfig at runtime,
   *  but the score-label authority layer needs a posture-level bit so report
   *  contamination accounting does not re-read raw knob state elsewhere. */
  readonly reproDoubt: boolean
  /** Transient-failure retry cap (undefined ⇒ single attempt). */
  readonly retryTransient: number | undefined
  /**
   * Closure-driven repair budget (max rounds for the gate's verify-first path).
   * undefined ⇒ the preset declares no repair ⇒ the driver only enters the
   * verify phase if the caller set `deps.repair` (the `--repair-rounds` CLI
   * override). PRESENT ⇒ the ClosureBundle becomes an executor: when the gate
   * decides `verify`, repair rounds re-run the primary rail and re-seed the
   * agent. From the `closure-repair` knob.
   */
  readonly repairRounds: number | undefined
  /**
   * Verify-and-select candidate count (N). PRESENT ⇒ runInstance generates N
   * closure-diversity-seeded candidates and submits the VerificationBundle's
   * pick instead of a single pass. From the `verify-select` knob. Unset ⇒
   * undefined ⇒ byte-identical single-pass.
   */
  readonly verifySelectN: number | undefined
  /**
   * Verify-and-select candidate-generation concurrency (max in-flight). From
   * the `verify-select-concurrency` knob. Unset ⇒ undefined ⇒ runSelection runs
   * candidates SEQUENTIALLY (byte-identical). >1 requires isolated generate.
   */
  readonly verifySelectConcurrency: number | undefined
  /** Sequential verify-select cost guard: stop after the first clean
   *  owner-scoped candidate with explicit hard-positive regression/resolved
   *  authority instead of always burning all N. Fail-open null gates never stop
   *  early. */
  readonly verifySelectEarlyAccept: boolean
  /** Adaptive strict selector: candidate 0 is generated first and submitted
   *  immediately when the static public-issue/patch risk gate stays green.
   *  Risky candidate 0 expands to the remaining verify-select candidates and
   *  lets late selection decide. */
  readonly verifySelectRiskGate: boolean
  /** Counterfactual candidate seed: when cand0 trips the structural risk gate,
   *  generate cand1 from a counterfactual minimal-alternative seed bound to the
   *  structural contracts. Off by default. */
  readonly verifySelectCounterfactual: boolean
  /** Optional LLM semantic risk gate layered on top of the structural gate.
   *  `shadow` records advisory telemetry only; `on` expands fail-closed. */
  readonly verifySelectLlmRiskGate: VerifySelectLlmRiskGateMode | undefined
  /** v4 clean submit rail: only candidates with positive executed public proof
   *  may be submitted. Contracts/family/minimality remain advisory or
   *  structural ranking signals only. */
  readonly verifySelectProofRequired: boolean
  /** Selector authority mode. `clean` = only executable/structural hard gates
   *  decide selection; `research` = legacy heuristic gates additionally allowed.
   *  Defaults to `"research"` (knob unset ⇒ projected research) so existing
   *  presets/runs stay byte-identical. */
  readonly selectorMode: "clean" | "research"
  /**
   * Verify-and-select regression hard-signal source. undefined preserves the
   * existing eval-only PASS_TO_PASS behavior when available; explicit `discovered`
   * is the no-oracle live-problem path; `off` is the ablation.
   */
  readonly verifySelectRegression: VerifySelectRegressionMode | undefined
  /**
   * Verify-and-select generated repro-consensus mode. undefined preserves legacy
   * hard-gate behavior; `positive` makes self-generated repros soft-only; `off`
   * removes the signal.
   */
  readonly verifySelectRepro: VerifySelectReproMode | undefined
  /**
   * Execution authority mode (default `"full"` = today's byte-identical
   * behavior). `"full"` runs repo tests in-loop; `"repro-only"` allows a small
   * issue reproducer but still forbids full repo-test execution; `"off"` is
   * pure edit-and-submit. This field is the authoritative switch for prompt,
   * verifyGuard, repair, and repro-hint wiring.
   */
  readonly inLoopExecMode: BenchInLoopExecMode
  /**
   * Back-compat boolean projection: TRUE only for `"full"`. Existing callers
   * that mean "broad repo-test execution allowed" can keep reading this.
   */
  readonly inLoopExec: boolean
  /** envKeys to push into the runtime-config live-override store (read at wire
   *  time): a subset of QUANTA_READ_OUTLINE / QUANTA_TEST_RUNNER / QUANTA_REPO_MAP. */
  readonly liveOverrides: readonly string[]
  /** Resolved preset name (telemetry/debug; undefined when none selected). */
  readonly preset: string | undefined
  /** True when the SOTA super-preset (agentless-v1) is active — via
   *  QUANTA_BENCH_SOTA=1 alias or QUANTA_BENCH_PRESET=agentless-v1.
   *
   *  DEAD FIELD (bugbash #14): zero production consumers. The behavioral
   *  posture fields (lspNav / localizePhase / issueHintMode / …) are each
   *  derived from their INDIVIDUAL resolved knob value via `readKnobValue`,
   *  NOT from `sotaOn` — so nothing branches on this flag at runtime
   *  (`grep -rn sotaOn src` outside this file finds nothing). The only
   *  readers are the tautological assertions in
   *  `tests/unit/bench-sota-preset-hellgate.test.ts` (SOTA-4/SOTA-5), which
   *  is owned by a different bugbash group. Removal is therefore BLOCKED on
   *  that group dropping those assertions; until then the field is retained
   *  to keep the cross-group hellgate green (do NOT delete here in isolation).
   *  NOTE it also mis-reports: agentless-v1 supersets (v1-nosteer / v2 / v3)
   *  resolve `sotaOn=false` despite carrying the same posture, so any future
   *  consumer must read the posture fields, not this label. */
  readonly sotaOn: boolean
  /** T-201: typed FaultEvidencePacket (bounded owner-context, no raw source). */
  readonly faultEvidence: boolean
  /** T-301: typed VerificationPlan (primary rail + typed successPredicates). */
  readonly verificationPlan: boolean
  /** T-302: primary-rail enforcement + commit-vs-verify gate + repair admission. */
  readonly primaryRail: boolean
  /** T-401: patch hygiene gate (stray-file deny, owner-outside telemetry). */
  readonly patchHygiene: boolean
  /** jun-19: minimal-edit admission — emit PatchBudget over the diff (#13417). */
  readonly patchBudget: boolean
  /** jun-20: hard minimal-edit admission — do not submit over-budget final patches. */
  readonly patchBudgetStrict: boolean
  /** jun-19: K-of-N RESOLVED gate — re-run the reproducing repro set on the
   *  patched tree and majority-vote "Issue resolved" (removes the false-NEGATIVE
   *  single-script oracle). Armed by the driver only when repro-test produced a
   *  reproducing set; empty set ⇒ byte-identical legacy gate. */
  readonly reproVote: boolean
  /** T-501: post-localization commit rail + no-patch exhausted verdict. */
  readonly noPatchBreaker: boolean
  /** T-601: multi-owner escalation decision (closed reason taxonomy). */
  readonly repairEscalation: boolean
  /** gap-B: spec-fidelity steer (minimal-literal-fix; fires only when the issue
   *  declares an exact expected output). */
  readonly specFidelitySteer: boolean
  /** T2b (jun-24 astropy-13033): spec-fidelity INVARIANT. When the issue declares
   *  an exact expected output, wire a PUBLIC-issue-text declared-expected port so
   *  the existing `hard:declaredExpectedMatch=false` veto may fire in CLEAN mode
   *  for candidates that invent a different message shape. Default-OFF ⇒ the
   *  clean-mode declared-expected gate stays disabled (byte-identical). */
  readonly specFidelityInvariant: boolean
  /** H1 (jun-24 astropy-13033 residual): dynamic-message-matcher. Layers on
   *  specFidelityInvariant — when on, the declared-expected matcher compares a
   *  candidate's dynamic-format (f-string / `%`-format / `.format`) FIXED skeleton
   *  against the public declared value instead of blanket-abstaining, so a WRONG
   *  dynamic message can be vetoed while a skeleton-consistent (correct) dynamic fix
   *  still abstains. Default-OFF ⇒ every template literal abstains (byte-identical). */
  readonly dynamicMessageMatcher: boolean
  /** T3 (jun-24): forward-localize on the deeper_localize adaptive route — trace
   *  the prior candidate's edited symbols to their consumer call-sites and widen
   *  the next pass's owner evidence. Default-OFF ⇒ deeper_localize stays a no-op. */
  readonly forwardLocalize: boolean
  /** jun-24 django-11138: when a localized Python method has sibling overrides
   *  under the same base class, append a concrete CHA-derived multi-site steer
   *  naming each sibling file:line. */
  readonly chaMultisiteSteer: boolean
  /** jun-25: generalize the CHA contract-fallback sibling rule from the legacy
   *  django path hardcode to a structural parallel-sibling rule (superset of the
   *  django match; byte-identical for django). Only meaningful with
   *  `chaMultisiteSteer`. */
  readonly chaMultisiteGeneral: boolean
  /** G2 (jun-24 astropy-13033): paired-control repro admission. When true, a
   *  reproducing self-test is admitted only if its paired control tests passed
   *  on the base tree (`baseControl === "green"`); env/import-broken false-reds
   *  (`"red"`/`"absent"`) are rejected. Default-OFF ⇒ the legacy
   *  `outcome === "reproduced"` filter is byte-identical. Threaded into
   *  `selectReproTest`'s `pairedControl` option by the bench driver. */
  readonly pairedControl: boolean
  /** G1 (jun-24 cross-vendor diversity): route verify-select candidate i to
   *  vendor lane (i mod V) over the injected `deps.llmLanes` provider-distinct
   *  LLM ports, decorrelating the N-candidate generation set so the selector
   *  picks across vendors/families instead of N correlated samples of one model.
   *  Default-OFF ⇒ every candidate stays on `deps.llm` (byte-identical). The
   *  resolution helper is `resolveLaneLlm` (driver.ts); the wire-site read is
   *  `buildConfig` (`laneLlm ?? deps.llm`). */
  readonly modelLaneDiversity: boolean
}

const isTrue = (v: unknown): v is true => v === true
const isFalse = (v: unknown): v is false => v === false
const isBoolean = (v: unknown): v is boolean => v === true || v === false
const isInLoopExecMode = (v: unknown): v is BenchInLoopExecModeKnob =>
  v === "full" || v === "repro-only" || v === "off"
const isNumber = (v: unknown): v is number => typeof v === "number"
const isLocalizeValue = (v: unknown): v is { phase1Turns: number } =>
  typeof v === "object" &&
  v !== null &&
  "phase1Turns" in v &&
  typeof (v as { phase1Turns: unknown }).phase1Turns === "number"
const isLocalizeBudgetValue = (v: unknown): v is LocalizeBudgetValue =>
  typeof v === "object" && v !== null && ("topK" in v || "maxTreeChars" in v || "maxFiles" in v)
const isBranchValue = (v: unknown): v is { defaultN: number; config: BranchSearchConfig } =>
  typeof v === "object" && v !== null && "config" in v
const isIssueMode = (v: unknown): v is "agentless" | "regex" => v === "agentless" || v === "regex"
const isReproValue = (v: unknown): v is { samples: number } =>
  typeof v === "object" &&
  v !== null &&
  "samples" in v &&
  typeof (v as { samples: unknown }).samples === "number"
const isRepoMapValue = (v: unknown): v is { enabled: true } =>
  typeof v === "object" && v !== null && (v as { enabled?: unknown }).enabled === true
const isVerifySelectRegressionMode = (v: unknown): v is VerifySelectRegressionMode =>
  v === "discovered" || v === "gold" || v === "off"
const isVerifySelectReproMode = (v: unknown): v is VerifySelectReproMode =>
  v === "hard" || v === "positive" || v === "off"
const isVerifySelectLlmRiskGateMode = (v: unknown): v is VerifySelectLlmRiskGateMode =>
  v === "shadow" || v === "on"
const isSelectorMode = (v: unknown): v is SelectorModeKnob => v === "clean" || v === "research"

// Bench LSP-nav precedence is intentionally asymmetric:
//   1. resolved `lsp` knob boolean (preset + env layered)
//   2. legacy CLI alias `QUANTA_LSP_TOOLS=full` ONLY when the knob is unset
// So an explicit env-layer `QUANTA_BENCH_LSP=off` resolves to `false` and
// suppresses both a preset `lsp:1` and the legacy alias.
const resolveLspNav = (state: BenchKnobState, env: NodeJS.ProcessEnv): boolean =>
  readKnobValue(state, "lsp", isBoolean) ?? env.QUANTA_LSP_TOOLS === "full"

// jun-26 (REPORT-jun26-tool-impl-vs-frontier §4.5) — cheap LSP-nav tier gate.
// DEFAULT-ON gated-flip: registers the index-backed / call-graph nav members
// (NOT the measured-intractable references/implementation). Precedence:
//   1. resolved `lsp-cheap` knob boolean (preset + env layered) wins outright —
//      an explicit `QUANTA_BENCH_LSP_CHEAP=1` re-enables the cheap tier even
//      when the full `lsp` gate is explicitly off.
//   2. else: an EXPLICIT full-off (`QUANTA_BENCH_LSP=off/0/false`, the existing
//      "I want NO LSP nav" kill-switch) ALSO suppresses the cheap tier — the
//      operator's intent is no nav, not just no references/implementation.
//   3. else DEFAULT-ON, suppressed only by the `QUANTA_BENCH_LSP_CHEAP`
//      kill-switch (`0`/`off`/`false`) → byte-identical legacy (empty nav).
// The driver IGNORES this bit when the full `lspNav` is on (the full nav list
// already supersets the cheap tier), so the two never double-register.
const resolveLspNavCheap = (
  state: BenchKnobState,
  env: NodeJS.ProcessEnv,
  lspExplicitOff: boolean,
): boolean => {
  const knob = readKnobValue(state, "lsp-cheap", isBoolean)
  if (knob !== undefined) return knob
  if (lspExplicitOff) return false
  return !gateDisabled(env, "QUANTA_BENCH_LSP_CHEAP")
}

// True iff the full `lsp` gate is EXPLICITLY turned off (knob `false`, OR the
// env kill-switch `QUANTA_BENCH_LSP=off/0/false`). Distinct from "merely unset":
// an unset `lsp` leaves the default-OFF full posture but keeps the cheap tier's
// DEFAULT-ON. Only an explicit off is treated as "no LSP nav at all".
const lspNavExplicitlyOff = (state: BenchKnobState, env: NodeJS.ProcessEnv): boolean =>
  readKnobValue(state, "lsp", isFalse) === false || gateDisabled(env, "QUANTA_BENCH_LSP")

const resolveLocalizePhase = (
  state: BenchKnobState,
  lspNav: boolean,
): AgentConfig["localizePhase"] | undefined => {
  const lp = readKnobValue(state, "localize-phase", isLocalizeValue)
  if (lp === undefined || lp.phase1Turns <= 0) return undefined
  const lspGroundingSteer = lspNav && readKnobValue(state, "lsp-steer", isFalse) !== false
  return {
    phase1Turns: lp.phase1Turns,
    ...(lspGroundingSteer ? { lspGroundingSteer: true } : {}),
  }
}

const resolveLiveOverrides = (state: BenchKnobState): string[] => {
  const liveOverrides: string[] = []
  if (readKnobValue(state, "read-outline", isTrue) === true)
    liveOverrides.push("QUANTA_READ_OUTLINE")
  if (readKnobValue(state, "test-runner", isTrue) === true) liveOverrides.push("QUANTA_TEST_RUNNER")
  if (readKnobValue(state, "repo-map", isRepoMapValue) !== undefined)
    liveOverrides.push("QUANTA_REPO_MAP")
  return liveOverrides
}

/**
 * Project a resolved {@link BenchKnobState} into the {@link BenchPosture}.
 *
 * @param env  used ONLY for the legacy `QUANTA_LSP_TOOLS=full` alias (the same
 *             gate the CLI uses). The resolved `lsp` knob wins first, including
 *             explicit `false`; the alias is consulted only when that knob is
 *             unset. Every other field comes from `state` so preset values flow
 *             through.
 */
export const benchPostureFromState = (
  state: BenchKnobState,
  env: NodeJS.ProcessEnv,
): BenchPosture => {
  const lspNav = resolveLspNav(state, env)
  const lspNavCheap = resolveLspNavCheap(state, env, lspNavExplicitlyOff(state, env))
  const subagent = readKnobValue(state, "subagent", isTrue) === true ? {} : undefined
  const skills = readKnobValue(state, "skills", isTrue) === true ? {} : undefined
  const localizePhase = resolveLocalizePhase(state, lspNav)
  const bs = readKnobValue(state, "branch-search", isBranchValue)
  const branchSearch = bs !== undefined ? bs.config : undefined
  const issueHintMode: BenchIssueHintMode = readKnobValue(state, "issue-hint", isIssueMode) ?? "off"
  const issueHintExpectedActual =
    readKnobValue(state, "issue-hint-expected-actual", isTrue) === true
  const repro = readKnobValue(state, "repro-test", isReproValue)
  const reproExecTimeoutMs = readKnobValue(state, "repro-exec-timeout", isNumber)
  const localizeBudget = readKnobValue(state, "localize-budget", isLocalizeBudgetValue)
  const noPatchForceFraction = readKnobValue(state, "no-patch-force-fraction", isNumber)
  const regressionMaxTests = readKnobValue(state, "regression-max-tests", isNumber)
  const reproDoubt = state.values.has("repro-doubt")
  const retryTransient = readKnobValue(state, "retry-transient", isNumber)
  const repairRounds = readKnobValue(state, "closure-repair", isNumber)
  const verifySelectN = readKnobValue(state, "verify-select", isNumber)
  const verifySelectConcurrency = readKnobValue(state, "verify-select-concurrency", isNumber)
  const verifySelectEarlyAccept =
    readKnobValue(state, "verify-select-early-accept", isTrue) === true
  const verifySelectRiskGate = readKnobValue(state, "verify-select-risk-gate", isTrue) === true
  const verifySelectCounterfactual =
    readKnobValue(state, "verify-select-counterfactual", isTrue) === true
  const verifySelectLlmRiskGate = readKnobValue(
    state,
    "verify-select-llm-risk-gate",
    isVerifySelectLlmRiskGateMode,
  )
  const verifySelectProofRequired =
    readKnobValue(state, "verify-select-proof-required", isBoolean) ?? false
  const verifySelectRegression = readKnobValue(
    state,
    "verify-select-regression",
    isVerifySelectRegressionMode,
  )
  const verifySelectRepro = readKnobValue(state, "verify-select-repro", isVerifySelectReproMode)
  // Default-RESEARCH fence: unset ⇒ undefined ⇒ projected to "research" so
  // existing presets/runs are byte-identical. Only an explicit `clean` (env /
  // preset) flips the selector to hard-gate-only authority.
  const selectorMode = readKnobValue(state, "selector-mode", isSelectorMode) ?? "research"
  // Default-FULL fence: unset ⇒ undefined ⇒ `"full"` (today's exact behavior).
  const inLoopExecMode = readKnobValue(state, "bench-in-loop-exec", isInLoopExecMode) ?? "full"
  const inLoopExec = inLoopExecMode === "full"
  const liveOverrides = resolveLiveOverrides(state)
  // Proof-driven bench closure (jun-17) — each true ONLY when its knob resolves
  // `true` (env / preset), else false. Default-OFF ⇒ byte-identical when unset.
  //
  // EFFECT SITE for the closure knobs (bugbash #16): the knob declaration files
  // under `runner/knobs/knobs/<knob>.ts` are NOOP-apply (`(cfg) => cfg`); the
  // REAL read is right here — `readKnobValue` projects each into a behavioral
  // posture field that the driver consumes. So `knob-inventory.ts` points these
  // readSites at this file. Listed verbatim so the readSite-truthfulness ratchet
  // resolves them: QUANTA_BENCH_FAULT_EVIDENCE, QUANTA_BENCH_VERIFICATION_PLAN,
  // QUANTA_BENCH_PRIMARY_RAIL, QUANTA_BENCH_PATCH_HYGIENE,
  // QUANTA_BENCH_NO_PATCH_BREAKER, QUANTA_BENCH_REPAIR_ESCALATION,
  // QUANTA_BENCH_SPEC_FIDELITY_STEER, QUANTA_BENCH_CHA_MULTISITE_STEER,
  // QUANTA_BENCH_SPEC_FIDELITY_INVARIANT, QUANTA_BENCH_FORWARD_LOCALIZE,
  // QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER, QUANTA_BENCH_PAIRED_CONTROL,
  // QUANTA_BENCH_MODEL_LANE_DIVERSITY.
  const faultEvidence = readKnobValue(state, "fault-evidence", isTrue) === true
  const verificationPlan = readKnobValue(state, "verification-plan", isTrue) === true
  const primaryRail = readKnobValue(state, "primary-rail", isTrue) === true
  const patchHygiene = readKnobValue(state, "patch-hygiene", isTrue) === true
  const patchBudget = readKnobValue(state, "patch-budget", isTrue) === true
  const patchBudgetStrict = readKnobValue(state, "patch-budget-strict", isTrue) === true
  const reproVote = readKnobValue(state, "repro-vote", isTrue) === true
  const noPatchBreaker = readKnobValue(state, "no-patch-breaker", isTrue) === true
  const repairEscalation = readKnobValue(state, "repair-escalation", isTrue) === true
  const specFidelitySteer = readKnobValue(state, "spec-fidelity-steer", isTrue) === true
  const specFidelityInvariant = readKnobValue(state, "spec-fidelity-invariant", isTrue) === true
  const dynamicMessageMatcher = readKnobValue(state, "dynamic-message-matcher", isTrue) === true
  const forwardLocalize = readKnobValue(state, "forward-localize", isTrue) === true
  const pairedControl = readKnobValue(state, "paired-control", isTrue) === true
  const chaMultisiteSteer = readKnobValue(state, "cha-multisite-steer", isTrue) === true
  const chaMultisiteGeneral = readKnobValue(state, "cha-multisite-general", isTrue) === true
  const modelLaneDiversity = readKnobValue(state, "model-lane-diversity", isTrue) === true
  const adversarialRepro = readKnobValue(state, "adversarial-repro", isTrue) === true
  return {
    lspNav,
    lspNavCheap,
    subagent,
    skills,
    localizePhase,
    branchSearch,
    issueHint: issueHintMode !== "off",
    issueHintMode,
    issueHintExpectedActual,
    reproTestK: repro !== undefined ? repro.samples : undefined,
    reproExecTimeoutMs,
    localizeBudget,
    noPatchForceFraction,
    regressionMaxTests,
    adversarialRepro,
    reproDoubt,
    retryTransient,
    repairRounds,
    verifySelectN,
    verifySelectConcurrency,
    verifySelectEarlyAccept,
    verifySelectRiskGate,
    verifySelectCounterfactual,
    verifySelectLlmRiskGate,
    verifySelectProofRequired,
    selectorMode,
    verifySelectRegression,
    verifySelectRepro,
    inLoopExecMode,
    inLoopExec,
    liveOverrides,
    preset: state.preset,
    // DEAD telemetry field (bugbash #14) — see the `sotaOn` doc above; no
    // production consumer reads it. Retained only so the cross-group SOTA
    // hellgate stays green; safe to delete once that test drops it.
    sotaOn: state.preset === "agentless-v1",
    faultEvidence,
    verificationPlan,
    primaryRail,
    patchHygiene,
    patchBudget,
    patchBudgetStrict,
    reproVote,
    noPatchBreaker,
    repairEscalation,
    specFidelitySteer,
    specFidelityInvariant,
    dynamicMessageMatcher,
    forwardLocalize,
    pairedControl,
    chaMultisiteSteer,
    chaMultisiteGeneral,
    modelLaneDiversity,
  }
}
