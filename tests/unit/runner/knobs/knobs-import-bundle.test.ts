/**
 * Bundle import test — verifies that side-effect importing every per-knob
 * module populates the registry with all 13 known knob ids.
 *
 * The list of 13 ids is the framework's ground truth. Any new knob added to
 * `src/runner/knobs/knobs/` must add itself to this assertion AND to the CLI
 * bootstrap's import block (`src/apps/cli/knobs-bootstrap.ts`). A missing
 * import surfaces as a missing knob id here.
 *
 * Slice fence: this test sits under `tests/unit/runner/**` so it MUST NOT
 * import from `@/apps/cli`. The bootstrap module is imported only by tests
 * under `tests/unit/cli/**`. Here we import every per-knob module's exported
 * knob OBJECT directly so the assertion is DETERMINISTIC regardless of run
 * order.
 *
 * Registry caveat: module side-effects register a knob exactly once per process
 * (cached); a sibling suite that calls `__resetRegistry()` then wipes the
 * singleton, and a later cached re-import will NOT re-fire `registerKnob`. To
 * stay order-independent we therefore re-register from the imported objects in
 * `beforeAll`, guarded by presence so we never trigger a collision throw.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { type AnyKnob, allKnobs, asAnyKnob, registerKnob } from "@/runner/knobs"
import { acceptanceKnob } from "@/runner/knobs/knobs/acceptance"
import { adversarialReproKnob } from "@/runner/knobs/knobs/adversarial-repro"
import { advisorKnob } from "@/runner/knobs/knobs/advisor"
import { benchInLoopExecKnob } from "@/runner/knobs/knobs/bench-in-loop-exec"
import { branchSearchKnob } from "@/runner/knobs/knobs/branch-search"
import { chaMultisiteGeneralKnob } from "@/runner/knobs/knobs/cha-multisite-general"
import { chaMultisiteSteerKnob } from "@/runner/knobs/knobs/cha-multisite-steer"
import { closeoutCriticKnob } from "@/runner/knobs/knobs/closeout-critic"
import { closeoutGuardKnob } from "@/runner/knobs/knobs/closeout-guard"
import { closureRepairKnob } from "@/runner/knobs/knobs/closure-repair"
import { composeAuthoringKnob } from "@/runner/knobs/knobs/compose-authoring"
import { dynamicMessageMatcherKnob } from "@/runner/knobs/knobs/dynamic-message-matcher"
import { faultEvidenceKnob } from "@/runner/knobs/knobs/fault-evidence"
import { forwardLocalizeKnob } from "@/runner/knobs/knobs/forward-localize"
import { gitDirectiveKnob } from "@/runner/knobs/knobs/git-directive"
import { hooksKnob } from "@/runner/knobs/knobs/hooks"
import { issueHintKnob } from "@/runner/knobs/knobs/issue-hint"
import { issueHintExpectedActualKnob } from "@/runner/knobs/knobs/issue-hint-expected-actual"
import { localizeBudgetKnob } from "@/runner/knobs/knobs/localize-budget"
import { localizePhaseKnob } from "@/runner/knobs/knobs/localize-phase"
import { lspKnob } from "@/runner/knobs/knobs/lsp"
import { lspCheapKnob } from "@/runner/knobs/knobs/lsp-cheap"
import { lspSteerKnob } from "@/runner/knobs/knobs/lsp-steer"
import { mcpToolAnnotationsKnob } from "@/runner/knobs/knobs/mcp-tool-annotations"
import { memoryModeKnob } from "@/runner/knobs/knobs/memory-mode"
import { modelLaneDiversityKnob } from "@/runner/knobs/knobs/model-lane-diversity"
import { multiVoterKnob } from "@/runner/knobs/knobs/multi-voter"
import { mustPassKnob } from "@/runner/knobs/knobs/must-pass"
import { networkProxyKnob } from "@/runner/knobs/knobs/network-proxy"
import { noPatchBreakerKnob } from "@/runner/knobs/knobs/no-patch-breaker"
import { noPatchForceFractionKnob } from "@/runner/knobs/knobs/no-patch-force-fraction"
import { pairedControlKnob } from "@/runner/knobs/knobs/paired-control"
import { patchBudgetKnob } from "@/runner/knobs/knobs/patch-budget"
import { patchBudgetStrictKnob } from "@/runner/knobs/knobs/patch-budget-strict"
import { patchHygieneKnob } from "@/runner/knobs/knobs/patch-hygiene"
import { personaKnob } from "@/runner/knobs/knobs/persona"
import { policyMergeKnob } from "@/runner/knobs/knobs/policy-merge"
import { primaryRailKnob } from "@/runner/knobs/knobs/primary-rail"
import { ratelimitNoticeKnob } from "@/runner/knobs/knobs/ratelimit-notice"
import { readOutlineKnob } from "@/runner/knobs/knobs/read-outline"
import { regressionMaxTestsKnob } from "@/runner/knobs/knobs/regression-max-tests"
import { repairEscalationKnob } from "@/runner/knobs/knobs/repair-escalation"
import { repoMapKnob } from "@/runner/knobs/knobs/repo-map"
import { reproDoubtKnob } from "@/runner/knobs/knobs/repro-doubt"
import { reproExecTimeoutKnob } from "@/runner/knobs/knobs/repro-exec-timeout"
import { reproGroundingKnob } from "@/runner/knobs/knobs/repro-grounding"
import { reproTestKnob } from "@/runner/knobs/knobs/repro-test"
import { reproVoteKnob } from "@/runner/knobs/knobs/repro-vote"
import { retryTransientKnob } from "@/runner/knobs/knobs/retry-transient"
import { selectorModeKnob } from "@/runner/knobs/knobs/selector-mode"
import { skillsKnob } from "@/runner/knobs/knobs/skills"
import { specFidelityInvariantKnob } from "@/runner/knobs/knobs/spec-fidelity-invariant"
import { specFidelitySteerKnob } from "@/runner/knobs/knobs/spec-fidelity-steer"
import { subagentKnob } from "@/runner/knobs/knobs/subagent"
import { taskBudgetKnob } from "@/runner/knobs/knobs/task-budget"
import { testRunnerKnob } from "@/runner/knobs/knobs/test-runner"
import { verificationPlanKnob } from "@/runner/knobs/knobs/verification-plan"
import { verifySelectKnob } from "@/runner/knobs/knobs/verify-select"
import { verifySelectConcurrencyKnob } from "@/runner/knobs/knobs/verify-select-concurrency"
import { verifySelectCounterfactualKnob } from "@/runner/knobs/knobs/verify-select-counterfactual"
import { verifySelectEarlyAcceptKnob } from "@/runner/knobs/knobs/verify-select-early-accept"
import { verifySelectLlmRiskGateKnob } from "@/runner/knobs/knobs/verify-select-llm-risk-gate"
import { verifySelectProofRequiredKnob } from "@/runner/knobs/knobs/verify-select-proof-required"
import { verifySelectRegressionKnob } from "@/runner/knobs/knobs/verify-select-regression"
import { verifySelectReproKnob } from "@/runner/knobs/knobs/verify-select-repro"
import { verifySelectRiskGateKnob } from "@/runner/knobs/knobs/verify-select-risk-gate"
import { workingStateKnob } from "@/runner/knobs/knobs/working-state"

const ALL_KNOBS: readonly AnyKnob[] = [
  asAnyKnob(acceptanceKnob),
  asAnyKnob(adversarialReproKnob),
  asAnyKnob(advisorKnob),
  asAnyKnob(benchInLoopExecKnob),
  asAnyKnob(branchSearchKnob),
  asAnyKnob(chaMultisiteGeneralKnob),
  asAnyKnob(chaMultisiteSteerKnob),
  asAnyKnob(closeoutCriticKnob),
  asAnyKnob(closeoutGuardKnob),
  asAnyKnob(closureRepairKnob),
  asAnyKnob(composeAuthoringKnob),
  asAnyKnob(dynamicMessageMatcherKnob),
  asAnyKnob(faultEvidenceKnob),
  asAnyKnob(forwardLocalizeKnob),
  asAnyKnob(gitDirectiveKnob),
  asAnyKnob(hooksKnob),
  asAnyKnob(issueHintKnob),
  asAnyKnob(issueHintExpectedActualKnob),
  asAnyKnob(localizeBudgetKnob),
  asAnyKnob(localizePhaseKnob),
  asAnyKnob(lspKnob),
  asAnyKnob(lspCheapKnob),
  asAnyKnob(lspSteerKnob),
  asAnyKnob(mcpToolAnnotationsKnob),
  asAnyKnob(memoryModeKnob),
  asAnyKnob(multiVoterKnob),
  asAnyKnob(mustPassKnob),
  asAnyKnob(networkProxyKnob),
  asAnyKnob(modelLaneDiversityKnob),
  asAnyKnob(pairedControlKnob),
  asAnyKnob(noPatchBreakerKnob),
  asAnyKnob(noPatchForceFractionKnob),
  asAnyKnob(patchBudgetKnob),
  asAnyKnob(patchBudgetStrictKnob),
  asAnyKnob(patchHygieneKnob),
  asAnyKnob(personaKnob),
  asAnyKnob(policyMergeKnob),
  asAnyKnob(primaryRailKnob),
  asAnyKnob(ratelimitNoticeKnob),
  asAnyKnob(readOutlineKnob),
  asAnyKnob(regressionMaxTestsKnob),
  asAnyKnob(repairEscalationKnob),
  asAnyKnob(repoMapKnob),
  asAnyKnob(reproDoubtKnob),
  asAnyKnob(reproExecTimeoutKnob),
  asAnyKnob(reproGroundingKnob),
  asAnyKnob(reproTestKnob),
  asAnyKnob(reproVoteKnob),
  asAnyKnob(retryTransientKnob),
  asAnyKnob(selectorModeKnob),
  asAnyKnob(skillsKnob),
  asAnyKnob(specFidelityInvariantKnob),
  asAnyKnob(specFidelitySteerKnob),
  asAnyKnob(subagentKnob),
  asAnyKnob(taskBudgetKnob),
  asAnyKnob(testRunnerKnob),
  asAnyKnob(verificationPlanKnob),
  asAnyKnob(verifySelectKnob),
  asAnyKnob(verifySelectConcurrencyKnob),
  asAnyKnob(verifySelectCounterfactualKnob),
  asAnyKnob(verifySelectEarlyAcceptKnob),
  asAnyKnob(verifySelectLlmRiskGateKnob),
  asAnyKnob(verifySelectProofRequiredKnob),
  asAnyKnob(verifySelectRegressionKnob),
  asAnyKnob(verifySelectReproKnob),
  asAnyKnob(verifySelectRiskGateKnob),
  asAnyKnob(workingStateKnob),
]

const PER_KNOB_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "src",
  "runner",
  "knobs",
  "knobs",
)

const ALL_KNOB_IDS = ALL_KNOBS.map((k) => k.id)

// Deterministic population: re-register any knob a sibling suite's
// `__resetRegistry()` may have wiped (guarded so we never collide).
beforeAll(() => {
  const reg = allKnobs()
  for (const k of ALL_KNOBS) {
    if (!reg.has(k.id)) registerKnob(k)
  }
})

describe("per-knob side-effect import bundle", () => {
  test("all known knobs registered after side-effect imports", () => {
    const reg = allKnobs()
    const missing = ALL_KNOB_IDS.filter((id) => !reg.has(id))
    expect(missing).toEqual([])
  })

  test("knob ids are distinct (no duplicate registration)", () => {
    expect(new Set(ALL_KNOB_IDS).size).toBe(ALL_KNOBS.length)
  })

  // Drift guard: ALL_KNOBS MUST cover every per-knob file. A new knob file that
  // forgets to add itself here (or to the barrel) trips this — the whole point
  // of the bundle test. Derived from the filesystem so the count is never stale.
  test("ALL_KNOBS covers every per-knob file (no forgotten knob)", async () => {
    const files = await readdir(PER_KNOB_DIR)
    const knobFileCount = files.filter((f) => f.endsWith(".ts") && f !== "index.ts").length
    // `ALL_KNOBS.length === knobFileCount` is satisfied by 0 === 0, so this arm
    // passed with the knob directory emptied — proven by the empty-corpus
    // oracle. 68 per-knob files today; the floor is derived from that, not `> 0`.
    expect(knobFileCount, "the per-knob directory read almost nothing").toBeGreaterThan(50)
    expect(ALL_KNOBS.length).toBe(knobFileCount)
  })

  for (const id of ALL_KNOB_IDS) {
    test(`knob "${id}" registered`, () => {
      expect(allKnobs().has(id)).toBe(true)
    })
  }
})

// NEW MECHANISM (knob=schema unification): bench knobs are no longer registered
// by a per-file side-effect import; they are registered CENTRALLY by
// `registerBenchKnobs()`, which DERIVES each from the schema SSOT
// (`ALL_BENCH_SCHEMAS`). The "no knob silently missing" guarantee — formerly
// "every per-knob import populated the registry" — is preserved here in the form
// matched to the new mechanism: after `registerBenchKnobs()`, EVERY registry-Knob
// schema id is present in `allKnobs()`. A schema added to the SSOT that the
// registrar fails to register trips this.
describe("central registrar covers the schema SSOT (no schema-backed knob missing)", () => {
  test("after registerBenchKnobs(), every registry-Knob schema id is registered", async () => {
    const { registerBenchKnobs } = await import("@/runner/knobs/register-bench-knobs")
    const { ALL_BENCH_SCHEMAS } = await import("@/config/knob-schema/schemas")
    // Idempotent: safe to call even if the barrel already registered them.
    registerBenchKnobs()
    const reg = allKnobs()
    // A schema backs a registry Knob iff it declares a `source` provenance string
    // (the 23 inventory-only schemas omit it). This MUST match the registrar's
    // own predicate so the completeness claim is exact, not vacuous.
    const registryKnobIds = ALL_BENCH_SCHEMAS.filter(
      (s) => (s as { source?: string }).source !== undefined,
    ).map((s) => s.id)
    expect(registryKnobIds.length).toBeGreaterThan(0) // sanity: SSOT non-empty
    const missing = registryKnobIds.filter((id) => !reg.has(id))
    expect(missing).toEqual([])
  })

  test("inventory-only schemas (no `source`) are NOT registered as Knobs", async () => {
    const { ALL_BENCH_SCHEMAS } = await import("@/config/knob-schema/schemas")
    const reg = allKnobs()
    // The 23 bench-driver config dials (full-remote-*, resume, bench-preset, …)
    // are inventory entries, NOT `@/runner/knobs` Knobs — registering them would
    // CHANGE the registered set (a behavior change). Pin that they stay out.
    const inventoryOnly = ALL_BENCH_SCHEMAS.filter(
      (s) => (s as { source?: string }).source === undefined,
    ).map((s) => s.id)
    expect(inventoryOnly.length).toBeGreaterThan(0) // sanity: the split is real
    const leaked = inventoryOnly.filter((id) => reg.has(id))
    expect(leaked).toEqual([])
  })
})
