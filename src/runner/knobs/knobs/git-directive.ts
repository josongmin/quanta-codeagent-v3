/**
 * Knob: `git-directive` — Codex `::git-*` directive emit (ADR-0234).
 *
 * Surface-activation for `AgentConfig.gitDirectiveEmit`. The loop ALREADY
 * consumes this field end-to-end: `buildGitDirectiveEmit(cfg)` (loop.ts) builds
 * a per-session `GitDirectiveCollector` when `cfg.gitDirectiveEmit.enabled ===
 * true`, the mutating git tools `record(...)` during their intermediate phase,
 * and the loop `flush()`es at the turn boundary (turn-closeout.ts). The ONLY
 * missing hop was that no live surface ever SET `cfg.gitDirectiveEmit`. This
 * knob closes that hop, mirroring the `closeout-guard` config-OBJECT knob.
 *
 * Domain (ACTIVE):
 *   - truthy ("1" / "on" / "true") ⇒ enable with the default `stdout` sink
 *     (the Codex protocol — UI consumers grep `^::git-` from agent stdout).
 *   - "stderr" ⇒ enable AND route the wire line to stderr.
 *
 * Domain (INACTIVE — `parse` returns `undefined`): absent / empty / any other
 * string. Fail to UNSET, NOT to a guessed sink (no heuristics).
 *
 * Default-OFF / byte-identical: when the env var does not resolve, `apply` is
 * never reached and the loop builds no collector (RFC §1.2).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { ApplyContext, Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]
const TRUTHY = new Set(["1", "on", "true"])

/** Parsed value carries the resolved sink. Only `stdout`/`stderr` are operator-
 *  selectable; the inline-function sink is a host-wired (AgentConfig) seam. */
export interface GitDirectiveValue {
  readonly sink: "stdout" | "stderr"
}

const parseGitDirective = (raw: string | undefined): GitDirectiveValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "stderr") return { sink: "stderr" }
  return TRUTHY.has(s.toLowerCase()) ? { sink: "stdout" } : undefined
}

const applyGitDirective = (
  cfg: AgentConfig,
  value: GitDirectiveValue,
  ctx: ApplyContext,
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return {
    ...cfg,
    gitDirectiveEmit: { enabled: true, sink: value.sink },
  }
}

export const gitDirectiveKnob: Knob<GitDirectiveValue> = {
  id: "git-directive",
  envKey: "QUANTA_GIT_DIRECTIVE_EMIT",
  category: "agent",
  surfaces: SURFACES,
  parse: parseGitDirective,
  apply: applyGitDirective,
  describe: "Codex ::git-* directive emit on successful git ops (stdout | stderr)",
  source: "ADR-0234 git-directive-emit",
}

registerKnob(gitDirectiveKnob)
