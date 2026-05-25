/**
 * Knob: `persona` — Codex `{{ personality }}` slot wiring (ADR-0068).
 *
 * Routes a closed-enum persona kind into the system-prompt builder so the
 * agent's tonal register is selectable per session. Surface set EXCLUDES
 * `bench` on purpose: measurement integrity — persona text changes the prefix
 * cache key + can shift trajectory length, so SWE-bench-style runs MUST stay
 * on the empty `default` body. CLI / agent-batch / agent-interactive callers
 * opt in via `QUANTA_PERSONA={default|friendly|pragmatic}`.
 *
 * `parse` is a STRICT equality check against the closed enum — anything else
 * (uppercase, prefixes, garbage) returns `undefined` so the caller falls
 * through to the next layer instead of being silently coerced. No heuristics.
 *
 * `apply` rebuilds `cfg.system` from `buildSystemPrompt(cwd, { persona })`
 * (the existing seam in `src/agent/prompt.ts`). For `default` the rebuilt
 * prompt is byte-identical to the no-persona path (the personaLines helper
 * returns an empty array on `default`) — so a knob set to `default`
 * explicitly is still a no-op against the baseline. `hotToggleable: true`:
 * a host that swaps persona mid-session (slash-command, REPL `/persona`)
 * gets a freshly-built system on the next turn.
 */

import type { AgentConfig } from "@/agent"
import { buildSystemPrompt } from "@/agent"
import {type Knob, type Surface } from "../types"
import { registerKnob } from "../registry"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

/** Closed enum — mirrored from `src/agent/persona.ts#PersonaKind`. Kept local
 *  so this knob does not import the runtime-only `resolvePersona` (the knob
 *  is the resolver — env reads happen at the framework's `resolveKnobs`
 *  layer, not here). */
type PersonaKind = "default" | "friendly" | "pragmatic"

const VALID = new Set<PersonaKind>(["default", "friendly", "pragmatic"])

const parsePersona = (raw: string | undefined): PersonaKind | undefined => {
  if (raw === undefined) return undefined
  // Strict equality — no case folding, no trimming. The framework's surface
  // entry is responsible for raw passthrough; ambiguous input falls through.
  return VALID.has(raw as PersonaKind) ? (raw as PersonaKind) : undefined
}

const applyPersona = (
  cfg: AgentConfig,
  value: PersonaKind,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  // Rebuild the system prompt with the persona slot filled. `cfg.cwd` is the
  // already-resolved sandbox / repo root; passing it through preserves the
  // legacy `buildSystemPrompt(cwd)` signature. For `default` the helper's
  // personaLines() returns [] so the rebuilt string is byte-identical to a
  // no-persona build — sanity-checked under the `persona=default ⇒ no-op`
  // case in tests.
  return { ...cfg, system: buildSystemPrompt(cfg.cwd, { persona: value }) }
}

export const personaKnob: Knob<PersonaKind> = {
  id: "persona",
  envKey: "QUANTA_PERSONA",
  category: "hint",
  surfaces: SURFACES,
  parse: parsePersona,
  apply: applyPersona,
  describe: "System prompt persona (default | friendly | pragmatic)",
  source: "ADR-0068",
  hotToggleable: true,
}

registerKnob(personaKnob)
