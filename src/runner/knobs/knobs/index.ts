/**
 * Side-effect bundle import — registers all bench/agent knobs into the
 * registry via their module-level `registerKnob(...)` calls.
 *
 * Surface entries that drive the bench / matrix / CLI MUST import this
 * barrel BEFORE calling `resolveKnobs` / `knobsForSurface` so the registry
 * is populated. Tests that need a clean registry can call `__resetRegistry`
 * and then re-import this module (Bun caches it once per process, so the
 * side-effect fires exactly once unless explicitly reset).
 *
 * The matrix tool's `bootstrapBenchKnobs` is the runtime fallback for cases
 * where the registry has been reset mid-process (e.g. test isolation); the
 * production import path goes through this barrel.
 */

import "./adversarial-repro"
import "./advisor"
import "./bench-in-loop-exec"
import "./branch-search"
import "./closeout-critic"
import "./closeout-guard"
import "./closure-repair"
import "./compose-authoring"
import "./fault-evidence"
import "./git-directive"
import "./hooks"
import "./issue-hint"
import "./issue-hint-expected-actual"
import "./localize-phase"
import "./lsp"
import "./repro-doubt"
import "./lsp-steer"
import "./mcp-tool-annotations"
import "./memory-mode"
import "./multi-voter"
import "./must-pass"
import "./network-proxy"
import "./no-patch-breaker"
import "./patch-budget"
import "./patch-budget-strict"
import "./patch-hygiene"
import "./persona"
import "./policy-merge"
import "./primary-rail"
import "./ratelimit-notice"
import "./rca-target-gates"
import "./read-outline"
import "./repair-escalation"
import "./repo-map"
import "./repro-test"
import "./repro-vote"
import "./retry-transient"
import "./round0-minimal"
import "./selector-mode"
import "./spec-fidelity-steer"
import "./verification-plan"
import "./skills"
import "./subagent"
import "./task-budget"
import "./test-runner"
import "./verify-select"
import "./verify-select-concurrency"
import "./verify-select-counterfactual"
import "./verify-select-early-accept"
import "./verify-select-llm-risk-gate"
import "./verify-select-proof-required"
import "./verify-select-regression"
import "./verify-select-repro"
import "./verify-select-risk-gate"
import "./working-state"
