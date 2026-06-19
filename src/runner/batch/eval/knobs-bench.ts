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
// Side-effect: registers all bench/agent knobs so knobsForSurface("bench")
// returns a populated map. Safe to import multiple times (module cached once).
import "@/runner/knobs/knobs"
import { gateOn } from "@/shared"

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
  for (const id of knobs.keys()) {
    if (!values.has(id)) inactive.push(id)
  }
  return {
    knobs,
    values,
    preset,
    inactive,
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
 *  ⇒ "5 turns"; a knob with no unit is a boolean flag ⇒ "on"; a non-number value
 *  (e.g. issue-hint mode) ⇒ "agentless (mode)" when unit is "mode", else the
 *  raw value. Pure — exported so the report AND any preset table share one SSOT. */
export const formatKnobValue = (value: unknown, unit: string | undefined): string => {
  if (unit === undefined) return "on" // unit-less ⇒ boolean ON/OFF flag
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
): Record<string, { value: unknown; unit: string | undefined; display: string; source: string }> => {
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
  readonly subagent: AgentConfig["subagent"] | undefined
  readonly skills: AgentConfig["skills"] | undefined
  readonly localizePhase: AgentConfig["localizePhase"] | undefined
  readonly branchSearch: BranchSearchConfig | undefined
  readonly issueHint: boolean
  readonly issueHintMode: BenchIssueHintMode
  readonly issueHintExpectedActual: boolean
  /** Agentless §3.3.1 reproduction-test K (undefined ⇒ no repro pre-compute). */
  readonly reproTestK: number | undefined
  /** jun-19 #10999 under-fix lever: ON ⇒ the repro prompt gets the
   *  ADVERSARIAL-coverage block so a shallow happy-path fix stays RED. */
  readonly adversarialRepro: boolean
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
   * In-loop test execution (default TRUE = today's byte-identical behavior).
   * TRUE ⇒ the agent is told to run the repo's tests inside its own solve loop
   * (SWEBENCH_DIRECTIVE + verifyGuard + repair phase + repro hint). FALSE ⇒
   * mini-swe posture: edit-and-submit, the grader runs the tests
   * (SWEBENCH_DIRECTIVE_NOEXEC, no verifyGuard, single-pass, no repro hint).
   * OFF ONLY when the `bench-in-loop-exec` knob explicitly resolves `false`.
   */
  readonly inLoopExec: boolean
  /** envKeys to push into the runtime-config live-override store (read at wire
   *  time): a subset of QUANTA_READ_OUTLINE / QUANTA_TEST_RUNNER / QUANTA_REPO_MAP. */
  readonly liveOverrides: readonly string[]
  /** Resolved preset name (telemetry/debug; undefined when none selected). */
  readonly preset: string | undefined
  /** True when the SOTA super-preset (agentless-v1) is active — via
   *  QUANTA_BENCH_SOTA=1 alias or QUANTA_BENCH_PRESET=agentless-v1. */
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
  /** WS1 mini-parity: thin the round-0 prompt — suppress the repro directive
   *  prose at round 0 (the agent's first attempt), re-attaching it only on
   *  repair rounds ≥1. The one-line closure (first-edit) hint is kept. */
  readonly round0Minimal: boolean
}

const isTrue = (v: unknown): v is true => v === true
const isFalse = (v: unknown): v is false => v === false
const isNumber = (v: unknown): v is number => typeof v === "number"
const isLocalizeValue = (v: unknown): v is { phase1Turns: number } =>
  typeof v === "object" &&
  v !== null &&
  "phase1Turns" in v &&
  typeof (v as { phase1Turns: unknown }).phase1Turns === "number"
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

/**
 * Project a resolved {@link BenchKnobState} into the {@link BenchPosture}.
 *
 * @param env  used ONLY for the legacy `QUANTA_LSP_TOOLS=full` alias (the same
 *             gate the CLI uses), OR-ed with the `lsp` knob. Every other field
 *             comes from `state` so preset values flow through.
 */
export const benchPostureFromState = (
  state: BenchKnobState,
  env: NodeJS.ProcessEnv,
): BenchPosture => {
  const lspNav = readKnobValue(state, "lsp", isTrue) === true || env.QUANTA_LSP_TOOLS === "full"
  const subagent = readKnobValue(state, "subagent", isTrue) === true ? {} : undefined
  const skills = readKnobValue(state, "skills", isTrue) === true ? {} : undefined
  const lp = readKnobValue(state, "localize-phase", isLocalizeValue)
  // LSP-nav grounding steer: DEFAULT-ON whenever nav tools are on — the steer is
  // what makes the model actually CALL go-to-def/find-refs (measured ~0% usage
  // without it). Coupled to `lspNav`; suppressed only by an explicit
  // `lsp-steer:off` (the A/B baseline). Pointless without nav, so nav-gated.
  const lspGroundingSteer = lspNav && readKnobValue(state, "lsp-steer", isFalse) !== false
  const localizePhase =
    lp !== undefined
      ? { phase1Turns: lp.phase1Turns, ...(lspGroundingSteer ? { lspGroundingSteer: true } : {}) }
      : undefined
  const bs = readKnobValue(state, "branch-search", isBranchValue)
  const branchSearch = bs !== undefined ? bs.config : undefined
  const issueHintMode: BenchIssueHintMode = readKnobValue(state, "issue-hint", isIssueMode) ?? "off"
  const issueHintExpectedActual =
    readKnobValue(state, "issue-hint-expected-actual", isTrue) === true
  const repro = readKnobValue(state, "repro-test", isReproValue)
  const retryTransient = readKnobValue(state, "retry-transient", isNumber)
  const repairRounds = readKnobValue(state, "closure-repair", isNumber)
  const verifySelectN = readKnobValue(state, "verify-select", isNumber)
  // Default-TRUE fence: only an explicit `false` from the knob flips it OFF.
  // Unset / any non-false value ⇒ undefined ⇒ inLoopExec stays true (today's
  // exact behavior).
  const inLoopExec = readKnobValue(state, "bench-in-loop-exec", isFalse) !== false
  const liveOverrides: string[] = []
  if (readKnobValue(state, "read-outline", isTrue) === true)
    liveOverrides.push("QUANTA_READ_OUTLINE")
  if (readKnobValue(state, "test-runner", isTrue) === true) liveOverrides.push("QUANTA_TEST_RUNNER")
  if (readKnobValue(state, "repo-map", isRepoMapValue) !== undefined)
    liveOverrides.push("QUANTA_REPO_MAP")
  // Proof-driven bench closure (jun-17) — each true ONLY when its knob resolves
  // `true` (env / preset), else false. Default-OFF ⇒ byte-identical when unset.
  const faultEvidence = readKnobValue(state, "fault-evidence", isTrue) === true
  const verificationPlan = readKnobValue(state, "verification-plan", isTrue) === true
  const primaryRail = readKnobValue(state, "primary-rail", isTrue) === true
  const patchHygiene = readKnobValue(state, "patch-hygiene", isTrue) === true
  const patchBudget = readKnobValue(state, "patch-budget", isTrue) === true
  const reproVote = readKnobValue(state, "repro-vote", isTrue) === true
  const noPatchBreaker = readKnobValue(state, "no-patch-breaker", isTrue) === true
  const repairEscalation = readKnobValue(state, "repair-escalation", isTrue) === true
  const specFidelitySteer = readKnobValue(state, "spec-fidelity-steer", isTrue) === true
  const round0Minimal = readKnobValue(state, "round0-minimal", isTrue) === true
  const adversarialRepro = readKnobValue(state, "adversarial-repro", isTrue) === true
  return {
    lspNav,
    subagent,
    skills,
    localizePhase,
    branchSearch,
    issueHint: issueHintMode !== "off",
    issueHintMode,
    issueHintExpectedActual,
    reproTestK: repro !== undefined ? repro.samples : undefined,
    adversarialRepro,
    retryTransient,
    repairRounds,
    verifySelectN,
    inLoopExec,
    liveOverrides,
    preset: state.preset,
    sotaOn: state.preset === "agentless-v1",
    faultEvidence,
    verificationPlan,
    primaryRail,
    patchHygiene,
    patchBudget,
    reproVote,
    noPatchBreaker,
    repairEscalation,
    specFidelitySteer,
    round0Minimal,
  }
}


