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
 * Surfaces: cli + agent-batch + agent-interactive. EXCLUDES `bench` — a turn-0
 * tree changes the prefix-cache key + trajectory, so SWE-bench-style measurement
 * stays on the no-map path.
 */

import type { AgentConfig } from "@/agent"
import {
  REPO_MAP_DEFAULT_MAX_CHARS,
  REPO_MAP_DEFAULT_MAX_DEPTH,
  REPO_MAP_DEFAULT_MAX_FILES,
} from "@/agent"
import { registerKnob } from "../registry"
import type { ApplyContext, Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

/** Enable-only boolean parse — `1`/`true`/`on` enable; anything else ⇒ inactive
 *  (byte-identical default-OFF). */
const ENABLING = new Set(["1", "true", "on"])

interface RepoMapValue {
  readonly enabled: true
}

const parseRepoMap = (raw: string | undefined): RepoMapValue | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? { enabled: true } : undefined
}

const applyRepoMap = (cfg: AgentConfig, _value: RepoMapValue, ctx: ApplyContext): AgentConfig => {
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

export const repoMapKnob: Knob<RepoMapValue> = {
  id: "repo-map",
  envKey: "QUANTA_REPO_MAP",
  category: "hint",
  surfaces: SURFACES,
  parse: parseRepoMap,
  apply: applyRepoMap,
  describe: "Inject a bounded repo-map tree into the turn-0 env block (one-time orientation)",
  // One-time turn-0 cost: a single bounded scan + a few hundred tokens once.
  costMultiplier: 1,
  source: "RFC jun-6 §4 / Codex realtime-startup-context mirror",
}

registerKnob(repoMapKnob)
