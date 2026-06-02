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

import "./advisor"
import "./branch-search"
import "./closeout-guard"
import "./hooks"
import "./issue-hint"
import "./localize-phase"
import "./lsp"
import "./memory-mode"
import "./multi-voter"
import "./must-pass"
import "./persona"
import "./repro-test"
import "./skills"
import "./subagent"
import "./task-budget"
import "./working-state"
