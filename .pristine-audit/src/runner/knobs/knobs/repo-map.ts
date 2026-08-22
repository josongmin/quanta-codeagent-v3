/**
 * Knob: `repo-map` — bounded repo-map turn-0 injection (RFC jun-6 §4).
 *
 * Codex 0.135 prepends a bounded directory tree at session start so the model is
 * oriented without spending the first 1-2 tool calls on `file_tree_summary` /
 * `ls`. quanta already injects a `## Environment` block (`env-context.ts`,
 * ADR-0397) and already has a bounded, ignore-respecting tree renderer
 * (`file_tree_summary`). This knob flips the turn-1 repo-map injection ON: when
 * `QUANTA_REPO_MAP` is set, `apply` populates `config.repoMap` (the caps slot the
 * loop reads to call `probeRepoMap` on turn 1 only). Absent ⇒ `config.repoMap`
 * stays unset, the probe never runs, and `renderEnvBlock` is BYTE-IDENTICAL to
 * today (default-OFF — proven by the repo-map byte-identity hellgate).
 *
 * Three caps (RFC §4.4), all deliberately TIGHTER than the `file_tree_summary`
 * tool defaults (turn-0 orientation is a cheaper-must-be one-time payment):
 *   - depth 2 (vs tool 3), file-count 200 (vs tool 400), char-backstop 6000.
 * The caps are the fixed RFC defaults (shared from `@/agent`'s
 * `REPO_MAP_DEFAULT_*`). Per-cap env overrides are a documented follow-up (they
 * would need `ApplyContext` to carry the env snapshot, which it does not today).
 *
 * Surfaces: cli + agent-batch + agent-interactive + bench. The bench surface
 * activates ONLY when QUANTA_REPO_MAP is explicitly set (same gate as other
 * surfaces) — the knob is still default-OFF; the previous exclusion was
 * over-restrictive. Turn-0 orientation reduces wasted nav turns on SWE-bench.
 */

import type { AgentConfig } from "@/agent"
import {
  REPO_MAP_DEFAULT_MAX_CHARS,
  REPO_MAP_DEFAULT_MAX_DEPTH,
  REPO_MAP_DEFAULT_MAX_FILES,
} from "@/agent"
import { repoMapSchema } from "@/config/knob-schema/schemas/bench-loop"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { ApplyContext, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive", "bench"]

interface RepoMapValue {
  readonly enabled: true
}

/** Non-NOOP apply — folds `cfg.repoMap` (turn-0 injection). Bound into the central
 *  registrar (`APPLY_BINDINGS`) AND used to derive the back-compat knob export;
 *  ONE definition so the derived knob is byte-identical to the registered one. */
export const applyRepoMap = (
  cfg: AgentConfig,
  _value: RepoMapValue,
  ctx: ApplyContext,
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return {
    ...cfg,
    repoMap: {
      maxDepth: REPO_MAP_DEFAULT_MAX_DEPTH,
      maxFiles: REPO_MAP_DEFAULT_MAX_FILES,
      maxChars: REPO_MAP_DEFAULT_MAX_CHARS,
    },
  }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const repoMapKnob = deriveKnob(repoMapSchema, applyRepoMap)
