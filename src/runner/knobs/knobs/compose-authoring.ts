/**
 * Knob: `compose-authoring` — diff→prose AUTHORING tools (ADR-0016 compose
 * seam; Codex `yeet` / Cursor compose).
 *
 * Env-flips `git_compose_commit` + `git_compose_pr` from ABSENT to LIVE. When
 * `QUANTA_COMPOSE_AUTHORING=1`, `apply` folds the session's BASELINE
 * `AgentConfig.llm` (always present) into `config.composeAuthoring.authorLLM`,
 * so the tier-1 features assembly (`buildComposeAuthoringBlock`) registers the
 * two READ-ONLY authoring tools. Absent / any-other value ⇒ `parse` returns
 * `undefined`, `config.composeAuthoring` stays unset, and the ToolRegistry is
 * byte-identical (RFC §1.2 default-OFF — proven in the compose hellgate).
 *
 * The authoring mechanism is built PURELY from `cfg.llm`: the two tools hand
 * the staged / branch diff to a ONE-SHOT `LLMPort` completion and return the
 * authored text — they never commit or open a PR (the model feeds the result
 * into the existing mutating `git_commit` / `gh_pr_create`, so the HITL gate
 * still governs the actual mutation). This mirrors the `advisor` knob's posture
 * of folding `cfg.llm` into a config slot — a PURE fold, never an env / fs read
 * here. The usual pick is a cheap model, but the baseline LLM is the safe
 * default the operator already has wired.
 *
 * NO HEURISTICS: `parse` is a STRICT equality test against the single literal
 * `"1"`. Anything else (typos, "0", "true", "on", case variants, garbage,
 * empty, whitespace) returns `undefined` so the caller falls through to the
 * next layer rather than being silently coerced. No range, no threshold.
 *
 * Surfaces: cli + agent-batch + agent-interactive. EXCLUDES `bench` — an extra
 * authoring tool in the registry changes the offered-tool set + the
 * prefix-cache key, so SWE-bench-style measurement stays on the no-compose
 * path.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

/** The ENABLE literal — the ONLY raw value that activates the knob. */
const ENABLE = "1"

/** Marker value: the knob carries no data of its own (the author LLM is the
 *  session baseline `cfg.llm`, read in `apply`). `true` ⇒ active. */
type ComposeAuthoringValue = true

/** STRICT equality test — no trimming, no case folding, no truthiness coercion.
 *  Only the exact literal `"1"` activates; everything else falls through. */
const parseComposeAuthoring = (raw: string | undefined): ComposeAuthoringValue | undefined => {
  if (raw === undefined) return undefined
  if (raw !== ENABLE) return undefined
  return true
}

/**
 * Fold the active flag into `config.composeAuthoring`. PURE: closes over the
 * baseline `cfg.llm` (always present) as the author LLM, never reading env / fs
 * here. The tier-1 `buildComposeAuthoringBlock` reads this slot and registers
 * the two authoring tools.
 */
const applyComposeAuthoring = (
  cfg: AgentConfig,
  _value: ComposeAuthoringValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, composeAuthoring: { authorLLM: cfg.llm } }
}

export const composeAuthoringKnob: Knob<ComposeAuthoringValue> = {
  id: "compose-authoring",
  envKey: "QUANTA_COMPOSE_AUTHORING",
  category: "tool",
  surfaces: SURFACES,
  parse: parseComposeAuthoring,
  apply: applyComposeAuthoring,
  describe:
    "Diff→prose authoring tools (git_compose_commit / git_compose_pr; uses the baseline LLM)",
  source: "ADR-0016 (compose seam)",
}

registerKnob(composeAuthoringKnob)
