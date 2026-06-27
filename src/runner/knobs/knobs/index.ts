/**
 * Knob registration barrel — populates the registry singleton.
 *
 * TWO registration mechanisms, ONE entry point:
 *   1. BENCH knobs (the 52 schema-backed `@/runner/knobs` Knobs) are registered
 *      CENTRALLY by `registerBenchKnobs()`, which DERIVES each from the schema
 *      SSOT (`ALL_BENCH_SCHEMAS`). No per-knob hand-import list (the drift this
 *      unification removes). The thin per-knob files no longer self-register.
 *   2. NON-bench / cross-surface knobs (advisor, persona, network-proxy, …) that
 *      are NOT in the bench schema SSOT still self-register via their module-level
 *      `registerKnob(...)`; the side-effect imports below fire that exactly once.
 *
 * Surface entries that drive bench / matrix / CLI MUST import this barrel before
 * calling `resolveKnobs` / `knobsForSurface`. `registerBenchKnobs()` and the
 * self-registering modules are both idempotent under the registry collision guard
 * (presence-checked), so a sibling `__resetRegistry()` + cached re-import is safe.
 */

import { registerBenchKnobs } from "../register-bench-knobs"

// Schema-backed BENCH knobs — registered centrally (derived from the SSOT).
registerBenchKnobs()

// Non-schema, cross-surface knobs — self-register via side-effect import.
import "./advisor"
import "./closeout-critic"
import "./compose-authoring"
import "./git-directive"
import "./mcp-tool-annotations"
import "./memory-mode"
import "./network-proxy"
import "./persona"
import "./policy-merge"
import "./ratelimit-notice"
import "./read-outline"
import "./task-budget"
import "./test-runner"
